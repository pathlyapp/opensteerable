/** Prefix for the machine-readable host startup record on stdout. */
export const HOST_READY_PREFIX = 'STEERABLE_HOST_READY ';

export interface HostReadyRecord {
  host: string;
  port: number;
}

/**
 * Formats the startup record consumed by desktop host supervisors.
 *
 * Human-readable log lines are not part of this protocol.
 */
export function formatHostReady(record: HostReadyRecord): string {
  return `${HOST_READY_PREFIX}${JSON.stringify(record)}`;
}
