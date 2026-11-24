/** Keep the grouped path exclusive to ordinary general-sync dashboard jobs. */
export function canUseGroupedPersistence(input: {
  enabled: boolean;
  slidingWindowV2Enabled: boolean;
  pilot: boolean;
  groupSize: number;
  job: {
    processing_origin: string;
    processing_scope: string;
    general_sync_run_id: string | null;
    target_member_link_id: string | null;
    filtered_error_request_id: string | null;
  };
}): boolean {
  const { job } = input;
  return input.enabled && input.slidingWindowV2Enabled && !input.pilot &&
    Number.isSafeInteger(input.groupSize) && input.groupSize >= 2 &&
    job.processing_origin === "dashboard" && job.processing_scope === "dashboard" &&
    Boolean(job.general_sync_run_id) &&
    job.target_member_link_id == null && job.filtered_error_request_id == null;
}

/** Bounded, single-writer micro-batches. Each submit resolves only after
 * the callback has completed the entire transaction (including commit).
 * The caller owns recovery of a rejected group. No timer survives a drain.
 */
export function createGroupedPersistence<T, R>(input: {
  maxSize: number;
  maxWaitMs: number;
  write: (items: readonly T[]) => Promise<readonly R[]>;
}) {
  const { maxSize, maxWaitMs, write } = input;
  if (!Number.isSafeInteger(maxSize) || maxSize < 1 ||
      !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) {
    throw new RangeError("Invalid grouped persistence bounds");
  }

  type Entry = {
    item: T;
    queuedAt: number;
    resolve: (result: R) => void;
    reject: (error: unknown) => void;
  };
  const pending: Entry[] = [];
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (running || pending.length === 0) return;
    const delay = Math.max(0, maxWaitMs - (performance.now() - pending[0]!.queuedAt));
    if (pending.length >= maxSize || delay === 0) {
      void drain();
    } else {
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, Math.ceil(delay));
    }
  }

  async function drain() {
    if (running || pending.length === 0) return;
    running = true;
    const group = pending.splice(0, maxSize);
    try {
      const results = await write(group.map((entry) => entry.item));
      if (results.length !== group.length) throw new Error("Grouped persistence result count mismatch");
      group.forEach((entry, index) => entry.resolve(results[index]!));
    } catch (error) {
      group.forEach((entry) => entry.reject(error));
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    submit(item: T): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        pending.push({ item, queuedAt: performance.now(), resolve, reject });
        schedule();
      });
    }
  };
}
