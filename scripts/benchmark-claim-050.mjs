// Laboratory only. No production migration or runtime change.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

for (const [key, value] of Object.entries({
  CI: "true", GITHUB_ACTIONS: "true", BENCH050_ISOLATED: "yes",
  DATABASE_HOST: "127.0.0.1", DATABASE_PORT: "5432",
  DATABASE_NAME: "odontoart_pix_bench050", DATABASE_USER: "postgres"
})) assert.equal(process.env[key], value, key);
const full = process.argv[2] === "--full";
assert(full || process.argv[2] === "--smoke");
const config = full
  ? {canonical:79794,active:68000,shared:32000,six:6595}
  : {canonical:798,active:680,shared:320,six:66};
config.links = config.active + 4*config.shared + config.six;
const stressLinks = full ? 20014 : 200;
const report = {complete:false, scope:"Actual schema 48, synthetic fixtures and ERP latency, original claim SQL and update, simulated persistence; not a full ERP or general-sync throughput test",config,stressLinks,plans:[],trials:[]};
await mkdir("benchmark-050",{recursive:true});
const save=()=>writeFile("benchmark-050/"+(full?"full":"smoke")+".json",JSON.stringify(report,null,2)+"\n");
const source=await readFile("src/lib/local-processing-worker.ts","utf8");
const original=source.match(/const candidates = await clientQuery<\{ id: string \}>\(\s*client,\s*\x60([\s\S]*?)\x60,\s*\[job\.batch_id, job\.include_errors, effectiveLimit, targetMemberLinkId, filteredErrorRequestId, phase\]/)?.[1];
const claimUpdate=source.match(/const claimed = await clientQuery<ClaimedMember>\(\s*client,\s*\x60([\s\S]*?)\x60,\s*\[ids, workerId\]/)?.[1];
assert(original && claimUpdate,"Production SQL extraction failed");
const phaseStart=original.indexOf("and (\n            (\n              $6::text");
const phaseEnd=original.indexOf("order by coalesce",phaseStart);
assert(phaseStart>0 && phaseEnd>phaseStart,"Production SQL shape changed");
const primary="and $6::text = 'primary' and ($2::boolean is null or $2::boolean is not null) and processing_status in ('pending','queued','aguardando') and (next_check_at is null or next_check_at <= now()) ";
const retry="and $6::text = 'retry' and ((processing_status = 'retrying' and (next_retry_at is null or next_retry_at <= now())) or ($2::boolean and processing_status = 'error' and error_reprocess_requested_at is not null)) ";
function sqlFor(split,phase) {
  if (!split || phase==="all") return original;
  assert(["primary","retry"].includes(phase));
  return original.slice(0,phaseStart)+(phase==="primary"?primary:retry)+original.slice(phaseEnd);
}
const groupedModule=await import("../src/lib/processing-grouped-persistence.ts");
const grouped=groupedModule.createGroupedPersistence ?? groupedModule.default?.createGroupedPersistence;
const windowModule=await import("../src/lib/processing-sliding-window-v2.ts");
const runWindow=windowModule.runContinuousTwoPassWindow ?? windowModule.default?.runContinuousTwoPassWindow;
assert.equal(typeof grouped,"function");
assert.equal(typeof runWindow,"function");
const connect=()=>new pg.Client({host:"127.0.0.1",port:5432,user:"postgres",password:"postgres",database:"odontoart_pix_bench050",ssl:false});
const c=connect(), picker=connect(), writer=connect();
const worker=randomUUID();
let batch,job,expected;
const lockClaim="select id from processing_jobs where id=$1 and locked_by=$2 and status='running' and stop_requested_at is null for update";
const lockWrite="select id from processing_jobs where id=$1 and locked_by=$2 and status='running' for update";
const modes=[{name:"baseline",idx:false,split:false,coalesce:false},{name:"050a-index",idx:true,split:false,coalesce:false},{name:"050b-phase",idx:false,split:true,coalesce:false},{name:"050ab",idx:true,split:true,coalesce:false},{name:"050abc",idx:true,split:true,coalesce:true}];
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
// Status-only synthetic updates bypass the real ERP financial update's
// canonical propagation/collection hook. Explicitly queue the affected lot
// before the real v2 flush, not a repair after audit.
async function collectStressBatch(db) {
  await db.query("select public.collect_or_recalculate_batch_totals_v1(array[$1::uuid])",[batch]);
}
async function sizes(c) {
  return (await c.query("select (select count(*)::int from member_target_installments) canonical, (select count(distinct target_installment_ref_id)::int from campaign_batch_members where deleted_at is null) active, (select count(*)::int from campaign_batch_members where deleted_at is null) links, (select count(*)::int from campaign_batches) batches, (select count(*)::int from campaigns) campaigns")).rows[0];
}
async function audit(c, shadow, expectedSizes) {
  assert.deepEqual(await sizes(c), expectedSizes);
  const result = (await c.query("select count(*) filter(where official_differs)::int official, count(*) filter(where shadow_differs)::int shadow, count(*) filter(where orphan_batch)::int orphan from public.batch_totals_shadow_audit_v1")).rows[0];
  if (result.official || result.shadow || result.orphan) {
    const differences=(await c.query("select a.*,b.status as official_status,b.total_records,b.processed_records,b.paid_records,b.unpaid_records,b.error_records,b.total_amount_cents,b.total_pending_amount_cents from public.batch_totals_shadow_audit_v1 a left join public.campaign_batches b on b.id=a.batch_id where a.official_differs or a.shadow_differs or a.orphan_batch")).rows;
    console.error("[050_AUDIT_DIFFERENCES]",JSON.stringify(differences));
    report.auditDifferences=differences;
  }
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
  await c.query("insert into campaigns(id,name,status) select md5('bench050-campaign-'||n)::uuid,'BENCH050 campaign '||n,'rascunho' from generate_series(0,4) n");
  await c.query("insert into campaign_batches(id,campaign_id,name) select md5('bench050-batch-'||n)::uuid,md5('bench050-campaign-'||(n/9))::uuid,'BENCH050 batch '||n from generate_series(0,40) n");
  const chunk = 1000;
  for (let lo = 1; lo <= config.canonical; lo += chunk) {
    const hi = Math.min(config.canonical, lo + chunk - 1);
    await tx(c, async () => {
      await beginGrouped(c);
      await c.query("insert into members(id,cpf,cpf_hash,name,external_user_code) select md5('bench050-member-'||n)::uuid,'00000000000','bench050:'||n,'Synthetic '||n,'bench050:'||n from generate_series($1::int,$2::int) n", [lo, hi]);
      // Every active canonical has one home lot. Shared ones appear in five
      // or six distinct lots (offset 7 mod 41); inactive ones retain a deleted link.
      await c.query("with nums as (select n from generate_series($1::int,$2::int) n), links as (select n, ((n-1)+7*k)%41 b from nums cross join lateral generate_series(0,case when n<=$3::int then 5 when n<=$4::int then 4 else 0 end) k) insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench050-campaign-'||(b/9))::uuid,md5('bench050-batch-'||b)::uuid,md5('bench050-member-'||n)::uuid,'BENCH050',10000,'unpaid','erp_open_invoice',10000,'completed' from links", [lo,hi,config.six,config.shared]);
      if (hi > config.active) {
        await c.query("update campaign_batch_members set deleted_at=now() where member_id in (select md5('bench050-member-'||n)::uuid from generate_series($1::int,$2::int) n)", [Math.max(lo,config.active+1),hi]);
      }
      await flush(c);
    });
    if (hi === config.canonical || hi % 10000 === 0) console.log("[050_SEED_PROGRESS]", hi, "/", config.canonical);
  }
  await c.query("vacuum (analyze) campaign_batch_members");
  await c.query("vacuum (analyze) member_target_installments");
  await c.query("vacuum (analyze) members");
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  const expected = { canonical: config.canonical, active: config.active, links: config.links, batches: 41, campaigns: 5 };
  await audit(c, false, expected);
  return expected;
}

const finance=()=>c.query("select md5(string_agg(concat_ws('|',id,amount_cents,paid_amount_cents,pending_amount_cents,payment_status,payment_status_source),',' order by id)) digest from member_target_installments").then(r=>r.rows[0].digest);
let financialDigest;
async function auditAll(){
  await audit(c,true,expected);
  assert.equal(await finance(),financialDigest,"Canonical finance changed");
  const pending=(await c.query("select count(*)::int n from campaign_batch_members where batch_id=$1 and processing_status='processing'",[batch])).rows[0].n;
  assert.equal(pending,0,"Orphaned claims");
}
async function indexes(enabled) {
  await c.query("drop index if exists public.bench050_primary_order");
  await c.query("drop index if exists public.bench050_retry_order");
  if(enabled){
    const order=" (batch_id,(coalesce(next_retry_at,next_check_at,updated_at,created_at)),created_at,id) where deleted_at is null and (payment_status is null or payment_status not in ('paid','agreed','excluded')) and processing_attempts < max_attempts and ";
    await c.query("create index bench050_primary_order on public.campaign_batch_members"+order+"processing_status in ('pending','queued','aguardando')");
    await c.query("create index bench050_retry_order on public.campaign_batch_members"+order+"processing_status in ('retrying','error')");
  }
}
async function prepareDensity(percent) {
  await tx(c,async()=>{
    await beginGrouped(c);
    await c.query("update campaign_batch_members cbm set processing_status=case when t.payment_status in ('paid','agreed','excluded') then 'completed' when f.n%100< $2 then 'pending' when f.n%100>=95 then 'retrying' else 'completed' end, processing_attempts=0, next_check_at=null,next_retry_at=null,updated_at='2026-01-01T00:00:00Z' from bench050_fixture f, member_target_installments t where cbm.id=f.id and cbm.batch_id=$1 and t.id=cbm.target_installment_ref_id",[batch,percent]);
    await collectStressBatch(c);
    await flush(c,true);
  });
  await c.query("analyze campaign_batch_members");
  await c.query("analyze member_target_installments");
  await c.query("drop table if exists pg_temp.bench050_queue");
  await c.query("create temp table bench050_queue as select id,processing_status,processing_attempts,next_retry_at,next_check_at,updated_at from campaign_batch_members where batch_id=$1",[batch]);
  await c.query("create unique index on bench050_queue(id)");
  await auditAll();
}
async function rollbackQuery(sql,params,explain=false){
  await c.query("begin");
  try{
    const query=(explain?"explain (analyze,buffers,wal,settings,format json) ":"")+sql;
    return (await c.query(query,params)).rows;
  }finally{await c.query("rollback");}
}
function ids(rows){return rows.map(r=>r.id);}
function quantile(a,q){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.ceil(q*s.length)-1)];}
async function staticPlans(mode,density,round){
  for(const [phase,limit,includeErrors] of [["primary",1,false],["primary",8,false],["primary",80,false],["retry",1,true],["all",8,true]]){
    const params=[batch,includeErrors,limit,null,null,phase];
    const reference=ids(await rollbackQuery(original,params));
    const sql=sqlFor(mode.split,phase);
    assert.deepEqual(ids(await rollbackQuery(sql,params)),reference,"Ordered eligibility parity");
    if(reference.length){
      const target=[batch,includeErrors,limit,reference[0],null,phase];
      assert.deepEqual(ids(await rollbackQuery(sql,target)),ids(await rollbackQuery(original,target)),"Targeted parity");
    }
    const missingReplay=[batch,includeErrors,limit,null,randomUUID(),phase];
    assert.deepEqual(await rollbackQuery(sql,missingReplay),[],"Unknown replay must not claim");
    for(let repeat=0;repeat<3;repeat++){
      const r=(await rollbackQuery(sql,params,true))[0]["QUERY PLAN"][0];
      const p=r.Plan;
      report.plans.push({mode:mode.name,density,round,phase,limit,repeat,rows:reference.length,executionMs:r["Execution Time"],planningMs:r["Planning Time"],buffers:(p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0),plan:r});
    }
  }
}
// Candidate 050-C only: coalesce requests already owed to free slots, never
// preclaim beyond available slots. Max 8, 2 ms wait; no wave-wide barrier.
async function coalescedWindow({claim,process,maxItems,concurrency}) {
  const active=new Map(),done=new Set(),errors=[];
  let total=0,drained=false,peak=0;
  function start(items){
    for(const item of items){
      const p=Promise.resolve().then(()=>process(item)).catch(e=>errors.push(e)).finally(()=>done.add(item.id));
      active.set(item.id,p);
    }
    total+=items.length;
    peak=Math.max(peak,active.size);
    assert(active.size<=concurrency);
  }
  start(await claim(Math.min(concurrency,maxItems)));
  if(total<Math.min(concurrency,maxItems))drained=true;
  while(active.size){
    if(!done.size)await Promise.race(active.values());
    if(!drained && !errors.length && total<maxItems)await sleep(2);
    for(const id of done)active.delete(id);
    done.clear();
    if(errors.length || drained || total>=maxItems)continue;
    while(active.size<concurrency && total<maxItems){
      const count=Math.min(8,concurrency-active.size,maxItems-total);
      const next=await claim(count);
      start(next);
      if(next.length<count){drained=true;break;}
    }
  }
  if(errors.length)throw errors[0];
  return {claimed:total,peakClaimed:peak};
}
async function statsSnapshot(){
  const r=await c.query("select queryid::text,query,calls::float8,total_exec_time,shared_blks_hit::float8,shared_blks_read::float8 from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and toplevel");
  return new Map(r.rows.map(x=>[x.queryid,x]));
}
function statsDelta(before,after){
  const rows=[];
  for(const [id,x] of after){
    const old=before.get(id)??{};
    const calls=x.calls-(old.calls??0);
    if(calls<=0)continue;
    rows.push({queryid:id,query:x.query,calls,timeMs:x.total_exec_time-(old.total_exec_time??0),buffers:x.shared_blks_hit+x.shared_blks_read-(old.shared_blks_hit??0)-(old.shared_blks_read??0)});
  }
  return rows;
}
async function trial(mode,density,round){
  const maxItems=full?160:32,concurrency=full?80:16;
  const oracle=ids(await rollbackQuery(original,[batch,false,maxItems,null,null,"primary"]));
  assert(oracle.length>0,"No eligible rows");
  const actualMax=oracle.length;
  const before=await statsSnapshot();
  const claimed=[],persisted=[],claimTimes=[],persistTimes=[],groupSizes=[],slotTimes=[];
  let calls=0;
  const claim=async(limit,phase="primary")=>{
    const start=performance.now();
    const rows=await tx(picker,async()=>{
      assert.equal((await picker.query(lockClaim,[job,worker])).rowCount,1);
      const candidates=ids((await picker.query(sqlFor(mode.split,phase),[batch,false,limit,null,null,phase])).rows);
      if(!candidates.length)return [];
      const updated=(await picker.query(claimUpdate,[candidates,worker])).rows;
      assert.equal(updated.length,candidates.length);
      assert(updated.every(r=>r.processing_owner===worker && r.claim_token));
      return updated;
    });
    calls++;claimTimes.push(performance.now()-start);
    claimed.push(...rows.map(x=>x.id));
    return rows;
  };
  const group=grouped({maxSize:20,maxWaitMs:150,write:async(items)=>{
    const start=performance.now();
    await tx(writer,async()=>{
      assert.equal((await writer.query(lockWrite,[job,worker])).rowCount,1);
      await beginGrouped(writer);
      for(const item of items){
        const r=await writer.query("update campaign_batch_members set processing_status='completed',processing_owner=null,claim_token=null,claimed_at=null,processing_started_at=null,processing_heartbeat_at=null,updated_at=now() where id=$1 and processing_owner=$2::uuid and claim_token=$3::uuid and processing_status='processing' returning id",[item.id,worker,item.claim_token]);
        assert.equal(r.rowCount,1,"Ownership lost");
        persisted.push(item.id);
      }
      await collectStressBatch(writer);
      await flush(writer,true);
    });
    groupSizes.push(items.length);persistTimes.push(performance.now()-start);
    return items.map(()=>true);
  }});
  const process=async(item)=>{
    const start=performance.now();
    await sleep(10+(parseInt(item.id.slice(0,2),16)%21));
    await group.submit(item);
    slotTimes.push(performance.now()-start);
  };
  const start=performance.now();
  const result=mode.coalesce
    ?await coalescedWindow({claim,process,maxItems:actualMax,concurrency})
    :await runWindow({claimPrimary:n=>claim(n),claimRetry:n=>claim(n,"retry"),process,maxItems:actualMax,maxConcurrentItems:concurrency});
  const elapsedMs=performance.now()-start;
  assert.equal(result.claimed,actualMax);
  assert.equal(new Set(claimed).size,actualMax,"Duplicate claims");
  assert.deepEqual([...claimed].sort(),[...oracle].sort(),"Claim set changed");
  assert.deepEqual([...persisted].sort(),[...oracle].sort(),"Persisted set changed");
  const after=await statsSnapshot();
  const delta=statsDelta(before,after);
  const selects=delta.filter(r=>/^select campaign_batch_members\.id from campaign_batch_members/i.test(r.query.replace(/\s+/g," ").trim()));
  assert.equal(selects.reduce((sum,x)=>sum+x.calls,0),calls,"Claim statement counters mismatch");
  const record={mode:mode.name,density,round,processed:actualMax,calls,elapsedMs,perMinute:actualMax*60000/elapsedMs,peak:result.peakClaimed,claimP50Ms:quantile(claimTimes,.5),claimP95Ms:quantile(claimTimes,.95),groupP95Ms:quantile(persistTimes,.95),slotP95Ms:quantile(slotTimes,.95),groupSizes,claimBuffers:selects.reduce((s,x)=>s+x.buffers,0),sql:delta};
  // Verify no terminal row got claimed and all canonical financial data stayed intact.
  await auditAll();
  // Restore only synthetic queue state of the rows processed in this trial.
  await tx(c,async()=>{
    await beginGrouped(c);
    await c.query("update campaign_batch_members m set processing_status=q.processing_status,processing_attempts=q.processing_attempts,next_retry_at=q.next_retry_at,next_check_at=q.next_check_at,updated_at=q.updated_at from bench050_queue q where m.id=q.id and m.id=any($1::uuid[])",[claimed]);
    await collectStressBatch(c);
    await flush(c,true);
  });
  await auditAll();
  report.trials.push(record);
  await save();
  console.log("[050_TRIAL]",JSON.stringify({...record,sql:undefined}));
}
try{
  await c.connect();await picker.connect();await writer.connect();
  for(const db of [c,picker,writer]){
    await db.query("set statement_timeout='180s'; set lock_timeout='30s'");
    const identity=(await db.query("select current_database() db,current_user username,current_setting('server_version_num') version")).rows[0];
    assert.equal(identity.db,"odontoart_pix_bench050");assert.equal(identity.username,"postgres");assert.equal(identity.version,"170012");
  }
  assert.equal((await c.query("select max(version)::int v from schema_migrations")).rows[0].v,48);
  await c.query("create extension if not exists pg_stat_statements");
  assert.equal((await c.query("show shared_preload_libraries")).rows[0].shared_preload_libraries,"pg_stat_statements");
  assert.equal((await c.query("show pg_stat_statements.track")).rows[0]["pg_stat_statements.track"],"all");
  expected=await seed(c);
  batch=(await c.query("select md5('bench050-stress')::uuid id")).rows[0].id;
  await c.query("insert into campaign_batches(id,campaign_id,name) values($1,md5('bench050-campaign-0')::uuid,'BENCH050 stress')",[batch]);
  for(let lo=1;lo<=stressLinks;lo+=1000){
    await tx(c,async()=>{
      await beginGrouped(c);
      await c.query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench050-campaign-0')::uuid,$1::uuid,md5('bench050-member-'||n)::uuid,'BENCH050',10000,'unpaid','erp_open_invoice',10000,'completed' from generate_series($2::int,$3::int) n",[batch,lo,Math.min(lo+999,stressLinks)]);
      await flush(c);
    });
  }
  expected={...expected,batches:expected.batches+1,links:expected.links+stressLinks};
  await c.query("create temp table bench050_fixture as select id,row_number() over(order by id)::int n from campaign_batch_members where batch_id=$1",[batch]);
  // Exercise all terminal statuses, including paid with a remaining balance.
  for(const [status,mod] of [["paid",17],["agreed",19],["excluded",23]]){
    await tx(c,async()=>{
      await beginGrouped(c);
      await c.query("update campaign_batch_members m set payment_status=$2,payment_status_source=case when $2='paid' then 'erp_explicit' else 'erp_'||$2 end,payment_amount_cents=case when $2='paid' then 3000 else 0 end,total_pending_amount_cents=case when $2='paid' then 7000 else 0 end,processing_status='completed',last_erp_status_at=clock_timestamp() from bench050_fixture f where m.id=f.id and m.batch_id=$1 and m.payment_status='unpaid' and f.n%$3=0",[batch,status,mod]);
      await flush(c);
    });
  }
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  await c.query("select public.set_batch_totals_shadow_v1(true)");
  await c.query("select public.set_grouped_incremental_totals_v1(true)");
  for(const table of ["campaign_batch_members","member_target_installments","campaign_batches","batch_totals_shadow_totals","batch_totals_shadow_contributions"])await c.query("vacuum (analyze) "+table);
  financialDigest=await finance();
  const terminal=(await c.query("select payment_status,count(*)::int n from member_target_installments where payment_status in ('paid','agreed','excluded') group by payment_status")).rows;
  assert.equal(terminal.length,3);
  assert((await c.query("select count(*)::int n from member_target_installments where payment_status='paid' and pending_amount_cents>0")).rows[0].n>0);
  job=(await c.query("insert into processing_jobs(campaign_id,batch_id,status,locked_by,total_items,processing_origin,processing_scope) values(md5('bench050-campaign-0')::uuid,$1,'running',$2,$3,'dashboard','dashboard') returning id",[batch,worker,stressLinks])).rows[0].id;
  report.fixture={...expected,terminal,postgres:"17.12",shadow:true,incremental:true};
  await auditAll();
  for(const density of [10,50,90]){
    await prepareDensity(density);
    for(let round=1;round<=2;round++){
      for(const mode of round===1?modes:[...modes].reverse()){
        await indexes(mode.idx);
        if(!mode.coalesce)await staticPlans(mode,density,round);
        await trial(mode,density,round);
      }
    }
  }
  await indexes(false);
  assert.equal(report.trials.length,30);
  assert.equal(report.plans.length,360);
  report.complete=true;
  await save();
}catch(error){report.error=error.stack??String(error);await save();throw error;}
finally{await Promise.allSettled([c.end(),picker.end(),writer.end()]);}
