/**
 * 回合结束后生成「下一轮用户输入」建议。
 *
 * 主路径只走一次短 LLM 调用。判断来源只有助手给用户的下一步：
 * `[next_steps]...[/next_steps]` 标签，或回复最后一段里的建议。
 * 永不抛错；没有真实下一步时不展示建议。
 *
 * 项目分支额外保留两类保障：
 * - 正文里显式承诺的下一步指令（如「请回复：确认内容」）始终排在最前，
 *   不依赖模型是否稳定产出；
 * - 长回复按头 + 尾截断，避免只看头部时丢掉结尾处的邀请。
 *
 * 调用方应该 fire-and-forget，且只广播一次最终结果。
 * 不要挂在 SSE 主流程里阻塞 `[DONE]`。
 */

import { llmService } from '../llm/index.js';

export const SUGGESTED_REPLY_MAX = 8;
/** 项目分支历史上建议芯片固定最多 3 条，生成入口继续沿用该上限。 */
export const SUGGESTED_REPLY_COUNT = 3;
const MAX_SUGGESTION_CHARS = 48;
const USER_TEXT_LIMIT = 500;
const SOURCE_LIMIT = 2000;

const NEXT_STEPS_BLOCK_RE = /\[next_steps\]([\s\S]*?)\[\/next_steps\]/gi;

const SYSTEM_PROMPT = `你是对话追问建议助手。根据「下一步来源」判断用户点一下就能发出去的下一轮输入。

下一步来源只有两种：
- [next_steps]...[/next_steps] 标签里的内容
- 否则是助手回复的最后一段

要求：
1. 只把「用户可以接着做的下一步」改写成用户口吻的短指令。
2. 本轮已完成的汇报（文件位置、页数、设计风格、内容结构、摘要、目录、生平/作品列表）不是下一步。来源不是给用户的下一步时，输出空数组 []。
3. 不要编造，不要用「继续完善这份结果」「告诉我下一步怎么做」这类套话凑数。
4. 有几条真实下一步就给几条，最少 0 条，最多 8 条。
5. 每条 6-40 个字。不要编号、不要引号、不要解释、不要附带命令行或绝对路径。
6. 只输出 JSON 字符串数组，例如 ["把封面改成深蓝商务风","第2页个人简介写具体"]
7. 如果下一步来源显示任务尚未完成、校验/验证未通过、或助手在问「是否继续」，第一条建议必须是继续完成任务的短指令。`;

const LIST_ITEM_RE = /^(?:\d+[.)、]|[-*•])\s+(\S.*)$/;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function clip(text: string, limit: number): string {
  const chars = Array.from((text ?? '').trim());
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, limit).join('')}…`;
}

/**
 * 长文本截断（头 + 尾）。助手回复的**结尾**才是结论与下一步邀请所在
 * （例如「以上初稿已生成完毕。如需继续，请回复：确认内容」）；只取头部会让
 * 追问建议模型看不到邀请。头部保留话题上下文，尾部保留收尾邀请，两头各取一半。
 */
function clipHeadTail(text: string, limit: number): string {
  const chars = Array.from((text ?? '').trim());
  if (chars.length <= limit) return chars.join('');
  const head = Math.floor(limit / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(-(limit - head)).join('')}`;
}

function lastParagraph(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\n\s*\n/);
  return (parts[parts.length - 1] ?? '').trim();
}

/**
 * 建议芯片的判断来源：有 `[next_steps]` 用最后一段标签正文，否则用回复最后一段。
 */
export function extractNextStepsSource(assistantText: string): string {
  const text = assistantText ?? '';
  const matches = [...text.matchAll(new RegExp(NEXT_STEPS_BLOCK_RE.source, 'gi'))];
  if (matches.length > 0) {
    return (matches[matches.length - 1][1] ?? '').trim();
  }
  return lastParagraph(text);
}

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line.trim());
}

