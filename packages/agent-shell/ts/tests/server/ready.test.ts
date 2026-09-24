import { describe, expect, it } from 'vitest';
import {
  formatHostReady,
  HOST_READY_PREFIX,
} from '../../src/server/ready.js';

describe('formatHostReady', () => {
  it('emits one stable machine-readable startup record', () => {
    const line = formatHostReady({ host: '127.0.0.1', port: 49152 });
    expect(line.startsWith(HOST_READY_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(HOST_READY_PREFIX.length))).toEqual({
      host: '127.0.0.1',
      port: 49152,
    });
  });
});
