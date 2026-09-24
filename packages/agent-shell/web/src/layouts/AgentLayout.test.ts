/**
 * 右侧栏位「按会话隔离」的持久化解析契约。
 *
 * 背景：以前 `deeppath.agent.rightPanel` 存的是单个全局值，会话 1 打开文档
 * 预览会让会话 2 也跟着打开。现在存 chatId → 栏位 的映射，并兼容旧格式。
 */
import { describe, expect, it } from 'vitest';
import { parseRightPanelMap } from './AgentLayout';

const isValidValue = (value: string) =>
  value === 'terminal' || value === 'ppt' || value === 'word';

describe('parseRightPanelMap', () => {
  it('解析新格式的会话映射，并保留各会话各自的状态', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({ 'chat-1': 'word', 'chat-2': 'terminal' }),
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({ 'chat-1': 'word', 'chat-2': 'terminal' });
  });

  it('丢弃无效栏位值，保证脏数据不会卡住面板', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({ 'chat-1': 'word', 'chat-2': 'gone-slot', 'chat-3': 42 }),
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({ 'chat-1': 'word' });
  });

  it('把旧版单值迁移到当前会话', () => {
    const map = parseRightPanelMap({
      raw: 'ppt',
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({ 'chat-1': 'ppt' });
  });

  it('空字符串按"都关着"处理', () => {
    expect(
      parseRightPanelMap({
        raw: '',
        legacyTerminalOpen: null,
        chatId: 'chat-1',
        isValidValue,
      }),
    ).toEqual({});
  });

  it('更老的终端布尔 key 迁移到当前会话；没有会话时不迁', () => {
    expect(
      parseRightPanelMap({
        raw: null,
        legacyTerminalOpen: '1',
        chatId: 'chat-1',
        isValidValue,
      }),
    ).toEqual({ 'chat-1': 'terminal' });
    expect(
      parseRightPanelMap({
        raw: null,
        legacyTerminalOpen: '1',
        chatId: null,
        isValidValue,
      }),
    ).toEqual({});
  });

  it('新会话不在映射里 → 查不到即视为关闭', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({ 'chat-1': 'word' }),
      legacyTerminalOpen: null,
      chatId: 'chat-2',
      isValidValue,
    });
    expect(map['chat-2']).toBeUndefined();
  });
});