/** 单条建议清洗：去编号/引号、压空白、截断。不合格返回空串。 */
export function cleanSuggestedReply(raw: string): string {
  let text = (raw ?? '').trim();
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\s+[&|]\s+.+$/s, '');
  text = text.replace(/\s+[A-Za-z]:\\[^\s].*$/, '');
  text = text.replace(/^[\s"'“”‘’「」『』《》【】]+|[\s"'“”‘’「」『』《》【】。.！!?？，,；;:：]+$/g, '');
  text = text.replace(/^(?:\d+[\.\)、]|[-*•])\s*/, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length < 2) return '';
  const chars = Array.from(text);
  if (chars.length > MAX_SUGGESTION_CHARS) {
    text = chars.slice(0, MAX_SUGGESTION_CHARS).join('').trim();
  }
  return text;
}

function uniqueSuggestions(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const cleaned = cleanSuggestedReply(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length === SUGGESTED_REPLY_MAX) break;
  }
  return out;
}

function sliceJsonArray(raw: string): unknown | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 从模型原文抽出建议。接受 JSON 数组、markdown 代码块、或编号/项目列表。
 * 最多 {@link SUGGESTED_REPLY_MAX} 条。
 */
export function parseSuggestedReplies(raw: string): string[] {
  const parsed = sliceJsonArray(raw);
  if (Array.isArray(parsed)) {
    return uniqueSuggestions(parsed.filter((item): item is string => typeof item === 'string'));
  }

  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const lines = candidate
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^```/.test(line));
  const listLines = lines.filter((line) => isListItem(line));
  return uniqueSuggestions(listLines.length > 0 ? listLines : lines);
}

function uniqueThree(candidates: string[], extras: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...candidates, ...extras]) {
    const cleaned = cleanSuggestedReply(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length === SUGGESTED_REPLY_COUNT) break;
  }
  return out;
}

/**
 * 助手正文里显式写出的下一步指令（「请回复：确认内容」/「回复「确认内容」」）。
 *
 * 这是角色提示词对下一轮用户输入的**明确承诺**，对应的按钮必须原样出现：
 * 不能交给追问建议模型自由改写（长回复被截断、模型跑偏都会让按钮消失）。
 * 只认「请回复：X」「回复「X」」这两种窄格式，X 为 2-12 字的短标签，
 * 避免把正文里的普通引用误当成按钮。
 */
export function explicitReplyHints(assistantText: string): string[] {
  const out: string[] = [];
  const text = assistantText ?? '';
  const push = (raw: string): void => {
    const cleaned = cleanSuggestedReply(raw);
    if (cleaned && Array.from(cleaned).length <= 12 && !out.includes(cleaned)) {
      out.push(cleaned);
    }
  };
  for (const match of text.matchAll(/请回复[：:][ \t]*([^\n，。；、,.;!?！？]{2,12})/g)) {
    push(match[1]);
  }
  for (const match of text.matchAll(/回复[「『“"]([^」』”"\n]{2,12})[」』”"]/g)) {
    push(match[1]);
  }
  return out.slice(0, SUGGESTED_REPLY_COUNT);
}

const PPT_FALLBACK = ['调整封面标题和配色', '把某一页内容写得更具体', '再加一页项目案例'];
const PLAN_FALLBACK = ['按这个计划开始执行', '先改第 2 步再执行', '把计划写得更细一点'];
const CODE_FALLBACK = ['解释这段实现的思路', '帮我补上测试', '再优化一下可读性'];
const GENERIC_FALLBACK = ['继续完善这份结果', '换一种呈现方式', '告诉我下一步怎么做'];
const PPT_OFFER_FALLBACK = ['调整幻灯片的内容和文案', '调整配色和版式', '再加一页补充材料'];
const PPT_INCOMPLETE_FALLBACK = [
  '继续修复并生成 PPT 预览稿',
  '按当前方案继续生成 PPT 预览',
  '先修正配置再继续生成预览稿',
];

/**
 * 不调模型的启发式三条。PPT / 计划 / 代码有专用句子，其它走通用。
 * 该函数作为项目分支的兼容能力保留；新的生成主路径不再依赖它兜底。
 */
export function fallbackSuggestedReplies(userText: string, assistantText: string): string[] {
  const blob = `${userText}\n${assistantText}`;
  if (/\.pptx\b|幻灯片|演示文稿|\bppt\b/i.test(blob)) { // shell-neutral:allow — Office 扩展名 'ppt'/'.pptx'，不是产品品牌
    // PPT 任务未完成：校验未通过、预览稿未生成、助手在问是否继续时，
    // 第一条建议必须是可以直接点发、继续把 PPT 预览稿生成出来的指令。
    if (
      /svg_output|SVG\s*预览|预览.{0,12}(?:未|没有|为空|尚未)|验证.{0,12}(?:未通过|失败|错误)|校验.{0,12}(?:未通过|失败|错误)|是否继续|请确认是否继续/.test(
        assistantText,
      )
    ) {
      return uniqueThree(PPT_INCOMPLETE_FALLBACK, PPT_FALLBACK);
    }
    if (/修改内容|调整样式/.test(assistantText)) {
      return uniqueThree(PPT_OFFER_FALLBACK, PPT_FALLBACK);
    }
    return uniqueThree(PPT_FALLBACK, GENERIC_FALLBACK);
  }
  if (/标准工作流程|待办清单|\bTODO\b|先制定计划/.test(blob) || /^\s*计划已/.test(assistantText)) {
    return uniqueThree(PLAN_FALLBACK, GENERIC_FALLBACK);
  }
  if (/```|单元测试|函数实现|补测试/.test(blob)) {
    return uniqueThree(CODE_FALLBACK, GENERIC_FALLBACK);
  }
  return uniqueThree(GENERIC_FALLBACK);
}

