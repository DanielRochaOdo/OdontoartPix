export type ProcessingProgressCounters = {
  totalItems: number;
  processedItems: number;
  successItems: number;
  errorItems: number;
};

export function normalizeProcessingProgress(
  counters: ProcessingProgressCounters
): ProcessingProgressCounters {
  const totalItems = Math.max(0, Math.trunc(counters.totalItems));
  const successItems = Math.min(totalItems, Math.max(0, Math.trunc(counters.successItems)));
  const errorItems = Math.min(
    Math.max(0, totalItems - successItems),
    Math.max(0, Math.trunc(counters.errorItems))
  );

  return {
    totalItems,
    processedItems: Math.min(totalItems, successItems + errorItems),
    successItems,
    errorItems
  };
}
