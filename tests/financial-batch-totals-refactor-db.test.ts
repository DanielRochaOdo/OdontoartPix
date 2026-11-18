import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;
type Fixture = { campaign: string; batches: string[]; members: string[]; links: string[][] };
const totalsSql = `select total_records, processed_records, paid_records, unpaid_records,
  error_records, total_pending_amount_cents::text as pending, total_amount_cents::text as amount, status
  from campaign_batches where id = any($1::uuid[]) order by id`;

describeDatabase("totais canonicos agrupados e transacoes concorrentes reais", () => {
  let pool: Pool;
  const fixtures: Fixture[] = [];

  beforeAll(() => {
    const host = process.env.DATABASE_HOST ?? "";
    const database = process.env.DATABASE_NAME ?? "";
    if (!["127.0.0.1", "localhost", "::1"].includes(host) || !/(?:^|_)(?:test|tests|ci)(?:_|$)/.test(database)) {
      throw new Error("Este teste exige banco de testes dedicado em localhost.");
    }
    pool = new Pool({ host, database, port: Number(process.env.DATABASE_PORT ?? 5432),
      user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, ssl: false,
      max: 4, connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000" });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const f of fixtures) {
        await pool.query("delete from campaigns where id=$1", [f.campaign]);
        await pool.query("delete from members where id=any($1::uuid[])", [f.members]);
      }
    } finally { await pool.end(); }
  });

  async function fixture(): Promise<Fixture> {
    const client = await pool.connect();
    const f: Fixture = { campaign: randomUUID(), batches: [randomUUID(), randomUUID()], members: [randomUUID(), randomUUID()], links: [[], []] };
    const tag = randomUUID();
    await client.query("begin");
    try {
      await client.query("insert into campaigns(id,name) values($1,$2)", [f.campaign, `Concurrent ${tag}`]);
      for (let b = 0; b < f.batches.length; b++) {
        await client.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,$3)", [f.batches[b], f.campaign, `Batch ${b} ${tag}`]);
      }
      for (let m = 0; m < f.members.length; m++) {
        await client.query("insert into members(id,cpf,cpf_hash,name) values($1,$2,$3,$4)", [f.members[m], `LAB${m}`, `${tag}-${m}`, `Lab ${m}`]);
        for (const batch of f.batches) {
          const result = await client.query<{ id: string }>(`insert into campaign_batch_members(
            campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,
            payment_status,payment_status_source,total_pending_amount_cents,processing_status)
            values($1,$2,$3,'LAB-1',10000,'unpaid','erp_open_invoice',10000,'completed') returning id`, [f.campaign, batch, f.members[m]]);
          f.links[m].push(result.rows[0].id);
        }
      }
      await client.query("select recalculate_batch_totals_many($1::uuid[])", [f.batches]);
      await client.query("commit");
      fixtures.push(f);
      return f;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async function pay(client: PoolClient, link: string, amount: number) {
    await client.query(`update campaign_batch_members set processing_status='completed',
      payment_status='paid',payment_status_source='erp_explicit',payment_amount_cents=$2::bigint,
      total_pending_amount_cents=10000-$2::bigint,last_erp_status_at=clock_timestamp() where id=$1`, [link, amount]);
  }

  async function waitForLock(observer: PoolClient, waiting: number, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>(
        "select $2::int=any(pg_blocking_pids($1::int)) as waiting", [waiting, blocker]);
      if (result.rows[0].waiting) return;
      await delay(20);
    }
    throw new Error("A segunda transacao nao esperou pela primeira; teste sem sobreposicao.");
  }

  it.each([false, true])("mantem totais exatos depois de espera real (rollback=%s)", async rollback => {
    const f = await fixture();
    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const a = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      const b = (await second.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      await first.query("begin isolation level read committed");
      await second.query("begin isolation level read committed");
      await pay(first, f.links[0][0], 10000);
      // Capture rejection immediately; the observer establishes genuine overlap.
      pending = pay(second, f.links[1][0], 6000).then(() => null, error => error);
      await waitForLock(observer, b, a);
      await first.query(rollback ? "rollback" : "commit");
      const failure = await pending;
      if (failure) throw failure;
      await second.query("commit");
      // No final repair or worker recalc: inspect exactly what both commits left.
      const { rows } = await observer.query(totalsSql, [f.batches]);
      expect(rows).toEqual(Array.from({ length: 2 }, () => ({
        total_records: 2, processed_records: 2, paid_records: rollback ? 1 : 2,
        unpaid_records: rollback ? 1 : 0, error_records: 0,
        pending: rollback ? "14000" : "4000", amount: "20000", status: "concluido"
      })));
    } finally {
      await first.query("rollback").catch(() => undefined);
      await pending;
      await second.query("rollback").catch(() => undefined);
      first.release(); second.release(); observer.release();
    }
  }, 25000);

  it("protege a mesma parcela contra resposta antiga recebida por outro vinculo concorrente", async () => {
    const f = await fixture();
    await pool.query(`update campaign_batch_members set processing_status='processing',
      claimed_at=clock_timestamp()-interval '1 minute' where id=any($1::uuid[])`, [f.links[0]]);
    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const a = (await first.query("select pg_backend_pid() as pid")).rows[0].pid;
      const b = (await second.query("select pg_backend_pid() as pid")).rows[0].pid;
      await first.query("begin isolation level read committed");
      await second.query("begin isolation level read committed");
      // Both workers own different links of the same canonical installment.
      await second.query("select id from campaign_batch_members where id=$1 for update", [f.links[0][1]]);
      await pay(first, f.links[0][0], 10000);
      pending = second.query(`update campaign_batch_members set processing_status='completed',
        payment_status='unpaid',payment_status_source='erp_open_invoice',payment_amount_cents=0,
        total_pending_amount_cents=10000,last_erp_status_at=clock_timestamp() where id=$1`, [f.links[0][1]])
        .then(() => null, error => error);
      await waitForLock(observer, b, a);
      await first.query("commit");
      const failure = await pending;
      if (failure) throw failure;
      await second.query("commit");
      const links = await observer.query("select payment_status,total_pending_amount_cents::text as pending from campaign_batch_members where id=any($1::uuid[])", [f.links[0]]);
      expect(links.rows).toEqual([{ payment_status: "paid", pending: "0" }, { payment_status: "paid", pending: "0" }]);
      expect((await observer.query(totalsSql, [f.batches])).rows.every(r => r.paid_records === 1 && r.pending === "10000")).toBe(true);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await pending;
      await second.query("rollback").catch(() => undefined);
      first.release(); second.release(); observer.release();
    }
  }, 25000);

  it("repara todos os lotes mesmo sem alteracao nos vinculos; a segunda chamada e idempotente", async () => {
    const f = await fixture();
    const target = await pool.query<{ id: string }>("select target_installment_ref_id as id from campaign_batch_members where id=$1", [f.links[0][0]]);
    await pool.query("update campaign_batches set total_records=99,total_amount_cents=99 where id=any($1::uuid[])", [f.batches]);
    await pool.query("select sync_target_installment_links_v1($1)", [target.rows[0].id]);
    const before = await pool.query("select id,ctid::text,updated_at from campaign_batches where id=any($1::uuid[]) order by id", [f.batches]);
    expect((await pool.query(totalsSql, [f.batches])).rows.every(r => r.total_records === 2 && r.amount === "20000")).toBe(true);
    await pool.query("select recalculate_batch_totals_many($1::uuid[])", [[...f.batches, f.batches[0], null, randomUUID()]]);
    const after = await pool.query("select id,ctid::text,updated_at from campaign_batches where id=any($1::uuid[]) order by id", [f.batches]);
    expect(after.rows).toEqual(before.rows);
    await pool.query("select recalculate_batch_totals_many(null::uuid[]), recalculate_batch_totals_many('{}'::uuid[])");
  });

  it.each([
    ["pending", "aguardando"], ["queued", "aguardando"], ["retrying", "aguardando"],
    ["processing", "processando"], ["error", "concluido_com_erros"],
    ["completed", "concluido"], ["failed", "aguardando"]
  ])("preserva status de lote para %s", async (processing, expected) => {
    const f = await fixture();
    await pool.query("update campaign_batch_members set processing_status=$2 where id=any($1::uuid[])", [f.links.flat(), processing]);
    await pool.query("select recalculate_batch_totals_many($1::uuid[])", [f.batches]);
    expect((await pool.query(totalsSql, [f.batches])).rows.map(r => r.status)).toEqual([expected, expected]);
  });

  it("preserva prioridade processing > waiting > errors, exclusao logica e lote vazio aguardando", async () => {
    const f = await fixture();
    await pool.query("update campaign_batch_members set processing_status='error' where id=any($1::uuid[])", [f.links[0]]);
    await pool.query("update campaign_batch_members set processing_status='pending' where id=any($1::uuid[])", [f.links[1]]);
    await pool.query("select recalculate_batch_totals_many($1::uuid[])", [f.batches]);
    expect((await pool.query(totalsSql, [f.batches])).rows.every(r => r.status === "aguardando")).toBe(true);
    await pool.query("update campaign_batch_members set processing_status='processing' where id=any($1::uuid[])", [f.links[0]]);
    await pool.query("select recalculate_batch_totals_many($1::uuid[])", [f.batches]);
    expect((await pool.query(totalsSql, [f.batches])).rows.every(r => r.status === "processando")).toBe(true);
    await pool.query("update campaign_batch_members set deleted_at=now() where id=any($1::uuid[])", [f.links.flat()]);
    await pool.query("select recalculate_batch_totals_many($1::uuid[])", [f.batches]);
    expect((await pool.query(totalsSql, [f.batches])).rows).toEqual(Array.from({ length: 2 }, () => ({
      total_records: 0, processed_records: 0, paid_records: 0, unpaid_records: 0,
      error_records: 0, pending: "0", amount: "0", status: "aguardando"
    })));
  });

  it("usa o canonico mesmo com vinculo em processamento e preserva valor nominal de acordada/excluida", async () => {
    const f = await fixture();
    await pool.query("update campaign_batch_members set processing_status='processing' where id=any($1::uuid[])", [[f.links[0][1], f.links[1][1]]]);
    for (const [i, status] of ["agreed", "excluded"].entries()) {
      await pool.query(`update campaign_batch_members set processing_status='completed',payment_status=$2,
        payment_status_source=$3,payment_amount_cents=0,total_pending_amount_cents=0,last_erp_status_at=clock_timestamp()
        where id=$1`, [f.links[i][0], status, `erp_${status}`]);
    }
    const { rows } = await pool.query(totalsSql, [f.batches]);
    expect(rows.every(r => r.amount === "20000" && r.pending === "0" && r.paid_records === 0 && r.unpaid_records === 0)).toBe(true);
    expect(rows.map(r => r.status).sort()).toEqual(["concluido", "processando"]);
    expect((await pool.query("select processing_status from campaign_batch_members where id=any($1::uuid[])", [[f.links[0][1], f.links[1][1]]])).rows.every(r => r.processing_status === "processing")).toBe(true);
  });
});
