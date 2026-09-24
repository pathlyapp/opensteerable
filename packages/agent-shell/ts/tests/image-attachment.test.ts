import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeTargetSize,
  isImagePath,
  parseImageAttachments,
  processImageAttachments,
  processViewImage,
  IMAGE_MAX_ENCODED_BYTES,
  IMAGE_MAX_SOURCE_BYTES,
} from '../src/image-attachment.js';
import type { NativeImageInstance, NativeImageLike } from '../src/runtime.js';

function fakeNativeImage(
  width: number,
  height: number,
  options: {
    crops?: unknown[];
    resizes?: unknown[];
    png?: Buffer;
    jpeg?: Buffer;
    empty?: boolean;
  } = {},
): NativeImageInstance {
  return {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width, height }),
    crop: (rect) => {
      options.crops?.push(rect);
      return fakeNativeImage(rect.width, rect.height, options);
    },
    resize: (resizeOptions) => {
      options.resizes?.push(resizeOptions);
      return fakeNativeImage(
        resizeOptions.width ?? width,
        resizeOptions.height ?? height,
        options,
      );
    },
    toPNG: () => options.png ?? Buffer.from('png'),
    toJPEG: () => options.jpeg ?? Buffer.from('jpeg'),
  };
}

function withImageFile(run: (imagePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'view-image-'));
  try {
    const imagePath = join(dir, 'slide.png');
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    run(imagePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('isImagePath', () => {
  it('按扩展名识别图片（大小写不敏感）', () => {
    expect(isImagePath('/a/b.png')).toBe(true);
    expect(isImagePath('/a/b.JPG')).toBe(true);
    expect(isImagePath('/a/b.jpeg')).toBe(true);
    expect(isImagePath('/a/b.webp')).toBe(true);
  });

  it('非图片扩展名返回 false', () => {
    expect(isImagePath('/a/b.txt')).toBe(false);
    expect(isImagePath('/a/b.ts')).toBe(false);
    expect(isImagePath('/a/noext')).toBe(false);
  });
});

describe('computeTargetSize', () => {
  it('未超限保持原尺寸', () => {
    expect(computeTargetSize(800, 600)).toEqual({ width: 800, height: 600, resized: false });
  });

  it('按长边等比缩小（宽图）', () => {
    const r = computeTargetSize(3136, 1568, 1568);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(1568);
    expect(r.height).toBe(784);
  });

  it('按长边等比缩小（高图）', () => {
    const r = computeTargetSize(1000, 4000, 2000);
    expect(r.resized).toBe(true);
    expect(r.height).toBe(2000);
    expect(r.width).toBe(500);
  });

  it('从不上采样', () => {
    expect(computeTargetSize(100, 100, 1568).resized).toBe(false);
  });

  it('非法尺寸返回 0', () => {
    expect(computeTargetSize(0, 100)).toEqual({ width: 0, height: 0, resized: false });
  });
});

describe('parseImageAttachments', () => {
  it('非数组返回空', () => {
    expect(parseImageAttachments(undefined)).toEqual([]);
    expect(parseImageAttachments('x')).toEqual([]);
    expect(parseImageAttachments(null)).toEqual([]);
  });

  it('过滤掉缺 path / 非字符串 path / 非图片扩展', () => {
    const out = parseImageAttachments([
      { path: '/a/ok.png', name: 'ok.png' },
      { path: '/a/skip.txt' },
      { name: 'no-path.png' },
      { path: 123 },
      'not-an-object',
      { path: '/a/ok2.jpg' },
    ]);
    expect(out).toEqual([
      { path: '/a/ok.png', name: 'ok.png' },
      { path: '/a/ok2.jpg', name: undefined },
    ]);
  });
});

describe('processImageAttachments（非 Electron 宿主）', () => {
  it('文件不存在 → 记入说明，不产出图片', () => {
    const r = processImageAttachments([{ path: '/definitely/not/here.png', name: 'here.png' }]);
    expect(r.images).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('here.png');
    expect(r.notes[0]).toContain('不存在');
  });

  it('源文件超过字节上限 → 拒绝并说明', () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-attach-'));
    try {
      const big = join(dir, 'big.png');
      writeFileSync(big, Buffer.alloc(IMAGE_MAX_SOURCE_BYTES + 1, 0));
      const r = processImageAttachments([{ path: big, name: 'big.png' }]);
      expect(r.images).toEqual([]);
      expect(r.notes[0]).toContain('超过');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法图片路径在无解码器环境下 → 说明而非崩溃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-attach-'));
    try {
      const p = join(dir, 'ok.png');
      writeFileSync(p, Buffer.from([137, 80, 78, 71])); // PNG magic, 内容无所谓
      const r = processImageAttachments([{ path: p, name: 'ok.png' }]);
      // vitest 里没有 nativeImage，应走「不支持图片解码」分支
      expect(r.images).toEqual([]);
      expect(r.notes[0]).toContain('ok.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processViewImage', () => {
  it('裁剪、缩放并把像素作为 _image 内容块返回', () => {
    withImageFile((imagePath) => {
      const crops: unknown[] = [];
      const resizes: unknown[] = [];
      const decoder: NativeImageLike = {
        createFromPath: () => fakeNativeImage(2000, 1000, { crops, resizes }),
      };

      const result = processViewImage(
        {
          path: imagePath,
          region: { x: 0.25, y: 0, w: 0.5, h: 1 },
          maxEdge: 500,
          format: 'jpeg',
        },
        decoder,
      );

      expect(crops).toEqual([{ x: 500, y: 0, width: 1000, height: 1000 }]);
      expect(resizes).toEqual([{ width: 500, height: 500, quality: 'good' }]);
      expect(result).toEqual({
        success: true,
        data: {
          width: 500,
          height: 500,
          sourcePath: imagePath,
          mediaType: 'image/jpeg',
          _image: {
            b64: Buffer.from('jpeg').toString('base64'),
            media_type: 'image/jpeg',
          },
        },
      });
    });
  });

  it('拒绝越界裁剪', () => {
    withImageFile((imagePath) => {
      const image = fakeNativeImage(100, 100);
      const result = processViewImage(
        { path: imagePath, region: { x: 80, y: 0, w: 30, h: 10 } },
        { createFromPath: () => image },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('超出图片范围');
    });
  });

  it('像素裁剪不与 0–1 比例裁剪混淆', () => {
    withImageFile((imagePath) => {
      const crops: unknown[] = [];
      const result = processViewImage(
        { path: imagePath, region: { x: 2, y: 3, w: 10, h: 20 } },
        { createFromPath: () => fakeNativeImage(100, 100, { crops }) },
      );
      expect(result.success).toBe(true);
      expect(crops).toEqual([{ x: 2, y: 3, width: 10, height: 20 }]);
      expect(result.data).toMatchObject({ width: 10, height: 20 });
    });
  });

  it('PNG 超过编码上限时自动回退 JPEG；显式 PNG 则给出可恢复错误', () => {
    withImageFile((imagePath) => {
      const decoder = {
        createFromPath: () =>
          fakeNativeImage(100, 100, {
            png: Buffer.alloc(IMAGE_MAX_ENCODED_BYTES + 1),
            jpeg: Buffer.from('small-jpeg'),
          }),
      };
      const fallback = processViewImage({ path: imagePath }, decoder);
      expect(fallback.success).toBe(true);
      expect(fallback.data?.mediaType).toBe('image/jpeg');

      const explicitPng = processViewImage({ path: imagePath, format: 'png' }, decoder);
      expect(explicitPng.success).toBe(false);
      expect(explicitPng.needsFollowup).toBe(true);
      expect(explicitPng.error).toContain('maxEdge');
    });
  });

  it.each([0, 4097, 1.5])('拒绝非法 maxEdge=%s', (maxEdge) => {
    withImageFile((imagePath) => {
      const result = processViewImage(
        { path: imagePath, maxEdge },
        { createFromPath: () => fakeNativeImage(100, 100) },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('maxEdge');
    });
  });

  it('拒绝非图片扩展、缺失文件、空图片和无解码器环境', () => {
    const decoder = { createFromPath: () => fakeNativeImage(10, 10) };
    expect(processViewImage({ path: '/tmp/a.txt' }, decoder).error).toContain('supports');
    expect(processViewImage({ path: '/definitely/missing.png' }, decoder).error).toContain(
      '不存在',
    );
    withImageFile((imagePath) => {
      expect(processViewImage({ path: imagePath }, null).error).toContain('不支持图片解码');
      expect(
        processViewImage(
          { path: imagePath },
          { createFromPath: () => fakeNativeImage(10, 10, { empty: true }) },
        ).error,
      ).toContain('可识别');
    });
  });
});
