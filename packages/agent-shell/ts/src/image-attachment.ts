/**
 * W6-3: turn an attached image file into a base64 `LlmImage` the model can
 * actually see, replacing the old behavior of dropping only the file *path*
 * into the prompt text.
 *
 * Runs in the Electron main process and uses `nativeImage` to decode /
 * downscale — no native dependency, works in the packaged app. Two caps are
 * enforced before the image ever reaches the model:
 *
 *   - source bytes  (`IMAGE_MAX_SOURCE_BYTES`) — refuse to read huge files;
 *   - long-edge px  (`IMAGE_MAX_DIMENSION`)    — downscale so the provider's
 *     vision input limit and our token budget aren't blown by a 4K screenshot;
 *   - encoded bytes (`IMAGE_MAX_ENCODED_BYTES`) — re-encode PNG->JPEG and
 *     finally refuse if still too large.
 *
 * Every decision (attached / resized / skipped + why) is returned as a note
 * line so the caller can inject it into the model-visible context — the model
 * should know an image was attached even when it was too large to send.
 */
import { getNativeImage } from './runtime.js';
import type { NativeImageLike } from './runtime.js';
import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import type { LlmImage } from './llm/types.js';

/** Refuse to read source files larger than this (10 MB). */
export const IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** Downscale so the long edge is at most this many px (matches common vision limits). */
export const IMAGE_MAX_DIMENSION = 1568;
/** Refuse the encoded payload if it still exceeds this after re-encode (5 MB). */
export const IMAGE_MAX_ENCODED_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface ImageAttachmentInput {
  path: string;
  name?: string;
}

export interface ProcessedImageAttachments {
  images: LlmImage[];
  /** One line per input describing the outcome, for the model-visible note. */
  notes: string[];
}

export interface ImageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewImageInput {
  path: string;
  region?: ImageRegion;
  maxEdge?: number;
  format?: 'png' | 'jpeg';
}

export interface ViewImageResult {
  success: boolean;
  data?: {
    width: number;
    height: number;
    sourcePath: string;
    mediaType: 'image/png' | 'image/jpeg';
    _image: { b64: string; media_type: 'image/png' | 'image/jpeg' };
  };
  error?: string;
  needsFollowup?: boolean;
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Validate the wire value (`metadata.images` from the renderer) into a clean
 * input list. Anything that isn't an object with a non-empty string `path`
 * is dropped; non-image extensions are dropped here too so a renamed file
 * can't smuggle arbitrary bytes into the decoder.
 */
export function parseImageAttachments(value: unknown): ImageAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  const out: ImageAttachmentInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const path = (item as Record<string, unknown>).path;
    if (typeof path !== 'string' || !path.trim() || !isImagePath(path)) continue;
    const name = (item as Record<string, unknown>).name;
    out.push({ path, name: typeof name === 'string' ? name : undefined });
  }
  return out;
}

/**
 * Pure resize decision, exported for tests: given source dimensions, return
 * the target dimensions honoring `IMAGE_MAX_DIMENSION` (aspect preserved,
 * never upscale, never below 1px).
 */
export function computeTargetSize(
  width: number,
  height: number,
  maxDimension: number = IMAGE_MAX_DIMENSION,
): { width: number; height: number; resized: boolean } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, resized: false };
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height, resized: false };
  }
  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/**
 * Decode, optionally crop, resize, and encode one image for a model-visible
 * tool result. `_image` is consumed by the CoreLoop as an image content part;
 * it is not a path or model-visible base64 string.
 */
