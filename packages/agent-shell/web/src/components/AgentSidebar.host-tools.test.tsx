/**
 * 产品关掉某族 chrome 时侧栏不渲染对应入口。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElectronBridge } from '@/lib/electron-bridge';
import type { UseChatsAndAgentsResult } from '@/hooks/useChatsAndAgents';
import type { LocalProject } from '@/lib/local-api';

const chromeOff = new Set<string>();
const settingsOff = new Set<string>();

vi.mock('@/lib/host-tools', () => ({
  hostToolChrome: (id: string) => !chromeOff.has(id),
  settingsChrome: (id: string) => !settingsOff.has(id),
  hasGeneralSettingsChrome: () =>
    !['appearance', 'llm', 'web-search', 'usage', 'diagnose', 'security', 'insights', 'telemetry'].every(
      (id) => settingsOff.has(id),
    ),
}));

let bridgeStub: ElectronBridge | null = null;

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => bridgeStub !== null,
  getElectronBridge: () => bridgeStub,
}));

const listProjects = vi.fn();
const openLocalPath = vi.fn();

vi.mock('@/lib/local-api', () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  openLocalPath: (...args: unknown[]) => openLocalPath(...args),
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: '测试助手',
  BRAND_TITLE: '测试助手',
  getBrandLogoUrl: () => '',
  DEFAULT_AGENT_ID: 'local-assistant',
}));

const { AgentSidebar } = await import('./AgentSidebar');

afterEach(() => {
  cleanup();
  chromeOff.clear();
  settingsOff.clear();
  bridgeStub = null;
  listProjects.mockReset();
  openLocalPath.mockReset();
});

function makeData(): UseChatsAndAgentsResult {
  return {
    chats: [],
    agents: [],
    chatsLoading: false,
    agentsLoading: false,
    error: null,
    projectError: null,
    selectedAgentId: 'local-assistant',
    setSelectedAgentId: vi.fn(),
    refreshChats: vi.fn(async () => {}),
    refreshAgents: vi.fn(async () => {}),
    createChat: vi.fn(),
    deleteChat: vi.fn(async () => true),
    patchChatTitle: vi.fn(),
    isLoadingMoreChats: false,
    hasMoreChats: false,
    loadMoreChats: vi.fn(async () => {}),
  } as unknown as UseChatsAndAgentsResult;
}

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/agent']}>
      <Routes>
        <Route
          path="/agent"
          element={
            <AgentSidebar
              data={makeData()}
              rightPanel={null}
              onToggleRightPanel={vi.fn()}
              onCollapse={vi.fn()}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AgentSidebar 宿主工具族 chrome', () => {
  it('未引入终端时不渲染终端按钮', () => {
    chromeOff.add('terminal');
    renderSidebar();
    expect(screen.queryByTestId('sidebar-terminal')).toBeNull();
  });

  it('local-fs chrome 关掉时项目菜单不出现访达入口', async () => {
    chromeOff.add('local-fs');
    const project: LocalProject = {
      id: 'proj-1',
      name: '项目甲',
      folderPath: '/tmp/proj-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listProjects.mockResolvedValue({ projects: [project] });
    openLocalPath.mockResolvedValue({ success: true });
    bridgeStub = {
      runtime: 'local',
      platform: 'darwin',
      local: {
        selectDirectory: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
        captureScreenshot: vi.fn(async () => ({ success: false as const, error: '未实现' })),
      },
      localBackend: {
        request: vi.fn() as unknown as ElectronBridge['localBackend']['request'],
        startStream: vi.fn(async () => null),
        cancelStream: vi.fn(),
      },
    };
    renderSidebar();
    await screen.findByText('项目甲');
    fireEvent.click(screen.getByLabelText('项目菜单'));
    expect(screen.getByTestId('project-overflow-menu')).toBeTruthy();
    expect(screen.getByTitle('重命名项目')).toBeTruthy();
    expect(screen.getByTitle('编辑项目')).toBeTruthy();
    expect(screen.queryByTitle('在访达中显示')).toBeNull();
    expect(screen.queryByTitle('在文件管理器中显示')).toBeNull();
    await waitFor(() => expect(openLocalPath).not.toHaveBeenCalled());
  });

  it('关掉 projects chrome 时不渲染新建项目和项目分组', async () => {
    chromeOff.add('projects');
    const project: LocalProject = {
      id: 'proj-1',
      name: '项目甲',
      folderPath: '/tmp/proj-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listProjects.mockResolvedValue({ projects: [project] });
    bridgeStub = {
      runtime: 'local',
      platform: 'darwin',
      local: {
        selectDirectory: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
        captureScreenshot: vi.fn(async () => ({ success: false as const, error: '未实现' })),
      },
      localBackend: {
        request: vi.fn() as unknown as ElectronBridge['localBackend']['request'],
        startStream: vi.fn(async () => null),
        cancelStream: vi.fn(),
      },
    };
    renderSidebar();
    expect(screen.queryByLabelText('新建项目')).toBeNull();
    expect(screen.queryByText('项目甲')).toBeNull();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('关掉设置项时不渲染对应侧栏入口', () => {
    settingsOff.add('agents');
    settingsOff.add('skills');
    settingsOff.add('mcp');
    renderSidebar();
    expect(screen.queryByTestId('sidebar-agent-settings')).toBeNull();
    expect(screen.queryByTestId('sidebar-skill-settings')).toBeNull();
    expect(screen.queryByTestId('sidebar-mcp-settings')).toBeNull();
    expect(screen.getByTestId('sidebar-llm-settings')).toBeTruthy();
  });
});
