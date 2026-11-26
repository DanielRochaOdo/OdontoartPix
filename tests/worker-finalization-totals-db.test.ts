import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbPool } from "@/lib/db/pool";
import { recalculateBatch } from "@/lib/batch-totals";
import { tryRefreshGroupedWorkerBatch } from "@/lib/worker-finalization-totals";

it("049-A defaults off and does not touch non-grouped work", async () => {
  vi.stubEnv("PROCESSING_WORKER_FINALIZATION_INCREMENTAL_TOTALS_ENABLED", undefined);
  try {
    expect(await tryRefreshGroupedWorkerBatch("not-a-uuid", true)).toBe(false);
    expect(await tryRefreshGroupedWorkerBatch("not-a-uuid", false, true)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

const describeDb = process.env.CI === "true" ? describe.sequential : describe.skip;
describeDb("049-A explicit final projection on real PostgreSQL schema", () => {
  const campaign=randomUUID(), member=randomUUID(), tag="FINAL049A-"+randomUUID();
  const batches=[randomUUID(),randomUUID(),randomUUID()];
  let link="", initialized=false;
  const pool=()=>getDbPool();
  const audit=async()=>{
    expect((await pool().query("select * from public.batch_totals_shadow_audit_v1 where official_differs or shadow_differs or orphan_batch")).rowCount).toBe(0);
    expect((await pool().query("select * from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution")).rowCount).toBe(0);
    for(const table of ["grouped_batch_totals_pending","grouped_incremental_totals_pending","batch_totals_shadow_dirty","batch_totals_shadow_transactions"]){
      expect((await pool().query("select count(*)::int n from public."+table)).rows[0].n).toBe(0);
    }
  };
  beforeAll(async()=>{
    expect(process.env.DATABASE_HOST).toBe("127.0.0.1");
    expect(process.env.DATABASE_NAME).toBe("odontoart_pix_ci");
    expect((await pool().query("select current_database() db")).rows[0].db).toBe("odontoart_pix_ci");
    expect((await pool().query("select enabled from public.grouped_incremental_totals_state")).rows[0].enabled).toBe(false);
    expect((await pool().query("select enabled from public.batch_totals_shadow_state")).rows[0].enabled).toBe(false);
    await pool().query("insert into campaigns(id,name,status) values($1,$2,'rascunho')",[campaign,tag]);
    await pool().query("insert into members(id,cpf,cpf_hash,name) values($1,'00000000000',$2,$2)",[member,tag]);
    for(const [i,b] of batches.entries()) await pool().query("insert into campaign_batches(id,campaign_id,name) values($1,$2,$3)",[b,campaign,tag+i]);
    for(const b of batches.slice(0,2)){
      const r=await pool().query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) values($1,$2,$3,$4,10000,'unpaid','erp_open_invoice',10000,'pending') returning id",[campaign,b,member,tag]);
      if(b===batches[0])link=r.rows[0].id;
    }
    await pool().query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
    await pool().query("select public.set_batch_totals_shadow_v1(true)");
    initialized=true;
    await pool().query("select public.set_grouped_incremental_totals_v1(true)");
    await audit();
  },30000);
  afterAll(async()=>{
    if(!initialized)return;
    try{
      await pool().query("select public.set_grouped_incremental_totals_v1(false)");
      await pool().query("select public.set_batch_totals_shadow_v1(false)");
      await pool().query("delete from campaigns where id=$1",[campaign]);
      await pool().query("delete from members where id=$1",[member]);
    }finally{await pool().end();}
  },30000);
  it("refreshes committed claim, retry, error and empty batch with no financial writes in the refresh",async()=>{
    for(const status of ["processing","retrying","error","completed"]){
      await pool().query("update campaign_batch_members set processing_status=$2 where id=$1",[link,status]);
      await pool().query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
      expect(await tryRefreshGroupedWorkerBatch(batches[0],true,true)).toBe(true);
      await audit();
    }
    expect(await tryRefreshGroupedWorkerBatch(batches[2],true,true)).toBe(true);
    await audit();
  },30000);
  it("projects shared partial payment without changing canonical financial truth",async()=>{
    await pool().query("update campaign_batch_members set payment_status='paid',payment_status_source='erp_explicit',payment_amount_cents=3000,total_pending_amount_cents=7000,processing_status='completed',last_erp_status_at=clock_timestamp() where id=$1",[link]);
    const read=async()=> (await pool().query("select t.id,t.amount_cents,t.paid_amount_cents,t.pending_amount_cents,t.payment_status from member_target_installments t where t.member_id=$1",[member])).rows;
    const before=await read();
    expect(before).toHaveLength(1);
    for(const b of batches.slice(0,2)) expect(await tryRefreshGroupedWorkerBatch(b,true,true)).toBe(true);
    expect(await read()).toEqual(before);
    expect(before[0]).toMatchObject({payment_status:"paid",pending_amount_cents:"7000"});
    await audit();
  },30000);
  it("rolls back a deferred projection failure and permits full 044 repair",async()=>{
    const name="ci049a_"+randomUUID().replaceAll("-","");
    await pool().query("create function public."+name+"() returns trigger language plpgsql as $$ begin raise exception 'synthetic 049-A commit failure'; end; $$");
    try{
      await pool().query("create constraint trigger "+name+" after insert on public.grouped_incremental_totals_pending deferrable initially deferred for each row execute function public."+name+"()");
      await pool().query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
      expect(await tryRefreshGroupedWorkerBatch(batches[0],true,true)).toBe(false);
      await recalculateBatch(batches[0]);
      await audit();
    }finally{
      await pool().query("drop trigger if exists "+name+" on public.grouped_incremental_totals_pending");
      await pool().query("drop function public."+name+"()");
    }
  },30000);
  it("uses the existing 046 fallback if the database 048 pilot is off",async()=>{
    await pool().query("select public.set_grouped_incremental_totals_v1(false)");
    await pool().query("update campaign_batches set total_records=0 where id=$1",[batches[0]]);
    expect(await tryRefreshGroupedWorkerBatch(batches[0],true,true)).toBe(true);
    await audit();
  },30000);
});