export function processViewImage(
  input: ViewImageInput,
  nativeImage: NativeImageLike | null = getNativeImage(),
): ViewImageResult {
  if (!isImagePath(input.path)) {
    return {
      success: false,
      error: 'view_image supports PNG, JPEG, and WebP files',
      needsFollowup: true,
    };
  }

  let sourceBytes: number;
  try {
    sourceBytes = statSync(input.path).size;
  } catch {
    return { success: false, error: '图片不存在或不可读', needsFollowup: true };
  }
  if (sourceBytes > IMAGE_MAX_SOURCE_BYTES) {
    return {
      success: false,
      error: `源文件 ${formatMb(sourceBytes)}MB 超过 ${formatMb(IMAGE_MAX_SOURCE_BYTES)}MB 上限`,
      needsFollowup: true,
    };
  }

  const maxEdge = input.maxEdge ?? IMAGE_MAX_DIMENSION;
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) {
    return {
      success: false,
      error: 'maxEdge 必须是 1–4096 的整数',
      needsFollowup: true,
    };
  }

  if (!nativeImage) {
    return viewImageWithoutDecoder(input, sourceBytes, maxEdge);
  }

  let rendered = nativeImage.createFromPath(input.path);
  if (rendered.isEmpty()) {
    return { success: false, error: '不是可识别的图片', needsFollowup: true };
  }

  if (input.region) {
    const crop = resolveCrop(input.region, rendered.getSize());
    if ('error' in crop) {
      return { success: false, error: crop.error, needsFollowup: true };
    }
    rendered = rendered.crop(crop);
  }

  const croppedSize = rendered.getSize();
  const target = computeTargetSize(croppedSize.width, croppedSize.height, maxEdge);
  if (target.resized) {
    rendered = rendered.resize({
      width: target.width,
      height: target.height,
      quality: 'good',
    });
  }

  const sourceExt = extname(input.path).toLowerCase();
  const outputFormat = input.format ?? (['.jpg', '.jpeg'].includes(sourceExt) ? 'jpeg' : 'png');
  let mediaType: 'image/png' | 'image/jpeg' =
    outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  let buffer = outputFormat === 'jpeg' ? rendered.toJPEG(85) : rendered.toPNG();
  if (buffer.length > IMAGE_MAX_ENCODED_BYTES && input.format == null && outputFormat === 'png') {
    mediaType = 'image/jpeg';
    buffer = rendered.toJPEG(80);
  }
  if (buffer.length > IMAGE_MAX_ENCODED_BYTES) {
    return {
      success: false,
      error: `图片编码后 ${formatMb(buffer.length)}MB 超过 ${formatMb(IMAGE_MAX_ENCODED_BYTES)}MB 上限；请减小 maxEdge 或使用 jpeg`,
      needsFollowup: true,
    };
  }

  const { width, height } = rendered.getSize();
  const b64 = buffer.toString('base64');
  return {
    success: true,
    data: {
      width,
      height,
      sourcePath: input.path,
      mediaType,
      _image: { b64, media_type: mediaType },
    },
  };
}

function viewImageWithoutDecoder(
  input: ViewImageInput,
  sourceBytes: number,
  maxEdge: number,
): ViewImageResult {
  if (input.region) {
    return {
      success: false,
      error: '当前环境不能裁剪图片',
      needsFollowup: true,
    };
  }
  if (sourceBytes > IMAGE_MAX_ENCODED_BYTES) {
    return {
      success: false,
      error: `源文件 ${formatMb(sourceBytes)}MB 超过 ${formatMb(IMAGE_MAX_ENCODED_BYTES)}MB，当前环境不能缩放`,
      needsFollowup: true,
    };
  }
  const sourceExt = extname(input.path).toLowerCase();
  if (sourceExt !== '.png' && sourceExt !== '.jpg' && sourceExt !== '.jpeg') {
    return {
      success: false,
      error: '当前环境只能直接发送 PNG 和 JPEG',
      needsFollowup: true,
    };
  }
  const natural = sourceExt === '.png' ? 'png' : 'jpeg';
  if (input.format != null && input.format !== natural) {
    return {
      success: false,
      error: '当前环境不能转码',
      needsFollowup: true,
    };
  }
  const bytes = readFileSync(input.path);
  const size = readRasterSize(bytes);
  if (size && (size.width > maxEdge || size.height > maxEdge)) {
    return {
      success: false,
      error: '当前环境不能缩放',
      needsFollowup: true,
    };
  }
  const mediaType: 'image/png' | 'image/jpeg' =
    natural === 'jpeg' ? 'image/jpeg' : 'image/png';
  return {
    success: true,
    data: {
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      sourcePath: input.path,
      mediaType,
      _image: { b64: bytes.toString('base64'), media_type: mediaType },
    },
  };
}

function readRasterSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes.toString('ascii', 1, 4) === 'PNG'
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function resolveCrop(
  region: ImageRegion,
  size: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | { error: string } {
  const values = [region.x, region.y, region.w, region.h];
  if (!values.every(Number.isFinite)) return { error: 'region 的 x/y/w/h 必须是有限数字' };

  const normalized = values.every((value) => value >= 0 && value <= 1);
  const x = normalized ? Math.floor(region.x * size.width) : Math.round(region.x);
  const y = normalized ? Math.floor(region.y * size.height) : Math.round(region.y);
  const width = normalized ? Math.ceil(region.w * size.width) : Math.round(region.w);
  const height = normalized ? Math.ceil(region.h * size.height) : Math.round(region.h);
  if (
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > size.width ||
    y + height > size.height
  ) {
    return {
      error: `region 超出图片范围 ${size.width}×${size.height}`,
    };
  }
  return { x, y, width, height };
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

/**
 * Process a batch of image attachments. Synchronous: `nativeImage` decode /
 * resize / encode are all synchronous, and the byte check uses `statSync`.
 */
export function processImageAttachments(
  files: ImageAttachmentInput[],
): ProcessedImageAttachments {
  const images: LlmImage[] = [];
  const notes: string[] = [];

  for (const file of files) {
    const label = file.name || basename(file.path);

    // Existence + source-size guards run before the decoder so they're
    // exercisable in a non-Electron (test) host too.
    let sourceBytes = 0;
    try {
      sourceBytes = statSync(file.path).size;
    } catch {
      notes.push(`- ${label}：文件不存在或不可读，未附加`);
      continue;
    }
    if (sourceBytes > IMAGE_MAX_SOURCE_BYTES) {
      notes.push(`- ${label}：源文件 ${formatMb(sourceBytes)}MB 超过 ${formatMb(IMAGE_MAX_SOURCE_BYTES)}MB 上限，未附加`);
      continue;
    }

    const nativeImage = getNativeImage();
    if (!nativeImage) {
      // Tauri and the browser server run plain Node, which has no Electron
      // nativeImage. The bytes are already a PNG/JPEG the provider can read;
      // pass them through when they fit the encoded cap. Resize stays on the
      // Electron path.
      if (sourceBytes > IMAGE_MAX_ENCODED_BYTES) {
        notes.push(`- ${label}：源文件 ${formatMb(sourceBytes)}MB 超过 ${formatMb(IMAGE_MAX_ENCODED_BYTES)}MB，当前环境不能缩放，未附加`);
        continue;
      }
      const ext = extname(file.path).toLowerCase();
      const mediaType =
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : ext === '.bmp' ? 'image/bmp'
        : 'image/png';
      images.push({
        data: readFileSync(file.path).toString('base64'),
        mediaType,
      });
      notes.push(`- ${label}（原图）`);
      continue;
    }

    const image = nativeImage.createFromPath(file.path);
    if (image.isEmpty()) {
      notes.push(`- ${label}：不是可识别的图片，未附加`);
      continue;
    }

    const { width, height } = image.getSize();
    const target = computeTargetSize(width, height);
    const rendered = target.resized
      ? image.resize({ width: target.width, height: target.height, quality: 'good' })
      : image;

    // PNG for graphics/screenshots (lossless), JPEG for photos (smaller).
    const preferJpeg = ['.jpg', '.jpeg'].includes(extname(file.path).toLowerCase());
    let mediaType = preferJpeg ? 'image/jpeg' : 'image/png';
    let buffer = preferJpeg ? rendered.toJPEG(85) : rendered.toPNG();
    if (buffer.length > IMAGE_MAX_ENCODED_BYTES && mediaType !== 'image/jpeg') {
      mediaType = 'image/jpeg';
      buffer = rendered.toJPEG(80);
    }
    if (buffer.length > IMAGE_MAX_ENCODED_BYTES) {
      notes.push(`- ${label}：压缩后仍超过 ${formatMb(IMAGE_MAX_ENCODED_BYTES)}MB，未附加`);
      continue;
    }

    images.push({ data: buffer.toString('base64'), mediaType });
    const sizeText = target.resized
      ? `${width}×${height}，已缩放至 ${target.width}×${target.height}`
      : `${width}×${height}`;
    notes.push(`- ${label}（${sizeText}）`);
  }

  return { images, notes };
}
