// Isolated CI benchmark: actual schema 048 and finalization SQL.
// Seed/audit routines reused from the 048 benchmark; no production credentials.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
assert.equal(process.env.CI,"true");
assert.equal(process.env.GITHUB_ACTIONS,"true");
assert.equal(process.env.BENCH049A_ISOLATED,"yes");
assert.equal(process.env.DATABASE_HOST,"127.0.0.1");
assert.equal(process.env.DATABASE_PORT,"5432");
assert.equal(process.env.DATABASE_NAME,"odontoart_pix_bench049a");
assert.equal(process.env.DATABASE_USER,"postgres");
const full=process.argv[2]==="--full";
assert(full||process.argv[2]==="--smoke");
const config=full?{canonical:78050,active:65188,shared:32479,six:11420}:{canonical:780,active:652,shared:325,six:114};
config.links=config.active-config.shared+5*config.shared+config.six;
const stressLinks=full?20014:200, cycles=full?24:4;
const report={scope:"Actual schema 048; explicit final refresh and real parameterized queue SELECT in separate transactions. No ERP, job writes or full worker throughput; per cycle, not per confirmed installment.",config,stressLinks,cycles,complete:false,results:[]};
await mkdir("benchmark-049a",{recursive:true});
const save=()=>writeFile("benchmark-049a/"+(full?"full":"smoke")+".json",JSON.stringify(report,null,2)+"\n");
const source=await readFile("src/lib/local-processing-worker.ts","utf8");
const queue=source.match(/const queue = await clientQuery<\{[\s\S]*?\}>\(\s*client,\s*\x60([\s\S]*?)\x60,\s*\[job\.batch_id, job\.include_errors, targetMemberLinkId, filteredErrorRequestId\]/)?.[1];
assert(queue,"Real queue SQL not found");
const c=new pg.Client({host:"127.0.0.1",port:5432,user:"postgres",password:"postgres",database:"odontoart_pix_bench049a",ssl:false});
async function tx(c, fn) {
  await c.query("begin");
  try { const result = await fn(); await c.query("commit"); return result; }
  catch (error) { await c.query("rollback").catch(() => undefined); throw error; }
}
async function beginGrouped(c) {
  await c.query("select set_config('odontoart.grouped_batch_totals','on',true)");
}
async function flush(c, pilot = false) {
  await c.query(pilot ? "select public.flush_grouped_batch_totals_v2()" : "select public.flush_grouped_batch_totals_v1()");
}
async function sizes(c) {
  return (await c.query("select (select count(*)::int from member_target_installments) canonical, (select count(distinct target_installment_ref_id)::int from campaign_batch_members where deleted_at is null) active, (select count(*)::int from campaign_batch_members where deleted_at is null) links, (select count(*)::int from campaign_batches) batches, (select count(*)::int from campaigns) campaigns")).rows[0];
}
async function audit(c, shadow, expectedSizes) {
  assert.deepEqual(await sizes(c), expectedSizes);
  const result = (await c.query("select count(*) filter(where official_differs)::int official, count(*) filter(where shadow_differs)::int shadow, count(*) filter(where orphan_batch)::int orphan from public.batch_totals_shadow_audit_v1")).rows[0];
  assert.equal(result.official, 0, JSON.stringify(result));
  assert.equal(result.orphan, 0, JSON.stringify(result));
  if (shadow) {
    assert.equal(result.shadow, 0, JSON.stringify(result));
    const links = (await c.query("select count(*) filter(where differs)::int differences, count(*) filter(where orphan_contribution)::int orphans, count(*) filter(where missing_contribution)::int missing from public.batch_totals_shadow_link_audit_v1")).rows[0];
    assert.deepEqual(links, { differences: 0, orphans: 0, missing: 0 });
    result.links = links;
  }
  for (const table of ["grouped_batch_totals_pending", "grouped_incremental_totals_pending", "batch_totals_shadow_dirty", "batch_totals_shadow_transactions"]) {
    assert.equal((await c.query("select count(*)::int n from public." + table)).rows[0].n, 0, table);
  }
  const propagation = (await c.query("select count(*)::int n from campaign_batch_members b left join member_target_installments t on t.id=b.target_installment_ref_id where b.deleted_at is null and (t.id is null or b.total_pending_amount_cents is distinct from t.pending_amount_cents or b.payment_status is distinct from t.payment_status)")).rows[0].n;
  assert.equal(propagation, 0, "Link propagation mismatch");
  return { ...result, propagation, shadowChecked: shadow };
}

async function seed(c) {
  assert.deepEqual(await sizes(c), { canonical: 0, active: 0, links: 0, batches: 0, campaigns: 0 });
  assert.equal((await c.query("select enabled from public.grouped_incremental_totals_state")).rows[0].enabled, false);
  assert.equal((await c.query("select enabled from public.batch_totals_shadow_state")).rows[0].enabled, false);
  await c.query("insert into campaigns(id,name,status) select md5('bench048-campaign-'||n)::uuid,'BENCH048 campaign '||n,'rascunho' from generate_series(0,4) n");
  await c.query("insert into campaign_batches(id,campaign_id,name) select md5('bench048-batch-'||n)::uuid,md5('bench048-campaign-'||(n/8))::uuid,'BENCH048 batch '||n from generate_series(0,39) n");
  const chunk = 1000;
  for (let lo = 1; lo <= config.canonical; lo += chunk) {
    const hi = Math.min(config.canonical, lo + chunk - 1);
    await tx(c, async () => {
      await beginGrouped(c);
      await c.query("insert into members(id,cpf,cpf_hash,name,external_user_code) select md5('bench048-member-'||n)::uuid,'00000000000','bench048:'||n,'Synthetic '||n,'bench048:'||n from generate_series($1::int,$2::int) n", [lo, hi]);
      // Every active canonical has one home lot. Shared ones appear in five
      // or six distinct lots (offset 7 mod 40); inactive ones retain a deleted link.
      await c.query("with nums as (select n from generate_series($1::int,$2::int) n), links as (select n, ((n-1)+7*k)%40 b from nums cross join lateral generate_series(0,case when n<=$3::int then 5 when n<=$4::int then 4 else 0 end) k) insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench048-campaign-'||(b/8))::uuid,md5('bench048-batch-'||b)::uuid,md5('bench048-member-'||n)::uuid,'BENCH048',10000,'unpaid','erp_open_invoice',10000,'completed' from links", [lo,hi,config.six,config.shared]);
      if (hi > config.active) {
        await c.query("update campaign_batch_members set deleted_at=now() where member_id in (select md5('bench048-member-'||n)::uuid from generate_series($1::int,$2::int) n)", [Math.max(lo,config.active+1),hi]);
      }
      await flush(c);
    });
    if (hi === config.canonical || hi % 10000 === 0) console.log("[048_SEED_PROGRESS]", hi, "/", config.canonical);
  }
  await c.query("vacuum (analyze) campaign_batch_members");
  await c.query("vacuum (analyze) member_target_installments");
  await c.query("vacuum (analyze) members");
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  const expected = { canonical: config.canonical, active: config.active, links: config.links, batches: 40, campaigns: 5 };
  await audit(c, false, expected);
  return expected;
}
async function snapshot(c) {
  await c.query("select pg_stat_force_next_flush()");
  await c.query("select pg_stat_clear_snapshot()");
  const table = (await c.query("select relname,seq_scan::float8,seq_tup_read::float8,idx_scan::float8,n_tup_upd::float8 from pg_stat_user_tables where relname in ('member_target_installments','campaign_batch_members','campaign_batches','batch_totals_shadow_contributions','batch_totals_shadow_totals') order by relname")).rows;
  const funcs = (await c.query("select funcname,calls::float8,total_time,self_time from pg_stat_user_functions where schemaname='public' and (funcname like '%batch%total%' or funcname like '%shadow%' or funcname like '%grouped_incremental_totals%' or funcname='sync_target_installment_links_v1') order by funcname")).rows;
  const wal = (await c.query("select wal_bytes::float8,wal_records::float8,wal_fpi::float8,wal_buffers_full::float8,stats_reset::text from pg_stat_wal")).rows[0];
  const database = (await c.query("select deadlocks::float8,blks_read::float8,blks_hit::float8,temp_bytes::float8,stats_reset::text from pg_stat_database where datname=current_database()")).rows[0];
  return { table, funcs, wal, database };
}
function deltaObject(a, b, keys) {
  return Object.fromEntries(keys.map(k => {
    const d = Number(b[k] ?? 0) - Number(a[k] ?? 0);
    assert(d >= -0.000001, "Counter decreased: " + k);
    return [k, Math.max(0,d)];
  }));
}
function deltaRows(a, b, key, keys) {
  const index = new Map(a.map(r => [r[key],r]));
  return b.map(r => ({ [key]: r[key], ...deltaObject(index.get(r[key]) ?? {},r,keys) }));
}

const readTotals=()=>c.query("select id,total_records,processed_records,paid_records,unpaid_records,error_records,total_amount_cents,total_pending_amount_cents,status from campaign_batches order by id").then(r=>r.rows);
const refresh=async(a,batch)=>{
  if(!a){await c.query("select public.recalculate_batch_totals_many($1::uuid[])",[[batch]]);return;}
  await tx(c,async()=>{await beginGrouped(c);await c.query("select public.collect_or_recalculate_batch_totals_v1($1::uuid[])",[[batch]]);await flush(c,true);});
};
try{
  await c.connect();
  const identity=(await c.query("select current_database() db,current_user username,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.db,"odontoart_pix_bench049a");assert.equal(identity.username,"postgres");assert(identity.version.startsWith("16"));
  await c.query("set statement_timeout='180s'");
  assert.equal((await c.query("select max(version)::int v from schema_migrations")).rows[0].v,48);
  let expected=await seed(c);
  const batch=(await c.query("select md5('bench049a-stress')::uuid id")).rows[0].id;
  await c.query("insert into campaign_batches(id,campaign_id,name) values($1,md5('bench048-campaign-0')::uuid,'BENCH049A stress')",[batch]);
  for(let lo=1;lo<=stressLinks;lo+=1000){
    await tx(c,async()=>{
      await beginGrouped(c);
      await c.query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench048-campaign-0')::uuid,$1::uuid,md5('bench048-member-'||n)::uuid,'BENCH048',10000,'unpaid','erp_open_invoice',10000,case when n%13=0 then 'processing' when n%11=0 then 'retrying' else 'pending' end from generate_series($2::int,$3::int) n",[batch,lo,Math.min(lo+999,stressLinks)]);
      await flush(c);
    });
  }
  expected={...expected,batches:expected.batches+1,links:expected.links+stressLinks};
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  await c.query("select public.set_batch_totals_shadow_v1(true)");
  await c.query("select public.set_grouped_incremental_totals_v1(true)");
  for(const table of ["campaign_batch_members","member_target_installments","campaign_batches","batch_totals_shadow_totals","batch_totals_shadow_contributions"]) await c.query("vacuum (analyze) "+table);
  await audit(c,true,expected);
  const original=await readTotals();
  const params=[batch,false,null,null], reference=(await c.query(queue,params)).rows;
  await c.query("set track_functions='pl'");
  await c.query("set jit=on");
  const modes=[{a:false,b:false},{a:true,b:false},{a:false,b:true},{a:true,b:true}];
  for(let round=1;round<=2;round++){
    for(const mode of round===1?modes:[...modes].reverse()){
      await refresh(mode.a,batch);
      await c.query(queue,params);
      await c.query("select pg_stat_force_next_flush()");await sleep(1100);
      const before=await snapshot(c), times=[], releases=[];
      for(let i=0;i<cycles;i++){
        let start=performance.now();
        await refresh(mode.a,batch);
        times.push(performance.now()-start);
        start=performance.now();
        await tx(c,async()=>{if(mode.b)await c.query("set local jit=off");assert.deepEqual((await c.query(queue,params)).rows,reference);});
        releases.push(performance.now()-start);
      }
      await c.query("select pg_stat_force_next_flush()");await sleep(1100);
      const after=await snapshot(c);
      const table=deltaRows(before.table,after.table,"relname",["seq_scan","seq_tup_read","idx_scan","n_tup_upd"]);
      const functions=deltaRows(before.funcs,after.funcs,"funcname",["calls","total_time","self_time"]);
      const count=name=>functions.find(f=>f.funcname===name)?.calls??0;
      const median=a=>{const s=[...a].sort((x,y)=>x-y);return (s[s.length/2-1]+s[s.length/2])/2;};
      const result={round,...mode,cycles,medianRefreshMs:median(times),medianQueueTransactionMs:median(releases),totalRefreshMs:times.reduce((x,y)=>x+y,0),totalQueueMs:releases.reduce((x,y)=>x+y,0),fullCalls:count("recalculate_batch_totals_many"),projectionCalls:count("project_grouped_incremental_totals_v1"),table,functions};
      report.results.push(result);await save();
      assert.equal(result.fullCalls,mode.a?0:cycles);
      assert.equal(result.projectionCalls,mode.a?cycles:0);
      assert.deepEqual(await readTotals(),original);
      await audit(c,true,expected);
      console.log("[049A_BENCH_RESULT]",JSON.stringify(result));
    }
  }
  report.complete=true;await save();
}catch(error){report.error=String(error);await save();throw error;}finally{await c.end();}
