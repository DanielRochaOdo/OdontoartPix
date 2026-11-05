// Separa as consultas externas da persistencia sem ampliar o bloco ja
// reclamado pelo worker. O limite de resultados e validado na entrada:
// nenhuma consulta adicional e criada fora do buffer configurado.
export type ConsultationOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "failure"; error: unknown };

type BufferedResult<TItem, TResult> = {
  item: TItem;
  outcome: ConsultationOutcome<TResult>;
};

export async function runSplitProcessingPipeline<TItem, TResult>(input: {
  items: readonly TItem[];
  consultationConcurrency: number;
  persistenceConcurrency: number;
  maxBufferedResults: number;
  consult: (item: TItem) => Promise<TResult>;
  persist: (item: TItem, outcome: ConsultationOutcome<TResult>) => Promise<void>;
}): Promise<void> {
  const { items, consult, persist } = input;
  if (items.length === 0) return;

  // O worker limita claimLimit por maxBufferedResults antes de reclamar itens.
  // Falhar de forma explicita se outro chamador violar esse contrato.
  if (!Number.isInteger(input.maxBufferedResults) || items.length > input.maxBufferedResults) {
    throw new RangeError("O bloco excedeu PROCESSING_MAX_BUFFERED_RESULTS.");
  }

  const consultationConcurrency = Math.max(
    1, Math.min(Math.floor(input.consultationConcurrency), items.length)
  );
  const persistenceConcurrency = Math.max(
    1, Math.min(Math.floor(input.persistenceConcurrency), items.length)
  );

  const ready: BufferedResult<TItem, TResult>[] = [];
  const waitingConsumers: Array<() => void> = [];
  const persistenceErrors: unknown[] = [];
  let nextItem = 0;
  let consultationsDone = false;

  function wakeConsumers() {
    for (const notify of waitingConsumers.splice(0)) notify();
  }

  async function takeNext(): Promise<BufferedResult<TItem, TResult> | null> {
    while (ready.length === 0) {
      if (consultationsDone) return null;
      await new Promise<void>((resolve) => waitingConsumers.push(resolve));
    }
    return ready.shift()!;
  }

  // Consumidores ficam ativos desde a primeira consulta concluida. Um erro de
  // persistencia nao abandona os outros registros ja reclamados: todos recebem
  // uma tentativa, e a falha e propagada ao worker depois de drenar a fila.
  const persistenceWorkers = Array.from({ length: persistenceConcurrency }, async () => {
    while (true) {
      const next = await takeNext();
      if (!next) return;
      try {
        await persist(next.item, next.outcome);
      } catch (error) {
        persistenceErrors.push(error);
      }
    }
  });

  const consultationWorkers = Array.from({ length: consultationConcurrency }, async () => {
    while (true) {
      const index = nextItem++;
      if (index >= items.length) return;
      const item = items[index]!;
      let outcome: ConsultationOutcome<TResult>;
      try {
        outcome = { kind: "success", value: await consult(item) };
      } catch (error) {
        // Um erro de ERP ainda precisa passar pela persistencia de falha,
        // para respeitar retries, ownership, contadores e auditoria.
        outcome = { kind: "failure", error };
      }
      ready.push({ item, outcome });
      wakeConsumers();
    }
  });

  try {
    await Promise.all(consultationWorkers);
  } finally {
    consultationsDone = true;
    wakeConsumers();
    await Promise.all(persistenceWorkers);
  }

  if (persistenceErrors.length > 0) throw persistenceErrors[0];
}
