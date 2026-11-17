import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalyticsExportRows, getAnalyticsReport, readAnalyticsFilters, ANALYTICS_PAGE_SIZE } from "@/lib/analytics-payments";
import type { AnalyticsPerfTrace } from "@/lib/analytics-performance";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/pool", () => ({ dbQuery: query }));

const metrics = {
  installmentCount: 1,
  memberCount: 1,
  paidAmountCents: 12500,
  averageTicketCents: 12500,
  onTimeCount: 1,
  lateCount: 0,
  punctualityUnavailable: 0,
  averageLateDays: null,
  hourUnavailable: 0,
  hourBetween: 0
};
const groups = [{ kind: "hour", key: "10-12", count: 1, amountCents: 12500 }];
const invoices = [{
  id: "unique-canonical-installment", memberId: "member", memberName: "Teste",
  paidAmountCents: 12500, hourBucket: "10-12"
}];

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('as "installmentCount"')) return { rows: [metrics] };
    if (sql.includes("select kind, key, count(*)::int")) return { rows: groups };
    if (sql.includes('select id, member_id as "memberId"')) return { rows: invoices };
    throw new Error("Unexpected analytics SQL query");
  });
});

function args(tab: string) {
  return readAnalyticsFilters({
    from: "2026-11-01", to: "2026-11-17", tab,
    batch: [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    ],
    query: "pagamento pix"
  });
}

function capturedSql() {
  return query.mock.calls.map(([sql]) => String(sql));
}

function captureStages(): { trace: AnalyticsPerfTrace; stages: string[] } {
  const stages: string[] = [];
  return {
    trace: {
      async measure<T>(stage: string, operation: () => Promise<T>): Promise<T> {
        stages.push(stage);
        return operation();
      }
    },
    stages
  };
}

describe("Visao Analitica: seletividade SQL por aba", () => {
  it.each(["panorama", "horarios", "comportamento", "comparativos"])(
    "na aba %s executa somente metricas e agrupamentos, sem buscar faturas",
    async (tab) => {
      const { trace, stages } = captureStages();
      const report = await getAnalyticsReport(args(tab), trace);

      expect(query).toHaveBeenCalledTimes(2);
      expect(stages).toEqual(["metrics", "groups"]);
      expect(capturedSql().some((sql) => sql.includes('as "installmentCount"'))).toBe(true);
      expect(capturedSql().some((sql) => sql.includes("select kind, key, count(*)::int"))).toBe(true);
      expect(capturedSql().every((sql) => !sql.includes('select id, member_id as "memberId"'))).toBe(true);
      expect(report.metrics).toEqual(metrics);
      expect(report.groups).toEqual(groups);
      expect(report.rows).toEqual([]);
      expect(report.pageSize).toBe(ANALYTICS_PAGE_SIZE);
      expect(query.mock.calls[0]![1][1]).toEqual(args(tab).batch);
      expect(query.mock.calls[1]![1][2]).toBe("pagamento pix");
    }
  );

  it("na aba faturas executa somente metricas e pagina, sem buscar agrupamentos", async () => {
    const { trace, stages } = captureStages();
    const filters = args("faturas");
    filters.page = 3;

    const report = await getAnalyticsReport(filters, trace);

    expect(query).toHaveBeenCalledTimes(2);
    expect(stages).toEqual(["metrics", "page"]);
    expect(capturedSql().some((sql) => sql.includes('as "installmentCount"'))).toBe(true);
    expect(capturedSql().some((sql) => sql.includes('select id, member_id as "memberId"'))).toBe(true);
    expect(capturedSql().every((sql) => !sql.includes("select kind, key, count(*)::int"))).toBe(true);
    expect(report.metrics).toEqual(metrics);
    expect(report.groups).toEqual([]);
    expect(report.rows).toEqual(invoices);
    expect(report.page).toBe(3);
    expect(report.pageSize).toBe(ANALYTICS_PAGE_SIZE);
    expect(query.mock.calls[1]![1].slice(-2)).toEqual([ANALYTICS_PAGE_SIZE, 2 * ANALYTICS_PAGE_SIZE]);
  });

  it("a exportacao continua consultando todas as faturas, independente da aba", async () => {
    const result = await getAnalyticsExportRows(args("panorama"));
    expect(result).toEqual(invoices);
    expect(query).toHaveBeenCalledTimes(1);
    expect(capturedSql()[0]).toContain('select id, member_id as "memberId"');
    expect(query.mock.calls[0]![1].slice(-2)).toEqual([100001, 0]);
  });
});
