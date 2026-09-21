/**
 * 产品只留一种对话模式时，输入框不渲染 Agent/Plan 切换。
 * 会话附件跟 local-fs capability 走，不跟 chrome（公文关访达仍要上传）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';

const capabilityOff = new Set<string>();

vi.mock('@/lib/host-tools', () => ({
  hostToolChrome: () => true,
  hostToolCapability: (id: string) => !capabilityOff.has(id),
  getWebChatModes: () => ['agent'],
  settingsChrome: () => true,
}));

afterEach(() => {
  capabilityOff.clear();
  cleanup();
});

function renderComposer() {
  render(
    <MemoryRouter>
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        mode="agent"
        onModeChange={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('ChatInput 对话模式 chrome', () => {
  it('只有 Agent 时不显示模式切换', () => {
    renderComposer();
    expect(screen.queryByTestId('mode-toggle')).toBeNull();
    expect(screen.queryByTestId('mode-plan')).toBeNull();
  });
});

describe('ChatInput 会话附件', () => {
  it('local-fs 有能力时显示上传按钮', () => {
    renderComposer();
    expect(screen.getByTestId('chat-attach')).toBeTruthy();
  });

  it('local-fs 整族关掉后不显示上传按钮', () => {
    capabilityOff.add('local-fs');
    renderComposer();
    expect(screen.queryByTestId('chat-attach')).toBeNull();
  });
});
