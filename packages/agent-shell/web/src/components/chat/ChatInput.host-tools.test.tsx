/**
 * 产品只留一种对话模式时，输入框不渲染 Agent/Plan 切换。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';

vi.mock('@/lib/host-tools', () => ({
  hostToolChrome: () => true,
  getWebChatModes: () => ['agent'],
}));

afterEach(() => cleanup());

describe('ChatInput 对话模式 chrome', () => {
  it('只有 Agent 时不显示模式切换', () => {
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
    expect(screen.queryByTestId('mode-toggle')).toBeNull();
    expect(screen.queryByTestId('mode-plan')).toBeNull();
  });
});
