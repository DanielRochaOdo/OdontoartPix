import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;

describe("canonical deletion route", () => {
  it("uses the centralized calculation in the same transaction", () => {
    const source = readFileSync("src/app/api/associados/[id]/route.ts", "utf8");
    expect(source).toContain("await recalculateBatch(member.batch_id, client)");
    expect(source).not.toContain("with totals as (");
  });
});

describeDb("047 incremental shadow totals", () => {
  const pool = new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 4
  });
  const campaign = randomUUID();
  const member = randomUUID();
  const batches = [randomUUID(), randomUUID(), randomUUID()];
  const code = "SHADOW-" + randomUUID();
  const links: string[] = [];
  let target = "";

  async function audit(checkOfficial = false) {
    const result = await pool.query(
      `select * from public.batch_totals_shadow_audit_v1
         where batch_id=any($1::uuid[]) or orphan_batch`, [batches]);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every(r => r.enabled && !r.shadow_differs && !r.orphan_batch)).toBe(true);
    if (checkOfficial) expect(result.rows.every(r => !r.official_differs)).toBe(true);
    expect((await pool.query("select * from public.batch_totals_shadow_dirty")).rowCount).toBe(0);
    expect((await pool.query("select * from public.batch_totals_shadow_transactions")).rowCount).toBe(0);
  }
  async function recalc() {
    await pool.query("select public.recalculate_batch_totals_many($1::uuid[])", [batches]);
  }
  beforeAll(async () => {
    expect((await pool.query("select enabled from public.batch_totals_shadow_state")).rows[0].enabled).toBe(false);
    await pool.query("insert into campaigns(id,name,status) values($1,$2,'rascunho')", [campaign, code]);
    await pool.query("insert into members(id,cpf,cpf_hash,name) values($1,$2,$3,$4)", [member, code.slice(-11), code, code]);
    for (const [index,batch] of batches.entries()) {
      await pool.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,$3)", [batch,campaign,code+index]);
    }
    for (const batch of batches.slice(0,2)) {
      const { rows } = await pool.query(
        `insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,
          installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status)
         values($1,$2,$3,$4,10000,'unpaid','erp_open_invoice',10000,'pending')
         returning id,target_installment_ref_id`, [campaign,batch,member,code]);
      links.push(rows[0].id);
      target = rows[0].target_installment_ref_id;
    }
    expect((await pool.query("select * from public.batch_totals_shadow_contributions")).rowCount).toBe(0);
    await recalc();
    await pool.query("select public.set_batch_totals_shadow_v1(true)");
  }, 20000);
  afterAll(async () => {
    try {
      await pool.query("select public.set_batch_totals_shadow_v1(false)");
      await pool.query("delete from campaigns where id=$1", [campaign]);
      await pool.query("delete from members where id=$1", [member]);
    } finally { await pool.end(); }
  }, 20000);

  it("bootstraps without touching official totals; tracks direct operational writes", async () => {
    await audit(true);
    await pool.query("update campaign_batch_members set processing_status='processing' where id=$1", [links[1]]);
    await audit();
    // Official totals are deliberately NOT replaced by shadow.
    expect((await pool.query("select official_differs from public.batch_totals_shadow_audit_v1 where batch_id=$1", [batches[1]])).rows[0].official_differs).toBe(true);
    await recalc();
    await audit(true);
  });

  it("uses canonical residual even for a sibling still processing; no-op is idempotent", async () => {
    await pool.query(`update campaign_batch_members set payment_status='paid',payment_status_source='erp_explicit',
      payment_amount_cents=3000,total_pending_amount_cents=7000,processing_status='completed',
      last_erp_status_at=clock_timestamp() where id=$1`, [links[0]]);
    await audit(true);
    const read = async () => (await pool.query(
      "select *,ctid::text as tuple_id from public.batch_totals_shadow_contributions where member_link_id=any($1::uuid[]) order by member_link_id", [links])).rows;
    const before = await read();
    expect(before).toHaveLength(2);
    expect(before.every(r => r.paid_records === "1" && r.total_pending_amount_cents === "7000")).toBe(true);
    expect(before.some(r => r.processing_records === "1")).toBe(true);
    await pool.query("select public.sync_target_installment_links_v1($1)", [target]);
    expect(await read()).toEqual(before);
    await audit(true);
  });

  it("tracks logical deletion, restoration, transfer and physical cascade", async () => {
    await pool.query("update campaign_batch_members set deleted_at=now() where id=$1", [links[0]]);
    await audit();
    expect((await pool.query("select * from public.batch_totals_shadow_contributions where member_link_id=$1", [links[0]])).rowCount).toBe(0);
    await pool.query("update campaign_batch_members set deleted_at=null,batch_id=$2 where id=$1", [links[0],batches[2]]);
    await recalc();
    await audit(true);
    expect((await pool.query("select batch_id from public.batch_totals_shadow_contributions where member_link_id=$1", [links[0]])).rows[0].batch_id).toBe(batches[2]);
    await pool.query("delete from campaign_batches where id=$1", [batches[2]]);
    await audit();
    expect((await pool.query("select * from public.batch_totals_shadow_contributions where member_link_id=$1", [links[0]])).rowCount).toBe(0);
    expect((await pool.query("select * from public.batch_totals_shadow_totals where batch_id=$1", [batches[2]])).rowCount).toBe(0);
  });

  it("rolls back sources, dirty queue and flushed contributions together", async () => {
    const c = await pool.connect();
    try {
      const before = (await c.query("select * from public.batch_totals_shadow_totals where batch_id=$1", [batches[1]])).rows;
      await c.query("begin");
      await c.query("update member_target_installments set pending_amount_cents=1234 where id=$1", [target]);
      await c.query("set constraints batch_totals_shadow_flush_at_commit immediate");
      expect((await c.query("select total_pending_amount_cents from public.batch_totals_shadow_totals where batch_id=$1", [batches[1]])).rows[0].total_pending_amount_cents).toBe("1234");
      await c.query("rollback");
      expect((await c.query("select * from public.batch_totals_shadow_totals where batch_id=$1", [batches[1]])).rows).toEqual(before);
    } finally { await c.query("rollback").catch(() => undefined); c.release(); }
    await audit();
  });

  it("serializes overlapping commits and sees the canonical change after waiting", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const a = (await first.query("select pg_backend_pid() pid")).rows[0].pid;
      const b = (await second.query("select pg_backend_pid() pid")).rows[0].pid;
      await first.query("begin");
      await second.query("begin");
      await first.query("select pg_advisory_xact_lock(20261124047::bigint)");
      await first.query("update member_target_installments set pending_amount_cents=4321 where id=$1", [target]);
      await second.query("update campaign_batch_members set deleted_at=now() where id=$1", [links[1]]);
      // Restore within the same transaction: dirty link remains deduplicated.
      await second.query("update campaign_batch_members set deleted_at=null where id=$1", [links[1]]);
      pending = second.query("commit").then(() => null, error => error);
      const deadline = Date.now()+5000;
      let waited = false;
      while (Date.now()<deadline) {
        waited = (await observer.query("select $2::int=any(pg_blocking_pids($1::int)) as waiting", [b,a])).rows[0].waiting;
        if (waited) break;
        await delay(20);
      }
      expect(waited).toBe(true);
      await first.query("commit");
      const failure = await pending;
      if (failure) throw failure;
      expect((await observer.query("select total_pending_amount_cents from public.batch_totals_shadow_totals where batch_id=$1", [batches[1]])).rows[0].total_pending_amount_cents).toBe("4321");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await pending;
      await second.query("rollback").catch(() => undefined);
      first.release(); second.release(); observer.release();
    }
    await recalc();
    await audit(true);
  }, 20000);

  it("rebuilds independently; disable removes only derived state", async () => {
    await pool.query("update public.batch_totals_shadow_totals set total_amount_cents=999 where batch_id=$1", [batches[1]]);
    expect((await pool.query("select shadow_differs from public.batch_totals_shadow_audit_v1 where batch_id=$1", [batches[1]])).rows[0].shadow_differs).toBe(true);
    await pool.query("select public.set_batch_totals_shadow_v1(true)");
    await audit(true);
    const before = (await pool.query("select * from campaign_batches where id=any($1::uuid[]) order by id", [batches])).rows;
    await pool.query("select public.set_batch_totals_shadow_v1(false)");
    expect((await pool.query("select * from public.batch_totals_shadow_contributions")).rowCount).toBe(0);
    expect((await pool.query("select * from campaign_batches where id=any($1::uuid[]) order by id", [batches])).rows).toEqual(before);
  });
});
