// 051-A.1 laboratory only; application SQL is deliberately unchanged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";

for (const [k,v] of Object.entries({
  CI:"true", GITHUB_ACTIONS:"true", BENCH051_ISOLATED:"yes",
  DATABASE_HOST:"127.0.0.1",DATABASE_PORT:"5432",
  DATABASE_NAME:"odontoart_pix_bench051",DATABASE_USER:"postgres"
})) assert.equal(process.env[k],v,k);
const full=process.argv[2]==="--full";
assert(full || process.argv[2]==="--smoke");
const config=full
 ? {canonical:79794,active:66934,shared:32000,six:7661}
 : {canonical:798,active:669,shared:320,six:77};
config.links=config.active+4*config.shared+config.six;
const stressLinks=full?20014:200;
const stageSizes=full?[0,10000,20000,38000]:[0,100,200,380];
const out="benchmark-051a";
await mkdir(out,{recursive:true});
const report={complete:false,scope:"Schema 48; synthetic distributions and registry growth; no ERP, frontend, concurrent writer or full sync throughput. No result cache.",config,stressLinks,stages:[],trials:[],edges:[],comparison:[]};
const save=()=>writeFile(out+"/"+(full?"full":"smoke")+".json",JSON.stringify(report,null,2)+"\n");
const source=await readFile("src/lib/dashboard-unique-unpaid-progress.ts","utf8");
const original=source.match(/export const DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL = \x60([\s\S]*?)\x60;/)?.[1];
assert(original,"production SQL not found");
const pivot=original.lastIndexOf("select count(*)::int as total");
assert(pivot>0 && original.includes("from unpaid_targets"));
const common=original.slice(0,pivot);
const joinChecked=" left join general_sync_run_installments checked on checked.run_id=$1::uuid and checked.target_installment_ref_id=u.id";
const aggregate="select count(*)::int as total,count(checked.target_installment_ref_id)::int as processed from unpaid_targets u"+joinChecked;
const scope="cbm.deleted_at is null and cb.deleted_at is null and c.deleted_at is null and cbm.target_installment_ref_id is not null and (cardinality($2::uuid[])=0 or c.id=any($2::uuid[])) and (cardinality($3::uuid[])=0 or cb.id=any($3::uuid[]))";
const links="campaign_batch_members cbm join campaign_batches cb on cb.id=cbm.batch_id join campaigns c on c.id=cb.campaign_id";
const cteC="with unpaid_targets as (select canonical.id from member_target_installments canonical where canonical.payment_status='unpaid' and exists(select 1 from "+links+" where "+scope+" and cbm.target_installment_ref_id=canonical.id)) ";
const cteD="with unpaid_targets as (select distinct canonical.id from "+links+" join member_target_installments canonical on canonical.id=cbm.target_installment_ref_id where "+scope+" and canonical.payment_status='unpaid') ";
const membership="select u.id,checked.target_installment_ref_id is not null as processed from unpaid_targets u"+joinChecked+" order by u.id";
const checkedCte=common.trimEnd()+", checked_run as materialized (select target_installment_ref_id from general_sync_run_installments where run_id=$1::uuid) ";
const checkedJoin=" left join checked_run checked on checked.target_installment_ref_id=u.id";
const checkedAggregate="select count(*)::int as total,count(checked.target_installment_ref_id)::int as processed from unpaid_targets u"+checkedJoin;
const checkedMembership="select u.id,checked.target_installment_ref_id is not null as processed from unpaid_targets u"+checkedJoin+" order by u.id";
const labIndex="bench051_canonical_unpaid_id_idx";
const modes=[
 {name:"A-original",sql:original,rows:common+"select u.id,exists(select 1 from general_sync_run_installments checked where checked.run_id=$1::uuid and checked.target_installment_ref_id=u.id) as processed from unpaid_targets u order by u.id"},
 {name:"B-left-join",sql:common+aggregate,rows:common+membership},
 {name:"C-semijoin",sql:cteC+aggregate,rows:cteC+membership},
 {name:"D-unpaid-first",sql:cteD+aggregate,rows:cteD+membership},
 {name:"E-materialized-registry",sql:checkedCte+checkedAggregate,rows:checkedCte+checkedMembership},
 {name:"F-left-join-partial-index",sql:common+aggregate,rows:common+membership,requiresIndex:true}
];
report.sql=modes.map(({name,sql,rows,requiresIndex})=>({name,sql,rows,requiresIndex:!!requiresIndex}));
report.indexExperiment={name:labIndex,definition:"CREATE INDEX "+labIndex+" ON public.member_target_installments(id) WHERE payment_status = 'unpaid'",stages:[],note:"Index maintained through stage transitions. No-index phase drops it transactionally and rolls back. Index phase order alternates; no forced planner settings. DDL and write amplification not timed."};
const c=new pg.Client({host:"127.0.0.1",port:5432,user:"postgres",password:"postgres",database:"odontoart_pix_bench051",ssl:false});
async function tx(c,fn){await c.query("begin");try{const r=await fn();await c.query("commit");return r}catch(e){await c.query("rollback");throw e}}
async function beginGrouped(c){await c.query("select set_config('odontoart.grouped_batch_totals','on',true)")}
async function flush(c,pilot=false){await c.query(pilot?"select public.flush_grouped_batch_totals_v2()":"select public.flush_grouped_batch_totals_v1()")}
async function sizes(c) {
  return (await c.query("select (select count(*)::int from member_target_installments) canonical, (select count(distinct target_installment_ref_id)::int from campaign_batch_members where deleted_at is null) active, (select count(*)::int from campaign_batch_members where deleted_at is null) links, (select count(*)::int from campaign_batches) batches, (select count(*)::int from campaigns) campaigns")).rows[0];
}
async function audit(c, shadow, expectedSizes) {
  assert.deepEqual(await sizes(c), expectedSizes);
  const result = (await c.query("select count(*) filter(where official_differs)::int official, count(*) filter(where shadow_differs)::int shadow, count(*) filter(where orphan_batch)::int orphan from public.batch_totals_shadow_audit_v1")).rows[0];
  if (result.official || (shadow && result.shadow) || result.orphan) {
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
  await c.query("insert into campaigns(id,name,status) select md5('bench051-campaign-'||n)::uuid,'BENCH050 campaign '||n,'rascunho' from generate_series(0,4) n");
  await c.query("insert into campaign_batches(id,campaign_id,name) select md5('bench051-batch-'||n)::uuid,md5('bench051-campaign-'||(n/9))::uuid,'BENCH050 batch '||n from generate_series(0,40) n");
  const chunk = 1000;
  for (let lo = 1; lo <= config.canonical; lo += chunk) {
    const hi = Math.min(config.canonical, lo + chunk - 1);
    await tx(c, async () => {
      await beginGrouped(c);
      await c.query("insert into members(id,cpf,cpf_hash,name,external_user_code) select md5('bench051-member-'||n)::uuid,'00000000000','bench051:'||n,'Synthetic '||n,'bench051:'||n from generate_series($1::int,$2::int) n", [lo, hi]);
      // Every active canonical has one home lot. Shared ones appear in five
      // or six distinct lots (offset 7 mod 41); inactive ones retain a deleted link.
      await c.query("with nums as (select n from generate_series($1::int,$2::int) n), links as (select n, ((n-1)+7*k)%41 b from nums cross join lateral generate_series(0,case when n<=$3::int then 5 when n<=$4::int then 4 else 0 end) k) insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench051-campaign-'||(b/9))::uuid,md5('bench051-batch-'||b)::uuid,md5('bench051-member-'||n)::uuid,'BENCH050',10000,'unpaid','erp_open_invoice',10000,'completed' from links", [lo,hi,config.six,config.shared]);
      if (hi > config.active) {
        await c.query("update campaign_batch_members set deleted_at=now() where member_id in (select md5('bench051-member-'||n)::uuid from generate_series($1::int,$2::int) n)", [Math.max(lo,config.active+1),hi]);
      }
      await flush(c);
    });
    if (hi === config.canonical || hi % 10000 === 0) console.log("[051_SEED_PROGRESS]", hi, "/", config.canonical);
  }
  await c.query("vacuum (analyze) campaign_batch_members");
  await c.query("vacuum (analyze) member_target_installments");
  await c.query("vacuum (analyze) members");
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  const expected = { canonical: config.canonical, active: config.active, links: config.links, batches: 41, campaigns: 5 };
  await audit(c, false, expected);
  return expected;
}

const one=async(sql,params=[]) => (await c.query(sql,params)).rows[0];
const uuid=async(s)=>(await one("select md5($1)::uuid id",[s])).id;
const campaign=async(n)=>uuid("bench051-campaign-"+n);
const batch=async(n)=>uuid("bench051-batch-"+n);
const digest=async()=>one("select md5(string_agg(concat_ws('|',id,amount_cents,paid_amount_cents,pending_amount_cents,payment_status,payment_status_source),',' order by id)) finance from member_target_installments");
const inventory=async()=> (await c.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")).rows;
async function setStatuses(lo,hi,pilot=false) {
  await tx(c,async()=>{
    await beginGrouped(c);
    // One home link per target; existing canonical propagation updates all links.
    await c.query("with fixture as (select n,md5('bench051-member-'||n)::uuid member_id,md5('bench051-batch-'||((n-1)%41))::uuid batch_id,case when n%100<39 then 'paid' when n%100<43 then 'agreed' when n%100=43 then 'excluded' else 'unpaid' end status from generate_series($1::int,$2::int) n) update campaign_batch_members m set payment_status=f.status,payment_status_source=case when f.status='paid' then 'erp_explicit' else 'erp_'||f.status end,payment_amount_cents=case when f.status='paid' then 3000 else 0 end,total_pending_amount_cents=case when f.status='paid' then 7000 else 0 end,last_erp_status_at=clock_timestamp() from fixture f where m.member_id=f.member_id and m.batch_id=f.batch_id and m.deleted_at is null and f.status<>'unpaid' and m.payment_status='unpaid'",[lo,hi]);
    await flush(c,pilot);
  });
}
async function newRun(tag) {
  return (await one("insert into general_sync_runs(request_key,status,trigger_source,sync_mode,batch_count,record_count) values($1,'completed','scheduled','scheduled_recheck',42,$2) returning id",["bench051-"+tag,config.active])).id;
}
async function registry(run,lo,hi){
  if(hi<=lo)return;
  await c.query("insert into general_sync_run_installments(run_id,target_installment_ref_id,source_batch_id) select $1,id,source_batch_id from bench051_registry where n>$2 and n<=$3",[run,lo,hi]);
}
async function parity(params,variants=modes) {
  // Compare complete ordered canonical IDs and checked flags, not merely sums.
  const expected=(await c.query(modes[0].rows,params)).rows;
  const expectedCount={total:expected.length,processed:expected.filter(r=>r.processed).length};
  assert.equal(new Set(expected.map(r=>r.id)).size,expected.length);
  for(const mode of variants){
    const actual=await one(mode.sql,params);
    assert.deepEqual(actual,expectedCount,mode.name+" aggregate");
    if(mode!==modes[0])assert.deepEqual((await c.query(mode.rows,params)).rows,expected,mode.name+" canonical membership");
  }
  return expectedCount;
}
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1];
function nodes(plan,arr=[]){arr.push({type:plan["Node Type"],relation:plan["Relation Name"],index:plan["Index Name"],rows:plan["Actual Rows"],loops:plan["Actual Loops"],estimated:plan["Plan Rows"],hit:plan["Shared Hit Blocks"]??0,read:plan["Shared Read Blocks"]??0});for(const p of plan.Plans??[])nodes(p,arr);return arr;}
let expected,run,other,stress;
try{
  await c.connect();
  await c.query("set statement_timeout='120s';set lock_timeout='10s'");
  assert.deepEqual(await one("select current_database() db,current_user username,current_setting('server_version_num') version"),{db:"odontoart_pix_bench051",username:"postgres",version:"170012"});
  assert.equal((await one("select max(version)::int v from schema_migrations")).v,48);
  expected=await seed(c);
  stress=await uuid("bench051-stress");
  await c.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,'BENCH051 stress')",[stress,await campaign(0)]);
  for(let lo=1;lo<=stressLinks;lo+=1000)await tx(c,async()=>{
    await beginGrouped(c);
    await c.query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select md5('bench051-campaign-0')::uuid,$1::uuid,md5('bench051-member-'||n)::uuid,'BENCH050',10000,'unpaid','erp_open_invoice',10000,'completed' from generate_series($2::int,$3::int) n",[stress,lo,Math.min(lo+999,stressLinks)]);
    await flush(c);
  });
  expected={...expected,batches:42,links:expected.links+stressLinks};
  for(let lo=1;lo<=config.active;lo+=1000){
    await setStatuses(lo,Math.min(lo+999,config.active));
    if(lo%10000===1)console.log("[051_STATUS_PROGRESS]",lo);
  }
  await c.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
  await c.query("select public.set_batch_totals_shadow_v1(true)");
  await c.query("select public.set_grouped_incremental_totals_v1(true)");
  await audit(c,true,expected);
  await c.query(execFileSync("bash",["scripts/050a-maintenance-sql.sh","activate"],{encoding:"utf8"}));
  const indexes=await inventory();
  assert(!indexes.some(x=>x.indexname===labIndex),"candidate already exists");
  await c.query(report.indexExperiment.definition);
  for(const table of ["campaign_batch_members","member_target_installments","campaign_batches","campaigns","general_sync_run_installments"])await c.query("vacuum (analyze) "+table);
  const statuses=(await c.query("select payment_status,count(*)::int n from member_target_installments group by 1 order by 1")).rows;
  for(const s of ["unpaid","paid","agreed","excluded"])assert(statuses.some(r=>r.payment_status===s&&r.n>0),s);
  assert((await one("select count(*)::int n from member_target_installments where payment_status='paid' and pending_amount_cents>0")).n>0);
  report.fixture={...expected,postgres:"17.12",statuses,shadow:true,incremental:true,indices050a:2,stressLinks};
  assert.equal(expected.links,full?222609:2226);
  await c.query("create temp table bench051_registry as select id,source_batch_id,row_number() over(order by id)::int n from (select distinct on(target_installment_ref_id) target_installment_ref_id id,batch_id source_batch_id from campaign_batch_members where deleted_at is null and target_installment_ref_id is not null order by target_installment_ref_id,batch_id) q");
  run=await newRun("main");other=await newRun("other");
  // Different run shares targets and must never inflate current progress.
  await registry(other,0,full?2000:20);
  const c0=await campaign(0),c1=await campaign(1),c4=await campaign(4),b0=await batch(0),b9=await batch(9);
  const scopes=[
    ["global",[],[]],["campaign",[c0],[]],["largest",[],[stress]],
    ["multiple-lots",[],[stress,b0]],["multiple-campaigns",[c0,c1],[]],
    ["intersection",[c0],[b0,b9]],["incompatible",[c4],[stress]],
    ["unknown",[],[randomUUID()]],["duplicate-order",[c1,c0,c1],[b9,b0,b9]]
  ];
  let prev=0;
  for(const n of stageSizes){
    await registry(run,prev,n);
    // Committed transition after ERP registration, then read the same snapshot
    // for all variants. Models churn, not simultaneous writer contention.
    if(n>0){
      await tx(c,async()=>{
        await beginGrouped(c);
        const moved=await c.query("with pick as (select b.id from bench051_registry r join campaign_batch_members b on b.target_installment_ref_id=r.id and b.batch_id=r.source_batch_id join member_target_installments t on t.id=r.id where r.n>$1 and r.n<=$2 and t.payment_status='unpaid' order by r.n limit $3) update campaign_batch_members b set payment_status='paid',payment_status_source='erp_explicit',payment_amount_cents=3000,total_pending_amount_cents=7000,last_erp_status_at=clock_timestamp() from pick where b.id=pick.id returning b.id",[prev,n,full?100:2]);
        assert(moved.rowCount>0,"missing churn");
        await flush(c,true);
        report.stages.push({registry:n,transitioned:moved.rowCount});
      });
    }else report.stages.push({registry:n,transitioned:0});
    prev=n;
    await c.query("analyze general_sync_run_installments");
    assert.equal((await one("select count(*)::int n from general_sync_run_installments where run_id=$1",[run])).n,n);
    await audit(c,true,expected);
    const before=await digest();
    const stageIndex=await one("select pg_relation_size($1::regclass)::int bytes",["public."+labIndex]);
    report.indexExperiment.stages.push({registry:n,...stageIndex});
    const referenceCounters=new Map();
    for(const indexed of (stageSizes.indexOf(n)%2===0?[false,true]:[true,false])){
    const phaseModes=modes.filter(m=>!!m.requiresIndex===indexed);
    await c.query(indexed?"begin isolation level repeatable read read only":"begin isolation level repeatable read");
    try{
      if(!indexed)await c.query("drop index public."+labIndex);
      assert.equal((await one("select to_regclass($1) is not null present",["public."+labIndex])).present,indexed);
      for(const [scopeName,campaigns,batches] of scopes){
        const params=[run,campaigns,batches];
        const counters=await parity(params,phaseModes);
        if(referenceCounters.has(scopeName))assert.deepEqual(counters,referenceCounters.get(scopeName));
        else referenceCounters.set(scopeName,counters);
        if(n===0)assert.equal(counters.processed,0);
        if(["incompatible","unknown"].includes(scopeName))assert.deepEqual(counters,{total:0,processed:0});
        // Three rotated rounds to reduce systematic warm-cache order bias.
        for(let round=0;round<3;round++){
          const offset=(round+stageSizes.indexOf(n)+scopes.findIndex(s=>s[0]===scopeName))%phaseModes.length;
          for(const mode of [...phaseModes.slice(offset),...phaseModes.slice(0,offset)]){
            const explain=(await c.query("explain(analyze,buffers,settings,timing off,format json) "+mode.sql,params)).rows[0]["QUERY PLAN"][0];
            const p=explain.Plan;
            report.trials.push({registry:n,scope:scopeName,round,mode:mode.name,counters,buffers:(p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0),hit:p["Shared Hit Blocks"]??0,read:p["Shared Read Blocks"]??0,tempRead:p["Temp Read Blocks"]??0,tempWritten:p["Temp Written Blocks"]??0,executionMs:explain["Execution Time"],planningMs:explain["Planning Time"],nodes:nodes(p),plan:explain});
          }
        }
      }
    }finally{await c.query("rollback")}
    assert.equal((await one("select to_regclass($1) is not null present",["public."+labIndex])).present,true);
    }
    assert.deepEqual(await digest(),before);
    await audit(c,true,expected);
    await save();
    console.log("[051_STAGE]",n,"trials",report.trials.length);
  }
  // Additional soft-deletion and NULL-state cases in a rolled-back lab transaction.
  const beforeEdges=await digest();
  await c.query("begin");
  try{
    await beginGrouped(c);
    const shared=await one("select target_installment_ref_id id from campaign_batch_members where deleted_at is null group by 1 having count(*)>1 order by 1 limit 1");
    assert(shared);
    await c.query("update member_target_installments set payment_status=null where id=$1",[shared.id]);
    const nullCase=await parity([run,[],[]]);
    const nullRows=(await c.query(modes[0].rows,[run,[],[]])).rows;
    assert(!nullRows.some(r=>r.id===shared.id));
    report.edges.push({case:"null canonical status",...nullCase});
    await c.query("update campaign_batches set deleted_at=now() where id=$1",[stress]);
    const deletedLot=await parity([run,[],[stress]]);
    assert.deepEqual(deletedLot,{total:0,processed:0});
    report.edges.push({case:"deleted lot",...deletedLot});
    await c.query("update campaigns set deleted_at=now() where id=$1",[c0]);
    const deletedCampaign=await parity([run,[c0],[]]);
    assert.deepEqual(deletedCampaign,{total:0,processed:0});
    report.edges.push({case:"deleted campaign",...deletedCampaign});
    const noRun=await parity([randomUUID(),[],[]]);
    assert.equal(noRun.processed,0);
    report.edges.push({case:"unknown run",...noRun});
  }finally{await c.query("rollback")}
  assert.deepEqual(await digest(),beforeEdges);
  await c.query("drop index public."+labIndex);
  assert.deepEqual(await inventory(),indexes);
  report.indexExperiment.rollbackInventory=true;
  await audit(c,true,expected);
  assert.equal(report.trials.length,4*9*3*modes.length);
  // Scope/stage medians and overall weighted-by-case (not production traffic) totals.
  for(const n of stageSizes)for(const [scopeName] of scopes){
    const rows=report.trials.filter(t=>t.registry===n&&t.scope===scopeName);
    const baseline=percentile(rows.filter(t=>t.mode===modes[0].name).map(t=>t.buffers),.5);
    for(const mode of modes){
      const selected=rows.filter(t=>t.mode===mode.name);
      const median=percentile(selected.map(t=>t.buffers),.5);
      report.comparison.push({registry:n,scope:scopeName,mode:mode.name,medianBuffers:median,reductionPct:baseline?100*(1-median/baseline):null,medianMs:percentile(selected.map(t=>t.executionMs),.5),maxMs:Math.max(...selected.map(t=>t.executionMs))});
    }
  }
  report.summary=modes.map(({name})=>{
    const active=report.trials.filter(t=>t.mode===name&&t.registry>0);
    const global=active.filter(t=>t.scope==="global");
    const baseGlobal=report.trials.filter(t=>t.mode===modes[0].name&&t.registry>0&&t.scope==="global");
    const sum=a=>a.reduce((s,t)=>s+t.buffers,0);
    return {mode:name,activeGlobalBuffers:sum(global),activeGlobalReductionPct:100*(1-sum(global)/Math.max(1,sum(baseGlobal))),activeAllScopesBuffers:sum(active),activeP95Ms:percentile(active.map(t=>t.executionMs),.95),maxScopeRegressionPct:Math.max(0,...report.comparison.filter(t=>t.mode===name&&t.reductionPct!==null).map(t=>-t.reductionPct))};
  });
  report.planAudit=modes.map(({name})=>{const trials=report.trials.filter(t=>t.mode===name);const scans=trials.flatMap(t=>t.nodes.filter(n=>n.relation==="member_target_installments"&&n.type==="Seq Scan"&&n.loops>0));return {mode:name,plans:trials.length,plansWithCanonicalSeqScan:trials.filter(t=>t.nodes.some(n=>n.relation==="member_target_installments"&&n.type==="Seq Scan"&&n.loops>0)).length,canonicalSeqScanLoops:scans.reduce((a,n)=>a+n.loops,0),plansWithCandidateIndex:trials.filter(t=>t.nodes.some(n=>n.index===labIndex&&n.loops>0)).length};});
  report.worstCases=modes.slice(1).map(({name})=>report.comparison.filter(t=>t.mode===name&&t.reductionPct!==null).sort((a,b)=>a.reductionPct-b.reductionPct)[0]);
  console.log("[051_PLAN_AUDIT]",JSON.stringify(report.planAudit));
  console.log("[051_WORST_CASES]",JSON.stringify(report.worstCases));
  console.log("[051_INDEX_EXPERIMENT]",JSON.stringify(report.indexExperiment));
  report.goal={targetReductionPct:90,metBy:report.summary.filter(s=>s.activeGlobalReductionPct>=90).map(s=>s.mode),note:"Diagnostic PR: no performance winner is deployed. Target miss is reported, not hidden as a CI correctness failure."};
  report.complete=true;
  await save();
  console.log("[051_SUMMARY]",JSON.stringify(report.summary));
  console.log("[051_GOAL]",JSON.stringify(report.goal));
  console.log("[051_BENCHMARK_OK]",JSON.stringify(report.fixture));
}catch(e){report.error=String(e?.stack??e);await save();throw e}
finally{await c.end()}
