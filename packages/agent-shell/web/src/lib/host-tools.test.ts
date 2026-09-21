import { describe, expect, it } from 'vitest';
import {
  resolveWebHostTools,
  sanitizeRightPanelKind,
} from './host-tools';

describe('resolveWebHostTools', () => {
  it('缺省全开', () => {
    const tools = resolveWebHostTools();
    expect(tools.terminal.chrome).toBe(true);
    expect(tools['local-fs'].chrome).toBe(true);
    expect(tools.projects.chrome).toBe(true);
  });

  it('false 关整族；对象可只关 chrome', () => {
    const tools = resolveWebHostTools({
      terminal: false,
      'local-fs': { chrome: false },
    });
    expect(tools.terminal).toEqual({ capability: false, chrome: false });
    expect(tools['local-fs']).toEqual({ capability: true, chrome: false });
  });
});

describe('sanitizeRightPanelKind', () => {
  it('缺省允许恢复 terminal', () => {
    expect(sanitizeRightPanelKind('terminal')).toBe('terminal');
    expect(sanitizeRightPanelKind('preview')).toBe('preview');
  });
});
