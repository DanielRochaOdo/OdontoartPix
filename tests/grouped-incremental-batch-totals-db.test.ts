import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;

describeDb("048 grouped incremental projection pilot", () => {
  const pool = new Pool({
    host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false, max: 4
  });
  const campaign = randomUUID(), member = randomUUID(), code = "PILOT048-" + randomUUID();
  const batches = [randomUUID(), randomUUID(), randomUUID()];
  let target = "";
  const links: string[] = [];
  let setup = false;
  const collect = async (c: PoolClient, ids = batches) => {
    await c.query("select set_config('odontoart.grouped_batch_totals','on',true)");
    await c.query("select public.collect_or_recalculate_batch_totals_v1($1::uuid[])", [ids]);
  };
  const audit = async () => {
    expect((await pool.query("select * from public.batch_totals_shadow_audit_v1 where shadow_differs or official_differs or orphan_batch")).rowCount).toBe(0);
    expect((await pool.query("select * from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution")).rowCount).toBe(0);
    for (const table of ["grouped_incremental_totals_pending","grouped_batch_totals_pending","batch_totals_shadow_dirty","batch_totals_shadow_transactions"]) {
      expect((await pool.query("select count(*)::int as n from public." + table)).rows[0].n).toBe(0);
    }
  };
  const totals = async (c: Pool | PoolClient = pool) => (await c.query(
    "select id,total_records,processed_records,paid_records,unpaid_records,error_records,total_amount_cents,total_pending_amount_cents,status from campaign_batches where id=any($1::uuid[]) order by id", [batches])).rows;

  beforeAll(async () => {
    expect((await pool.query("select enabled from public.grouped_incremental_totals_state")).rows[0].enabled).toBe(false);
    expect((await pool.query("select enabled from public.batch_totals_shadow_state")).rows[0].enabled).toBe(false);
    await pool.query("insert into campaigns(id,name,status) values($1,$2,'rascunho')", [campaign,code]);
    await pool.query("insert into members(id,cpf,cpf_hash,name) values($1,$2,$3,$4)", [member,code.slice(-11),code,code]);
    for (const [i,b] of batches.entries()) await pool.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,$3)",[b,campaign,code+i]);
    for (const b of batches.slice(0,2)) {
      const r=await pool.query(`insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,
        installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status)
        values($1,$2,$3,$4,10000,'unpaid','erp_open_invoice',10000,'pending')
        returning id,target_installment_ref_id`,[campaign,b,member,code]);
      links.push(r.rows[0].id); target=r.rows[0].target_installment_ref_id;
    }
    // Isolated CI only. Reconcile any pre-existing test fixture before global promotion.
    await pool.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
    await pool.query("select public.set_batch_totals_shadow_v1(true)");
    setup=true;
    await audit();
  }, 20000);
  afterAll(async () => {
    try {
      if (setup) {
        await pool.query("select public.set_grouped_incremental_totals_v1(false)");
        await pool.query("select public.set_batch_totals_shadow_v1(false)");
      }
      await pool.query("delete from campaigns where id=$1",[campaign]);
      await pool.query("delete from members where id=$1",[member]);
    } finally { await pool.end(); }
  }, 20000);

  it("keeps legacy 046 behavior with the pilot disabled", async () => {
    const c=await pool.connect();
    try {
      await c.query("begin");
      await collect(c);
      await c.query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
      await c.query("select public.flush_grouped_batch_totals_v2()");
      expect((await c.query("select total_records from campaign_batches where id=$1",[batches[0]])).rows[0].total_records).toBe(1);
      expect((await c.query("select count(*)::int n from public.grouped_incremental_totals_pending")).rows[0].n).toBe(0);
      await c.query("commit");
    } finally { await c.query("rollback").catch(()=>undefined);c.release(); }
    await audit();
  });

  it("rejects promotion of corrupted shadow and then enables a reconciled shadow", async () => {
    await pool.query("update public.batch_totals_shadow_totals set total_amount_cents=7 where batch_id=$1",[batches[0]]);
    await expect(pool.query("select public.set_grouped_incremental_totals_v1(true)")).rejects.toThrow(/fully reconciled/);
    await pool.query("select public.set_batch_totals_shadow_v1(true)");
    await pool.query("select public.set_grouped_incremental_totals_v1(true)");
    await expect(pool.query("select public.set_batch_totals_shadow_v1(false)")).rejects.toThrow(/Disable grouped incremental/);
    await audit();
  });

  it("projects shared partial payment only at commit and preserves empty batch", async () => {
    const c=await pool.connect();
    const before=await totals();
    try {
      await c.query("begin");
      await collect(c);
      await c.query(`update campaign_batch_members set payment_status='paid',payment_status_source='erp_explicit',
        payment_amount_cents=3000,total_pending_amount_cents=7000,processing_status='completed',
        last_erp_status_at=clock_timestamp() where id=$1`,[links[0]]);
      await c.query("select public.flush_grouped_batch_totals_v2()");
      expect((await c.query("select count(*)::int n from public.grouped_incremental_totals_pending")).rows[0].n).toBe(1);
      expect(await totals(c)).toEqual(before);
      await c.query("commit");
    } finally { await c.query("rollback").catch(()=>undefined);c.release(); }
    await audit();
    const after=await totals();
    expect(after.filter(r=>r.id!==batches[2]).every(r=>r.paid_records===1 && r.total_pending_amount_cents==="7000")).toBe(true);
    expect(after.find(r=>r.id===batches[2])).toMatchObject({total_records:0,status:"aguardando"});
  });

  it("repairs an explicit no-change request and rolls back queued projection atomically", async () => {
    const c=await pool.connect();
    try {
      await c.query("begin");
      await c.query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
      await collect(c);
      await c.query("select public.flush_grouped_batch_totals_v2()");
      await c.query("commit");
      await audit();
      const before=await totals();
      await c.query("begin");
      await collect(c);
      await c.query("update member_target_installments set pending_amount_cents=1234 where id=$1",[target]);
      await c.query("select public.flush_grouped_batch_totals_v2()");
      await c.query("rollback");
      expect(await totals()).toEqual(before);
    } finally { await c.query("rollback").catch(()=>undefined);c.release(); }
    await audit();
  });

  it("rejects premature projection and premature shadow serialization", async () => {
    const c=await pool.connect();
    try {
      await c.query("begin");
      await collect(c);
      await c.query("set constraints grouped_incremental_totals_project_at_commit immediate");
      await expect(c.query("select public.flush_grouped_batch_totals_v2()")).rejects.toThrow(/completed shadow/);
      await c.query("rollback");
      await c.query("begin");
      await collect(c);
      await c.query("select pg_advisory_xact_lock(20261124047::bigint)");
      await expect(c.query("select public.flush_grouped_batch_totals_v2()")).rejects.toThrow(/before batch locks/);
      await c.query("rollback");
    } finally { await c.query("rollback").catch(()=>undefined);c.release(); }
    await audit();
  });

  it("waits for the batch before acquiring the shadow lock, then projects the fresh total", async () => {
    const a=await pool.connect(), b=await pool.connect(), observer=await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const ap=(await a.query("select pg_backend_pid() pid")).rows[0].pid;
      const bp=(await b.query("select pg_backend_pid() pid")).rows[0].pid;
      await a.query("begin"); await b.query("begin");
      await collect(a); await collect(b);
      await a.query("update member_target_installments set pending_amount_cents=4321 where id=$1",[target]);
      await a.query("select public.flush_grouped_batch_totals_v2()");
      pending=b.query("select public.flush_grouped_batch_totals_v2()").then(()=>null,e=>e);
      const deadline=Date.now()+5000;
      let waiting=false;
      while(Date.now()<deadline){
        waiting=(await observer.query("select $2::int=any(pg_blocking_pids($1::int)) as waiting",[bp,ap])).rows[0].waiting;
        if(waiting)break;
        await delay(20);
      }
      expect(waiting).toBe(true);
      expect((await observer.query("select count(*)::int n from pg_locks where pid=$1 and locktype='advisory' and granted",[bp])).rows[0].n).toBe(0);
      await a.query("commit");
      const failure=await pending; if(failure)throw failure;
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(()=>undefined);
      await pending;
      await b.query("rollback").catch(()=>undefined);
      a.release();b.release();observer.release();
    }
    await audit();
    expect((await totals()).filter(r=>r.id!==batches[2]).every(r=>r.total_pending_amount_cents==="4321")).toBe(true);
  },20000);

  it("allows the limited runtime entry point but denies administrative state writes", async () => {
    const c=await pool.connect();
    const role="test_048_"+randomUUID().replaceAll("-","");
    let created=false;
    try {
      await c.query("create role "+role+" nologin");
      created=true;
      await c.query("grant usage on schema public to "+role);
      await c.query("grant execute on function public.try_grouped_incremental_totals_v1(),public.flush_grouped_batch_totals_v2() to "+role);
      await c.query("begin");
      await c.query("set local role "+role);
      await expect(c.query("select public.set_grouped_incremental_totals_v1(false)")).rejects.toMatchObject({code:"42501"});
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local role "+role);
      await expect(c.query("update public.grouped_incremental_totals_state set enabled=false")).rejects.toMatchObject({code:"42501"});
      await c.query("rollback");
      await c.query("begin");
      await collect(c);
      await c.query("set local role "+role);
      await c.query("select public.flush_grouped_batch_totals_v2()");
      await c.query("commit");
      await audit();
    } finally {
      await c.query("rollback").catch(()=>undefined);
      if(created){
        await c.query("revoke execute on function public.try_grouped_incremental_totals_v1(),public.flush_grouped_batch_totals_v2() from "+role);
        await c.query("revoke usage on schema public from "+role);
        await c.query("drop role "+role);
      }
      c.release();
    }
  });

  it("disables, rebuilds and repairs official totals; legacy remains available", async () => {
    await pool.query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
    await pool.query("select public.set_grouped_incremental_totals_v1(false)");
    expect((await pool.query("select enabled from public.grouped_incremental_totals_state")).rows[0].enabled).toBe(false);
    expect((await pool.query("select enabled from public.batch_totals_shadow_state")).rows[0].enabled).toBe(true);
    await audit();
  });

  it("compares equivalent grouped writes in legacy, shadow and pilot modes on synthetic mass", async () => {
    // Small CI benchmark. No timing threshold on shared runners.
    const c=await pool.connect();
    const benchCampaign=randomUUID(), tag="BENCH048-"+randomUUID();
    const benchBatches=Array.from({length:3},()=>randomUUID());
    const results: Array<Record<string,unknown>>=[];
    try {
      await c.query("select public.set_batch_totals_shadow_v1(false)");
      await c.query("insert into campaigns(id,name,status) values($1,$2,'rascunho')",[benchCampaign,tag]);
      for (const [i,b] of benchBatches.entries()) await c.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,$3)",[b,benchCampaign,tag+i]);
      await c.query(`insert into members(cpf,cpf_hash,name,external_user_code)
        select '00000000000',$1||':'||n,'Synthetic '||n,$1||':'||n from generate_series(1,400) n`,[tag]);
      await c.query(`insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,
        installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status)
        select $1::uuid,b,m.id,'BENCH048',10000,'unpaid','erp_open_invoice',10000,'completed'
        from members m cross join unnest($2::uuid[]) b where m.cpf_hash like $3`,[benchCampaign,benchBatches,tag+":%"]);
      await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
      await c.query("analyze campaign_batch_members");
      await c.query("analyze member_target_installments");
      const targets=(await c.query(`select distinct target_installment_ref_id as id from campaign_batch_members
        where batch_id=$1 order by id limit 40`,[benchBatches[0]])).rows.map(r=>r.id);
      expect(targets).toHaveLength(40);
      await c.query("set track_functions='pl'");
      const snapshot=async()=>{
        await c.query("select pg_stat_force_next_flush()");
        await c.query("select pg_stat_clear_snapshot()");
        const r=await c.query(`select
          coalesce((select calls from pg_stat_user_functions where schemaname='public' and funcname='recalculate_batch_totals_many'),0)::float8 as full_calls,
          coalesce((select calls from pg_stat_user_functions where schemaname='public' and funcname='project_grouped_incremental_totals_v1'),0)::float8 as pilot_calls,
          seq_scan::float8 as scans,seq_tup_read::float8 as reads
          from pg_stat_user_tables where relid='public.member_target_installments'::regclass`);
        return r.rows[0];
      };
      for (const mode of ["legacy","shadow","pilot"]) {
        if(mode==="shadow") await c.query("select public.set_batch_totals_shadow_v1(true)");
        if(mode==="pilot") await c.query("select public.set_grouped_incremental_totals_v1(true)");
        const before=await snapshot();
        const start=performance.now();
        for(const amount of [9000,10000]){
          for(let i=0;i<targets.length;i+=10){
            await c.query("begin");
            await c.query("select set_config('odontoart.grouped_batch_totals','on',true)");
            for(const id of targets.slice(i,i+10)){
              await c.query("update member_target_installments set pending_amount_cents=$2 where id=$1",[id,amount]);
              await c.query("select public.sync_target_installment_links_v1($1)",[id]);
            }
            await c.query("select public.flush_grouped_batch_totals_v2()");
            await c.query("commit");
          }
        }
        const elapsedMs=performance.now()-start, after=await snapshot();
        const result={mode,canonicalWrites:80,transactions:8,elapsedMs,
          fullCalls:after.full_calls-before.full_calls,pilotCalls:after.pilot_calls-before.pilot_calls,
          scans:after.scans-before.scans,reads:after.reads-before.reads};
        results.push(result);
        // Verify before maintenance, never repair to hide a mismatch.
        expect((await c.query("select * from public.batch_totals_shadow_audit_v1 where official_differs or orphan_batch")).rowCount).toBe(0);
        if(mode!=="legacy")await audit();
        if(mode==="pilot"){
          expect(result.fullCalls).toBe(0);
          expect(result.pilotCalls).toBe(8);
        }else expect(result.fullCalls).toBe(8);
      }
      console.info("[048_SYNTHETIC_BENCHMARK]", JSON.stringify(results));
    } finally {
      await c.query("rollback").catch(()=>undefined);
      await c.query("reset track_functions");
      await c.query("select public.set_grouped_incremental_totals_v1(false)");
      await c.query("select public.set_batch_totals_shadow_v1(false)");
      await c.query("delete from campaigns where id=$1",[benchCampaign]);
      await c.query("delete from members where cpf_hash like $1",[tag+":%"]);
      c.release();
    }
  }, 120000);
});
