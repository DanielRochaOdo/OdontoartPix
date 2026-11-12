/**
 * Sliding Window V2: uma consulta inicial reserva ate o limite de vagas.
 * Depois, cada vaga liberada busca uma unica nova fatura, sem esperar
 * que as demais terminem. O mesmo worker conserva a trava global e
 * os claims serializados, evitando corrida entre SELECT FOR UPDATE.
 */
export type ContinuousWindowResult = {
  claimed: number;
  claimCalls: number;
  peakClaimed: number;
  drained: boolean;
};

export async function runContinuousClaimedItems<T>(input: {
  maxItems: number;
  maxConcurrentItems: number;
  canClaim?: () => boolean;
  claim: (limit: number) => Promise<T[]>;
  process: (item: T) => Promise<void>;
}): Promise<ContinuousWindowResult> {
  const { maxItems, maxConcurrentItems, claim, process } = input;
  for (const [name, value] of Object.entries({ maxItems, maxConcurrentItems })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(name + " precisa ser inteiro positivo.");
    }
  }

  let claimed = 0;
  let claimCalls = 0;
  let activeClaims = 0;
  let peakClaimed = 0;
  let drained = false;
  let interrupted = false;
  let firstError: unknown = null;
  let claimQueue: Promise<void> = Promise.resolve();

  function reserve(limit: number): Promise<T[]> {
    const pending = claimQueue.then(async () => {
      if (drained || interrupted || claimed >= maxItems || input.canClaim?.() === false) {
        return [] as T[];
      }
      const count = Math.min(limit, maxItems - claimed);
      const items = await claim(count);
      claimCalls++;
      if (items.length > count) {
        throw new RangeError("Claim retornou mais itens que o limite reservado.");
      }
      claimed += items.length;
      activeClaims += items.length;
      peakClaimed = Math.max(peakClaimed, activeClaims);
      if (items.length < count) drained = true;
      return items;
    });
    // Reserva serializada inclusive quando uma das consultas falha.
    claimQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // Um unico acesso ao banco pode preencher todas as vagas iniciais.
  const initial = await reserve(Math.min(maxConcurrentItems, maxItems));
  await Promise.all(initial.map(async (firstItem) => {
    let item = firstItem;
    while (true) {
      // Todo item ja reservado deve ser concluido (ou falhar) antes de sair.
      try {
        await process(item);
      } catch (error) {
        interrupted = true;
        firstError ??= error;
      } finally {
        activeClaims--;
      }
      if (interrupted) return;

      let next: T[];
      try {
        next = await reserve(1);
      } catch (error) {
        interrupted = true;
        firstError ??= error;
        return;
      }
      if (next.length === 0) return;
      item = next[0]!;
    }
  }));

  if (firstError) throw firstError;
  return { claimed, claimCalls, peakClaimed, drained };
}

/**
 * Nao comeca a fila de retentativas enquanto houver itens da primeira
 * passagem em andamento. O limite por ciclo e compartilhado entre fases;
 * os limites de tempo, tentativas e reserva sao mantidos pelo chamador.
 */
export async function runContinuousTwoPassWindow<T>(input: {
  maxItems: number;
  maxConcurrentItems: number;
  canClaim?: () => boolean;
  claimPrimary: (limit: number) => Promise<T[]>;
  claimRetry: (limit: number) => Promise<T[]>;
  process: (item: T) => Promise<void>;
}): Promise<{
  claimed: number;
  primaryClaimed: number;
  retryClaimed: number;
  claimCalls: number;
  peakClaimed: number;
  primaryDrained: boolean;
}> {
  const primary = await runContinuousClaimedItems({
    maxItems: input.maxItems,
    maxConcurrentItems: input.maxConcurrentItems,
    canClaim: input.canClaim,
    claim: input.claimPrimary,
    process: input.process
  });

  const remaining = input.maxItems - primary.claimed;
  const retry = primary.drained && remaining > 0 && input.canClaim?.() !== false
    ? await runContinuousClaimedItems({
        maxItems: remaining,
        maxConcurrentItems: input.maxConcurrentItems,
        canClaim: input.canClaim,
        claim: input.claimRetry,
        process: input.process
      })
    : null;

  return {
    claimed: primary.claimed + (retry?.claimed ?? 0),
    primaryClaimed: primary.claimed,
    retryClaimed: retry?.claimed ?? 0,
    claimCalls: primary.claimCalls + (retry?.claimCalls ?? 0),
    peakClaimed: Math.max(primary.peakClaimed, retry?.peakClaimed ?? 0),
    primaryDrained: primary.drained
  };
}
