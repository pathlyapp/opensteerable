/**
 * 回合追问建议（local-backend/ai-suggestions.ts）行为测试。
 *
 * 钉住：只把 `[next_steps]` / 最后一段交给 LLM 判断，JSON / 编号列表解析，
 * 显式回复提示置顶，失败或超时返回空数组且永不抛错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock('../../src/llm/index.js', () => ({
  llmService: { generate: mocks.generate },
}));

import {
  cleanSuggestedReply,
  explicitReplyHints,
  extractNextStepsSource,
  fallbackSuggestedReplies,
  generateSuggestedReplies,
  parseSuggestedReplies,
} from '../../src/local-backend/ai-suggestions.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cleanSuggestedReply / parseSuggestedReplies', () => {
  it('去掉编号、引号、尾标点并截断', () => {
    expect(cleanSuggestedReply('1. 调整封面配色。')).toBe('调整封面配色');
    expect(cleanSuggestedReply('"把个人简介写得更具体"')).toBe('把个人简介写得更具体');
    expect(cleanSuggestedReply('• 再加一页')).toBe('再加一页');
    expect(cleanSuggestedReply('x')).toBe('');
    expect(Array.from(cleanSuggestedReply('字'.repeat(60))).length).toBe(48);
  });

  it('解析 JSON 数组（含 markdown 代码块）', () => {
    expect(
      parseSuggestedReplies('["调整封面配色","把个人简介写得更具体","再加一页项目案例"]'),
    ).toEqual(['调整封面配色', '把个人简介写得更具体', '再加一页项目案例']);
    expect(
      parseSuggestedReplies('```json\n["A建议内容足够长","B建议内容足够长","C建议内容足够长"]\n```'),
    ).toEqual(['A建议内容足够长', 'B建议内容足够长', 'C建议内容足够长']);
  });

  it('解析编号列表，去重后不压成 3 条', () => {
    expect(
      parseSuggestedReplies(
        '1. 调整封面配色\n2. 调整封面配色\n3. 把第2页写具体\n4. 再加一页\n5. 换浅色背景',
      ),
    ).toEqual(['调整封面配色', '把第2页写具体', '再加一页', '换浅色背景']);
  });

  it('非法 JSON 落到分行', () => {
    expect(parseSuggestedReplies('不是数组\n- 调整封面配色\n- 补充项目经历\n- 改成简洁文案')).toEqual([
      '调整封面配色',
      '补充项目经历',
      '改成简洁文案',
    ]);
  });
});

describe('fallbackSuggestedReplies', () => {
  it('PPT 产物走封面/内容/加页', () => {
    expect(fallbackSuggestedReplies('制作自我介绍ppt', 'PPT 已生成 /tmp/自我介绍_PPT.pptx')).toEqual([
      '调整封面标题和配色',
      '把某一页内容写得更具体',
      '再加一页项目案例',
    ]);
  });

  it('助手邀请改内容/样式时把邀请具体化', () => {
    expect(
      fallbackSuggestedReplies(
        '做个 ppt',
        'PPT 已生成。如需修改内容或调整样式，请告诉我。',
      ),
    ).toEqual(['调整幻灯片的内容和文案', '调整配色和版式', '再加一页补充材料']);
  });

  it('PPT 校验未通过 / 预览稿未生成时首条建议继续生成', () => {
    const suggestions = fallbackSuggestedReplies(
      '创建PPT',
      'spec_lock 验证尚未通过，需要修复后继续生成 PPT 预览稿。请确认是否继续执行修复和生成流程。',
    );
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toBe('继续修复并生成 PPT 预览稿');
    expect(suggestions).toContain('按当前方案继续生成 PPT 预览');
  });

  it('代码回复走解释/测试/可读性', () => {
    expect(fallbackSuggestedReplies('修这个函数', '```ts\nexport function foo() {}\n```')).toEqual([
      '解释这段实现的思路',
      '帮我补上测试',
      '再优化一下可读性',
    ]);
  });

  it('其它走通用三条', () => {
    expect(fallbackSuggestedReplies('你好', '你好，需要帮忙吗？')).toEqual([
      '继续完善这份结果',
      '换一种呈现方式',
      '告诉我下一步怎么做',
    ]);
  });
});

describe('extractNextStepsSource', () => {
  it('优先取最后一段 [next_steps] 正文', () => {
    expect(
      extractNextStepsSource(
        'PPT 已完成。\n\n文件位置：桌面\n\n[next_steps]\n- 调整封面配色\n- 再加一页项目案例\n[/next_steps]',
      ),
    ).toBe('- 调整封面配色\n- 再加一页项目案例');
  });

  it('多段标签时取最后一段', () => {
    expect(
      extractNextStepsSource(
        '[next_steps]\n旧建议\n[/next_steps]\n\n正文\n\n[next_steps]\n新建议甲\n新建议乙\n[/next_steps]',
      ),
    ).toBe('新建议甲\n新建议乙');
  });

  it('没有标签时取最后一段', () => {
    expect(
      extractNextStepsSource(
        'PPT 已制作完成并已打开。\n\n**文件位置**：桌面\n**页数**：8 页\n\n可以接着改封面配色，或再加一页作品赏析。',
      ),
    ).toBe('可以接着改封面配色，或再加一页作品赏析。');
  });

  it('空回复得到空来源', () => {
    expect(extractNextStepsSource('')).toBe('');
    expect(extractNextStepsSource('   ')).toBe('');
  });
});

describe('explicitReplyHints：正文显式承诺的下一步按钮', () => {
  it('从「请回复：X」/「回复「X」」抽取短指令', () => {
    expect(explicitReplyHints('以上初稿已生成完毕。如需继续，请回复：确认内容')).toEqual([
      '确认内容',
    ]);
    expect(explicitReplyHints('没问题后请回复「确认内容」')).toEqual(['确认内容']);
    expect(explicitReplyHints('请回复：继续生成 PPT 预览稿')).toEqual(['继续生成 PPT 预览稿']);
    expect(explicitReplyHints('这段正文没有任何显式邀请。')).toEqual([]);
  });

  it('显式承诺的指令排在 LLM 建议之前（按钮不能时有时无）', async () => {
    mocks.generate.mockResolvedValue({
      content: '["把提请事项写得更正式","补充附件清单","开头补一段背景依据"]',
    });
    const result = await generateSuggestedReplies(
      '帮我生成议案',
      '正文很长……\n以上议案初稿已生成完毕。如需继续，请回复：确认内容',
    );
    expect(result.suggestions[0]).toBe('确认内容');
    expect(result.suggestions).toHaveLength(3);
  });

  it('模型把承诺指令改写成变体时去重（不出现两条“确认内容”）', async () => {
    mocks.generate.mockResolvedValue({
      content: '["确认内容，按这版继续完善","补充附件清单","开头补一段背景依据"]',
    });
    const result = await generateSuggestedReplies(
      '帮我生成议案',
      '正文很长……\n以上议案初稿已生成完毕。如需继续，请回复：确认内容',
    );
    expect(result.suggestions[0]).toBe('确认内容');
    expect(result.suggestions.filter((s) => s.includes('确认内容'))).toHaveLength(1);
  });

  it('长回复把结尾邀请喂进 prompt（头+尾截断，不能只看头部）', async () => {
    mocks.generate.mockResolvedValue({
      content: '["把提请事项写得更正式","补充附件清单","开头补一段背景依据"]',
    });
    const long = `${'材料内容'.repeat(1200)}\n以上议案初稿已生成完毕。如需继续，请回复：确认内容`;
    await generateSuggestedReplies('帮我生成议案', long);
    const sent = String(mocks.generate.mock.calls[0][0].messages[1].content);
    expect(sent).toContain('确认内容');
  });
});

describe('generateSuggestedReplies', () => {
  const user = '制作自我介绍ppt';
  const assistant =
    'PPT 已生成并打开。\n\n[next_steps]\n- 把封面改成深蓝商务风\n- 第2页个人简介写具体\n[/next_steps]';

  it('把 next_steps 正文交给 LLM，合格 JSON 时 usedFallback=false', async () => {
    mocks.generate.mockResolvedValue({
      content: '["把封面改成深蓝商务风","第2页个人简介写具体","再加一页项目经历"]',
    });
    const result = await generateSuggestedReplies(user, assistant);
    expect(result.usedFallback).toBe(false);
    expect(result.suggestions).toEqual([
      '把封面改成深蓝商务风',
      '第2页个人简介写具体',
      '再加一页项目经历',
    ]);
    const prompt = mocks.generate.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('把封面改成深蓝商务风');
    expect(prompt).not.toContain('PPT 已生成并打开');
  });

  it('没有标签时只把最后一段当来源', async () => {
    mocks.generate.mockResolvedValue({
      content: '["调整封面配色","再加一页作品赏析"]',
    });
    await generateSuggestedReplies(
      '介绍杜甫',
      'PPT 已完成。\n\n**页数**：8 页\n\n可以接着改封面配色，或再加一页作品赏析。',
    );
    const prompt = mocks.generate.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('可以接着改封面配色，或再加一页作品赏析。');
    expect(prompt).not.toContain('**页数**：8 页');
  });

  it('模型判定没有下一步时返回空数组且不算兜底', async () => {
    mocks.generate.mockResolvedValue({ content: '[]' });
    const result = await generateSuggestedReplies(
      '介绍杜甫',
      'PPT 已完成。\n\n**文件位置**：桌面\n**页数**：8 页',
    );
    expect(result.usedFallback).toBe(false);
    expect(result.suggestions).toEqual([]);
  });

  it('没有来源时不调 LLM', async () => {
    const result = await generateSuggestedReplies('你好', '   ');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(result).toEqual({ suggestions: [], usedFallback: false });
  });

  it('LLM 空白 / 抛错时返回空数组', async () => {
    mocks.generate.mockResolvedValue({ content: '' });
    const empty = await generateSuggestedReplies(user, assistant);
    expect(empty.usedFallback).toBe(true);
    expect(empty.suggestions).toEqual([]);

    mocks.generate.mockRejectedValue(new Error('boom'));
    const failed = await generateSuggestedReplies(user, assistant);
    expect(failed.usedFallback).toBe(true);
    expect(failed.suggestions).toEqual([]);
  });

  it('超时返回空数组且不抛错', async () => {
    mocks.generate.mockImplementation(() => new Promise(() => {}));
    const result = await generateSuggestedReplies(user, assistant, { perAttemptTimeoutMs: 20 });
    expect(result.usedFallback).toBe(true);
    expect(result.suggestions).toEqual([]);
  });
});