export interface GenerateSuggestedRepliesResult {
  suggestions: string[];
  /** true = LLM 失败、超时或输出不合格；suggestions 为空或仅剩显式回复提示。 */
  usedFallback: boolean;
}

export interface GenerateSuggestedRepliesOptions {
  perAttemptTimeoutMs?: number;
}

/**
 * 生成本轮追问建议。永不抛错；没有下一步来源或模型判定没有下一步时返回空数组。
 */
export async function generateSuggestedReplies(
  userText: string,
  assistantText: string,
  opts: GenerateSuggestedRepliesOptions = {},
): Promise<GenerateSuggestedRepliesResult> {
  // 正文里显式承诺的下一步指令（如「确认内容」）始终排在最前，优先级高于
  // LLM 自由生成的建议——按钮不能时有时无。
  const hints = explicitReplyHints(assistantText);
  const source = extractNextStepsSource(assistantText);
  const user = clip(userText, USER_TEXT_LIMIT);
  const sourceClip = clipHeadTail(source, SOURCE_LIMIT);
  if (!sourceClip) {
    return { suggestions: uniqueThree(hints), usedFallback: false };
  }

  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 12_000;
  try {
    const result = await withTimeout(
      llmService.generate({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `用户请求：\n${user || '（空）'}\n\n下一步来源：\n${sourceClip}`,
          },
        ],
        temperature: 0.4,
      }),
      perAttemptTimeoutMs,
      'ai-suggestions',
    );
    const raw = result.content ?? '';
    const parsed = parseSuggestedReplies(raw);
    // 显式承诺的那条已经在 hints 里了；模型经常再产出一条「确认内容，按这版继续」
    // 这类包含同一指令的变体，去掉，给真正的修改建议腾位置。
    const withoutHintEchoes = parsed.filter((item) => !hints.some((hint) => item.includes(hint)));
    const suggestions = uniqueThree([...hints, ...withoutHintEchoes]);
    if (suggestions.length > 0) {
      return { suggestions, usedFallback: false };
    }
    if (Array.isArray(sliceJsonArray(raw))) {
      return { suggestions: [], usedFallback: false };
    }
    return { suggestions: [], usedFallback: true };
  } catch (err) {
    console.warn('[ai-suggestions] LLM 追问建议失败，不展示建议', err);
    return { suggestions: uniqueThree(hints), usedFallback: true };
  }
}
