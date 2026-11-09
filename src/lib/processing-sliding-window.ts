/**
 * Janela movel conservadora: mantem no maximo maxConcurrentItems
 * reclamados simultaneamente, divididos em pequenos chunks.
 *
 * Cada lane busca um novo chunk assim que termina o anterior, sem
 * aguardar a cauda lenta das demais lanes. Claims sao serializados
 * para evitar transacoes concorrentes de FOR UPDATE SKIP LOCKED.
 */
export async function runSlidingClaimedBatches<T>(input: {
  maxItems: number;
  maxConcurrentItems: number;
  chunkSize: number;
  canClaim?: () => boolean;
  claim: (limit: number) => Promise<T[]>;
  process: (items: T[]) => Promise<void>;
}): Promise<{ claimed: number; batches: number; peakClaimed: number }> {
  const { maxItems, maxConcurrentItems, chunkSize, claim, process } = input;
  for (const [name, value] of Object.entries({ maxItems, maxConcurrentItems, chunkSize })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} precisa ser inteiro positivo.`);
    }
  }
  if (chunkSize > maxConcurrentItems) {
    throw new RangeError("chunkSize nao pode exceder maxConcurrentItems.");
  }

  let claimed = 0;
  let batches = 0;
  let activeClaims = 0;
  let peakClaimed = 0;
  let exhausted = false;
  let interrupted = false;
  let firstError: unknown = null;
  let claimQueue: Promise<void> = Promise.resolve();

  function nextBatch(limit: number): Promise<T[]> {
    const pending = claimQueue.then(async () => {
      if (exhausted || interrupted || claimed >= maxItems || input.canClaim?.() === false) {
        return [] as T[];
      }
      const count = Math.min(limit, maxItems - claimed);
      const items = await claim(count);
      if (items.length > count) {
        throw new RangeError("Claim retornou mais itens que o limite reservado.");
      }
      claimed += items.length;
      batches += items.length > 0 ? 1 : 0;
      activeClaims += items.length;
      peakClaimed = Math.max(peakClaimed, activeClaims);
      if (items.length < count) exhausted = true;
      return items;
    });
    claimQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  const lanes: number[] = [];
  for (let offset = 0; offset < maxConcurrentItems; offset += chunkSize) {
    lanes.push(Math.min(chunkSize, maxConcurrentItems - offset));
  }

  await Promise.all(lanes.map(async (size) => {
    while (!interrupted) {
      let items: T[];
      try {
        items = await nextBatch(size);
      } catch (error) {
        interrupted = true;
        firstError ??= error;
        return;
      }
      if (items.length === 0) return;
      try {
        await process(items);
      } catch (error) {
        interrupted = true;
        firstError ??= error;
        return;
      } finally {
        activeClaims -= items.length;
      }
    }
  }));
  if (firstError) throw firstError;
  return { claimed, batches, peakClaimed };
}

/** Compartilha limite global de persistencia entre lanes paralelas. */
export function createAsyncLimiter(maxConcurrency: number) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("maxConcurrency precisa ser inteiro positivo.");
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(action: () => Promise<T>): Promise<T> {
    if (active < maxConcurrency) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await action();
    } finally {
      const next = waiting.shift();
      if (next) next(); // Transfere o slot sem aumentar active.
      else active--;
    }
  };
}
