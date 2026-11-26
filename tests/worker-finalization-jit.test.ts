import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureWorkerFinalizationJit } from "@/lib/worker-finalization-jit";

const source = readFileSync(new URL("../src/lib/local-processing-worker.ts", import.meta.url), "utf8");
// Use the actual parameterized SQL, not a simplified copy of the production query.
const rawQueueSql = source.match(/const queue = await clientQuery<\{[\s\S]*?\}>\(\s*client,\s*\x60([\s\S]*?)\x60,\s*\[job\.batch_id, job\.include_errors, targetMemberLinkId, filteredErrorRequestId\]/)?.[1];
if (!rawQueueSql) throw new Error("Finalization queue SQL not found");
const queueSql: string = rawQueueSql;

it("049-B is opt-in and issues only a transaction-local setting", async () => {
  const query = vi.fn().mockResolvedValue({});
  const client = { query } as unknown as PoolClient;
  try {
    vi.stubEnv("PROCESSING_WORKER_FINALIZATION_JIT_OFF", undefined);
    await configureWorkerFinalizationJit(client);
    vi.stubEnv("PROCESSING_WORKER_FINALIZATION_JIT_OFF", "false");
    await configureWorkerFinalizationJit(client);
    expect(query).not.toHaveBeenCalled();
    vi.stubEnv("PROCESSING_WORKER_FINALIZATION_JIT_OFF", "true");
    await configureWorkerFinalizationJit(client);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SET LOCAL jit = off", []);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the legacy recalc and configures JIT inside the finalization transaction", () => {
  expect(source).toMatch(/async function releaseAndFinalizeJob\([\s\S]*?return withTransaction\(async \(client\) => \{[\s\S]*?await configureWorkerFinalizationJit\(client\);\s*const queue = await clientQuery/);
  expect(source).toContain("await recalculateBatch(job.batch_id);");
});

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;
describeDb("049-B PostgreSQL finalization: isolated temporary fixtures", () => {
  let pool: Pool;
  let client: PoolClient;
  const batch = "00000000-0000-0000-0000-000000000001";
  const replay = "00000000-0000-0000-0000-000000000003";
  const memberId = (n: number) => "10000000-0000-0000-0000-" + String(n).padStart(12, "0");

  beforeAll(async () => {
    // Never connect to an externally supplied or production host.
    expect(process.env.DATABASE_HOST).toBe("127.0.0.1");
    expect(process.env.DATABASE_NAME).toBe("odontoart_pix_ci");
    pool = new Pool({
      host: "127.0.0.1", port: Number(process.env.DATABASE_PORT ?? "5432"),
      database: "odontoart_pix_ci", user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD, ssl: false, max: 1
    });
    client = await pool.connect();
    expect((await client.query("select current_database() db")).rows[0].db).toBe("odontoart_pix_ci");
    await client.query("SET statement_timeout = '30s'");
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET jit = on");
    await client.query("CREATE TEMP TABLE member_target_installments (id uuid PRIMARY KEY, payment_status text)");
    await client.query("CREATE TEMP TABLE campaign_batch_members (id uuid PRIMARY KEY, batch_id uuid NOT NULL, target_installment_ref_id uuid, payment_status text, processing_status text, processing_attempts int, max_attempts int, next_check_at timestamptz, next_retry_at timestamptz, error_reprocess_requested_at timestamptz, deleted_at timestamptz)");
    await client.query("CREATE INDEX ON campaign_batch_members (batch_id) WHERE deleted_at IS NULL");
    await client.query("CREATE TEMP TABLE filtered_error_reprocess_items (request_id uuid, member_link_id uuid, status text, PRIMARY KEY(request_id,member_link_id))");
    // Same names resolve to temporary relations first; never mutate public fixtures.
    await client.query("INSERT INTO pg_temp.member_target_installments SELECT md5(n::text)::uuid, CASE WHEN n=2 THEN 'paid' WHEN n=8 THEN NULL ELSE 'unpaid' END FROM generate_series(1,12) n WHERE n<>5");
    await client.query(
      "INSERT INTO pg_temp.campaign_batch_members SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid, CASE WHEN n=12 THEN md5('other')::uuid ELSE $1::uuid END, md5(n::text)::uuid, CASE WHEN n IN (5,8) THEN NULL WHEN n=7 THEN 'paid' ELSE 'unpaid' END, CASE WHEN n=3 THEN 'processing' WHEN n IN (4,5) THEN 'retrying' WHEN n=6 THEN 'error' ELSE 'pending' END, CASE WHEN n=9 THEN 3 ELSE 0 END, 3, CASE WHEN n=10 THEN '2099-01-01'::timestamptz END, CASE WHEN n=4 THEN '2020-01-01'::timestamptz WHEN n=5 THEN '2099-01-01'::timestamptz END, CASE WHEN n=6 THEN '2020-01-01'::timestamptz END, CASE WHEN n=11 THEN now() END FROM generate_series(1,12) n",
      [batch]
    );
    await client.query("INSERT INTO pg_temp.filtered_error_reprocess_items VALUES ($1,$2,'queued'),($1,$3,'processing'),($1,$4,'completed')", [replay,memberId(1),memberId(3),memberId(4)]);
  }, 30000);

  afterAll(async () => {
    if (client) { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
    if (pool) await pool.end();
  });

  it("restores session JIT after commit and rollback, and preserves all parameterized results", async () => {
    const cases: { params: unknown[]; immediate: number; processing: number; retry: boolean }[] = [
      { params: [batch,false,null,null], immediate:3, processing:1, retry:true },
      { params: [batch,true,null,null], immediate:4, processing:1, retry:true },
      { params: [batch,false,memberId(4),null], immediate:1, processing:0, retry:true },
      { params: [batch,true,null,replay], immediate:1, processing:1, retry:false },
      { params: [batch,false,memberId(2),null], immediate:0, processing:0, retry:false },
      { params: [md5Empty(),false,null,null], immediate:0, processing:0, retry:false }
    ];
    function md5Empty() { return "00000000-0000-0000-0000-000000000099"; }
    for (const [i, scenario] of cases.entries()) {
      await client.query("BEGIN READ ONLY");
      try {
        await configureWorkerFinalizationJit(client, false);
        expect((await client.query("SHOW jit")).rows[0].jit).toBe("on");
        const before = (await client.query(queueSql, scenario.params)).rows[0];
        await configureWorkerFinalizationJit(client, true);
        expect((await client.query("SHOW jit")).rows[0].jit).toBe("off");
        const after = (await client.query(queueSql, scenario.params)).rows[0];
        expect(after).toEqual(before);
        expect(after.immediate_count).toBe(scenario.immediate);
        expect(after.processing_count).toBe(scenario.processing);
        expect(after.next_retry_at).toBe(scenario.retry ? "2020-01-01 00:00:00+00" : null);
        await client.query(i % 2 === 0 ? "COMMIT" : "ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      expect((await client.query("SHOW jit")).rows[0].jit).toBe("on");
    }
  }, 30000);

  it("measures alternating JIT modes on representative row counts (query-only synthetic benchmark)", async () => {
    await client.query("TRUNCATE pg_temp.campaign_batch_members, pg_temp.member_target_installments, pg_temp.filtered_error_reprocess_items");
    await client.query("INSERT INTO pg_temp.member_target_installments SELECT md5(n::text)::uuid, CASE WHEN n%8=0 THEN 'paid' ELSE 'unpaid' END FROM generate_series(1,78293) n");
    await client.query("INSERT INTO pg_temp.campaign_batch_members SELECT md5('link-'||n)::uuid,$1::uuid,md5(n::text)::uuid,CASE WHEN n%8=0 THEN 'paid' ELSE 'unpaid' END,CASE WHEN n%11=0 THEN 'retrying' WHEN n%13=0 THEN 'processing' ELSE 'pending' END,0,3,NULL,CASE WHEN n%11=0 THEN '2020-01-01'::timestamptz END,NULL,NULL FROM generate_series(1,20014) n", [batch]);
    await client.query("ANALYZE pg_temp.member_target_installments");
    await client.query("ANALYZE pg_temp.campaign_batch_members");
    const params = [batch,false,null,null];
    const reference = (await client.query(queueSql, params)).rows;
    const results: { mode:string; executionMs:number; planningMs:number; jitPresent:boolean; jitMs:number|null; sharedHit:number; localHit:number; localRead:number }[] = [];
    for (const enabled of [false,true,true,false,false,true,true,false]) {
      await client.query("BEGIN READ ONLY");
      try {
        await configureWorkerFinalizationJit(client, enabled);
        expect((await client.query(queueSql, params)).rows).toEqual(reference);
        const p = (await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + queueSql, params)).rows[0]["QUERY PLAN"][0];
        if (enabled) expect(p.JIT).toBeUndefined();
        results.push({ mode:enabled?"off":"on", executionMs:p["Execution Time"], planningMs:p["Planning Time"], jitPresent:Boolean(p.JIT), jitMs:p.JIT?.Timing?.Total??null, sharedHit:p.Plan["Shared Hit Blocks"]??0, localHit:p.Plan["Local Hit Blocks"]??0, localRead:p.Plan["Local Read Blocks"]??0 });
      } finally { await client.query("ROLLBACK"); }
    }
    console.info("[049_B_QUERY_BENCHMARK]", JSON.stringify({scope:"temporary simplified tables; exact parameterized query; excludes worker, writes, ERP and full-sync benchmark", canonical:78293, links:20014, results}));
    expect(results).toHaveLength(8);
  }, 120000);
});
