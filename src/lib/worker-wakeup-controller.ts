/**
 * Coalesce bursts of committed database notifications into a single worker
 * process. Notifications received while it runs request at most one more pass.
 * The worker's PostgreSQL advisory lock remains the cross-process safeguard.
 */
export function createWorkerWakeupController(
  runWorker: () => Promise<void>,
  reportError: (error: unknown) => void
) {
  let running = false;
  let pending = false;
  let stopped = false;

  async function pump(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try {
          await runWorker();
        } catch (error) {
          reportError(error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    wake() {
      if (stopped) return;
      pending = true;
      void pump();
    },
    stop() {
      stopped = true;
      pending = false;
    },
    isRunning() {
      return running;
    }
  };
}
