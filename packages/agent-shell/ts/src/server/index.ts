/** Executable BS entry; reusable assembly lives in `start.ts`. */
import { startBsHost } from './start.js';
import { formatHostReady } from './ready.js';

async function main(): Promise<void> {
  const handle = await startBsHost();
  console.log(formatHostReady({ host: handle.host, port: handle.port }));
  let shuttingDown = false;
  let parentWatch: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (parentWatch) clearInterval(parentWatch);
    console.log('[bs] shutting down…');
    void handle.shutdown().finally(() => process.exit(0));
    // 兜底：sidecar 卡住也不拖住退出。
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const parentPidValue = process.env.STEERABLE_HOST_PARENT_PID?.trim();
  if (parentPidValue) {
    const parentPid = Number(parentPidValue);
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) {
      throw new Error(`invalid STEERABLE_HOST_PARENT_PID: ${parentPidValue}`);
    }
    parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ESRCH'
        ) {
          shutdown();
        }
      }
    }, 1_000);
    parentWatch.unref();
  }
}

main().catch((err) => {
  console.error('[bs] failed to start:', err);
  process.exit(1);
});
