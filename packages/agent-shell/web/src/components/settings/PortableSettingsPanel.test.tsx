import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  saveTextFile: vi.fn(),
}));

vi.mock('@/lib/electron-bridge', () => ({
  getElectronBridge: () => ({
    localBackend: { request: bridge.request },
    local: { saveTextFile: bridge.saveTextFile },
  }),
}));

vi.mock('@/lib/host-tools', () => ({
  settingsChrome: () => true,
  hostToolChrome: () => true,
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: 'Shell',
}));

const { PortableSettingsPanel } = await import('./PortableSettingsPanel');

afterEach(() => {
  cleanup();
  bridge.request.mockReset();
  bridge.saveTextFile.mockReset();
});

describe('PortableSettingsPanel', () => {
  it('导出配置默认不请求钥匙', async () => {
    bridge.request.mockResolvedValue({
      kind: 'steerable-config',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      includeSecrets: false,
      sections: {
        llm: { provider: 'openai-compat', model: 'deepseek-chat', apiKeyIncluded: false },
      },
    });
    bridge.saveTextFile.mockResolvedValue({ canceled: false, filePath: '/tmp/shell-配置.json' });

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-export-config'));
    expect((screen.getByTestId('portable-include-secrets') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('portable-export-confirm'));

    await waitFor(() => {
      expect(bridge.request).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/v2/portable/config?includeSecrets=0',
      });
    });
    const saved = bridge.saveTextFile.mock.calls[0]?.[0] as { content: string };
    expect(saved.content).not.toContain('sk-');
    expect(saved.content).toContain('deepseek-chat');
    expect(await screen.findByTestId('portable-status')).toBeTruthy();
  });

  it('导出勾选的对话，不出现侧栏那颗按钮依赖的单条文件名', async () => {
    bridge.request.mockImplementation(async (input: { path: string }) => {
      if (input.path.startsWith('/api/v2/chats?')) {
        return {
          chats: [
            { id: 'c1', title: '周报' },
            { id: 'c2', title: '纪要' },
          ],
          pagination: { page: 1, limit: 100, total: 2, totalPages: 1, hasMore: false },
        };
      }
      if (input.path === '/api/v2/chats/c1/portable') {
        return {
          kind: 'steerable-chat',
          schemaVersion: 1,
          chat: { title: '周报' },
          messages: [{ role: 'user', content: '本周' }],
        };
      }
      throw new Error(input.path);
    });
    bridge.saveTextFile.mockResolvedValue({ canceled: false, filePath: '/tmp/shell-对话.json' });

    render(<PortableSettingsPanel />);
    fireEvent.click(screen.getByTestId('portable-export-chats'));
    expect(await screen.findByTestId('portable-chat-c1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('portable-chat-c2'));
    fireEvent.click(screen.getByTestId('portable-export-chats-confirm'));

    await waitFor(() => expect(bridge.saveTextFile).toHaveBeenCalled());
    const saved = bridge.saveTextFile.mock.calls[0]?.[0] as { content: string; defaultPath: string };
    expect(saved.defaultPath).toContain('对话');
    const body = JSON.parse(saved.content) as { kind: string; chats: Array<{ chat: { title: string } }> };
    expect(body.kind).toBe('steerable-chats');
    expect(body.chats.map((item) => item.chat.title)).toEqual(['周报']);
  });
});
