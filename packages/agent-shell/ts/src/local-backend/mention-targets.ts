/**
 * `@提及` → 被点名的智能体 id。
 *
 * 渲染层从 `@` 菜单点选时会把 id 放进 `metadata.mentionedAgentIds`；手打
 * 的 `@名字` 不带 id。只认 id 的话，手打提及在后端等于没提及：不下发子代理
 * 画像、不注入强制派发指令，而 Web 顶栏又按正文扫 `@词` 画徽章——界面显示
 * 点了三个人，实际一个都没派活。这里把正文解析补在后端，两侧同一口径。
 *
 * 中文没有词边界，所以按「最长画像名/slug 前缀」匹配，而不是按空白切词：
 * `@日程规划，帮我…` 里的标点不会被吃进名字。
 */

/** 匹配用的智能体子集。 */
export interface MentionAgentRef {
  id: string;
  slug: string | null;
  name: string;
}

interface MentionLabel {
  label: string;
  id: string;
}

/**
 * 请求体里显式带来的提及 id（`@` 菜单点选的结果）。
 *
 * @param payload 发送请求体。
 * @returns 去重后的 id 列表，保持 `mentionedAgentId` 优先的原有顺序。
 */
export function collectExplicitMentionIds(payload: Record<string, unknown>): string[] {
  const listed = Array.isArray(payload.mentionedAgentIds)
    ? (payload.mentionedAgentIds as unknown[]).filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : [];
  const single =
    typeof payload.mentionedAgentId === 'string' && payload.mentionedAgentId
      ? [payload.mentionedAgentId]
      : [];
  return dedupe([...single, ...listed]);
}

/**
 * 从消息正文里解析 `@名字` / `@slug`。
 *
 * @param text 用户消息正文。
 * @param agents 本会话可用的智能体。
 * @returns 命中的智能体 id，按正文出现顺序去重。
 */
export function mentionedAgentIdsFromText(
  text: string,
  agents: readonly MentionAgentRef[],
): string[] {
  if (!text.includes('@')) return [];
  const labels = mentionLabels(agents);
  if (labels.length === 0) return [];
  const ids: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    // 只在行首/空白后开门：邮箱地址与 `a@b` 这类文本不是提及。
    const prev = i === 0 ? '' : text[i - 1];
    if (prev && !/\s/.test(prev)) continue;
    const rest = text.slice(i + 1);
    const matched = labels.find((entry) =>
      rest.slice(0, entry.label.length).toLowerCase() === entry.label.toLowerCase(),
    );
    if (!matched) continue;
    ids.push(matched.id);
    i += matched.label.length;
  }
  return dedupe(ids);
}

/**
 * 本轮生效的提及 id：显式 id 优先，正文解析补齐。
 *
 * @param payload 发送请求体。
 * @param text 用户消息正文。
 * @param agents 本会话可用的智能体。
 * @returns 去重后的 id 列表。
 */
export function resolveMentionedAgentIds(
  payload: Record<string, unknown>,
  text: string,
  agents: readonly MentionAgentRef[],
): string[] {
  const explicit = collectExplicitMentionIds(payload);
  const known = new Set(agents.map((agent) => agent.id));
  return dedupe([
    ...explicit,
    ...mentionedAgentIdsFromText(text, agents).filter((id) => known.has(id)),
  ]);
}

/** 画像名与 slug 合成匹配表，长名在前——`@调研员组` 不该命中 `调研员`。 */
function mentionLabels(agents: readonly MentionAgentRef[]): MentionLabel[] {
  const labels: MentionLabel[] = [];
  for (const agent of agents) {
    const name = agent.name.trim();
    const slug = agent.slug?.trim() ?? '';
    if (name) labels.push({ label: name, id: agent.id });
    if (slug && slug !== name) labels.push({ label: slug, id: agent.id });
  }
  return labels.sort((a, b) => b.label.length - a.label.length);
}

function dedupe(ids: readonly string[]): string[] {
  return ids.filter((id, index, all) => all.indexOf(id) === index);
}
