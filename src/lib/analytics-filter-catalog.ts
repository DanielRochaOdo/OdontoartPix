import {
  getAssociadosCardFilterOptions,
  type AssociadosFilterOptions
} from "@/lib/associados-paginated";
import type { AnalyticsPerfTrace } from "@/lib/analytics-performance";

// Cache only the common, unfiltered catalog of options used by Visao Analitica.
// Transactional metrics, grouped results and invoice pages are NEVER cached.
export const ANALYTICS_FILTER_CATALOG_TTL_MS = 3 * 60 * 1000;

/**
 * One in-flight refresh per app process, with TTL starting after the successful
 * refresh. A failed refresh is never cached and the next request can retry.
 * Every process owns its own copy; up to 3 minutes of catalog staleness is accepted.
 */
export function createAnalyticsCatalogCache<T>(
  load: (trace?: AnalyticsPerfTrace | null) => Promise<T>,
  ttlMs = ANALYTICS_FILTER_CATALOG_TTL_MS,
  now: () => number = Date.now
) {
  let cached: { value: T; expiresAt: number } | null = null;
  let pending: Promise<T> | null = null;

  return {
    get(trace?: AnalyticsPerfTrace | null): Promise<T> {
      if (cached && now() < cached.expiresAt) {
        const value = cached.value;
        return trace
          ? trace.measure("catalog_cache_hit", async () => value)
          : Promise.resolve(value);
      }

      if (pending) {
        const work = pending;
        return trace ? trace.measure("catalog_inflight_wait", () => work) : work;
      }

      const work = load(trace).then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      });
      // Clearing on both resolve and reject preserves the ability to retry.
      pending = work;
      void work.then(
        () => { if (pending === work) pending = null; },
        () => { if (pending === work) pending = null; }
      );

      return trace ? trace.measure("catalog_cache_miss", () => work) : work;
    }
  };
}

const sharedCatalog = createAnalyticsCatalogCache<AssociadosFilterOptions>(
  (trace) => getAssociadosCardFilterOptions({}, trace)
);

export function getAnalyticsFilterCatalog(trace?: AnalyticsPerfTrace | null) {
  return sharedCatalog.get(trace);
}
