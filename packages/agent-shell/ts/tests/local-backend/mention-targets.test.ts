/**
 * `@提及` → 智能体 id：菜单点选的显式 id、手打正文解析、两者合并。
 *
 * 手打解析是根因修复——此前只认显式 id，手打的 `@名字` 在后端等于没提及
 * （不下发画像、不注入派发指令），而 Web 顶栏按正文扫徽章，界面与后端口径
 * 不一致。
 */
import { describe, expect, it } from 'vitest';
import {
  collectExplicitMentionIds,
  mentionedAgentIdsFromText,
  resolveMentionedAgentIds,
} from '../../src/local-backend/mention-targets.js';

const AGENTS = [
  { id: 'a-assistant', slug: 'local-assistant', name: '智能助手' },
  { id: 'a-schedule', slug: 'scheduler', name: '日程规划' },
  { id: 'a-operator', slug: 'operator', name: '电脑操作员' },
];

describe('collectExplicitMentionIds', () => {
  it('单数字段排在列表之前，并去重', () => {
    expect(
      collectExplicitMentionIds({
        mentionedAgentId: 'a-operator',
        mentionedAgentIds: ['a-assistant', 'a-operator'],
      }),
    ).toEqual(['a-operator', 'a-assistant']);
  });

  it('没有提及字段时为空', () => {
    expect(collectExplicitMentionIds({ message: '你好' })).toEqual([]);
  });
});

describe('mentionedAgentIdsFromText', () => {
  it('手打的中文名按出现顺序解析', () => {
    expect(
      mentionedAgentIdsFromText('@电脑操作员 @智能助手 @日程规划 你们随便做点啥', AGENTS),
    ).toEqual(['a-operator', 'a-assistant', 'a-schedule']);
  });

  it('紧跟标点也能识别（中文没有词边界）', () => {
    expect(mentionedAgentIdsFromText('@日程规划，排一下今晚', AGENTS)).toEqual([
      'a-schedule',
    ]);
  });

  it('slug 也算提及，且大小写无关', () => {
    expect(mentionedAgentIdsFromText('@Scheduler 看下日历', AGENTS)).toEqual([
      'a-schedule',
    ]);
  });

  it('重复提及只算一次', () => {
    expect(mentionedAgentIdsFromText('@智能助手 再问 @智能助手', AGENTS)).toEqual([
      'a-assistant',
    ]);
  });

  it('词中间的 @ 不是提及（邮箱等）', () => {
    expect(mentionedAgentIdsFromText('发到 me@智能助手.com', AGENTS)).toEqual([]);
  });

  it('不认识的名字不命中', () => {
    expect(mentionedAgentIdsFromText('@张三 帮个忙', AGENTS)).toEqual([]);
  });
});

describe('resolveMentionedAgentIds', () => {
  it('显式 id 优先，正文解析补齐剩下的', () => {
    expect(
      resolveMentionedAgentIds(
        { mentionedAgentIds: ['a-assistant'] },
        '@智能助手 @日程规划 一起来',
        AGENTS,
      ),
    ).toEqual(['a-assistant', 'a-schedule']);
  });

  it('只有正文时也能解析出全部', () => {
    expect(
      resolveMentionedAgentIds({}, '@智能助手 @日程规划 一起来', AGENTS),
    ).toEqual(['a-assistant', 'a-schedule']);
  });

  it('正文解析的结果必须是已知智能体', () => {
    expect(resolveMentionedAgentIds({}, '@日程规划 排期', [])).toEqual([]);
  });
});
