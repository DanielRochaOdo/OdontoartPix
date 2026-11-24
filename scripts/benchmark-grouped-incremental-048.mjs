// CI-only benchmark. Never reads production credentials or .env.
// Each scenario is a fresh database cloned from the same synthetic seed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

const full = process.argv.length === 3 && process.argv[2] === "--full";
const smoke = process.argv.length === 3 && process.argv[2] === "--smoke";
assert(full || smoke, "Choose --smoke or --full");
assert.equal(process.env.CI, "true");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.BENCH048_ISOLATED, "yes");
assert.equal(process.env.DATABASE_HOST, "127.0.0.1");
assert.equal(process.env.DATABASE_PORT, "5432");
assert.equal(process.env.DATABASE_NAME, "odontoart_pix_bench048");
assert.equal(process.env.DATABASE_USER, "postgres");

const scale = full ? "full" : "smoke";
const config = full
  ? { canonical: 78050, active: 65188, shared: 32479, six: 11420, writes: 38000, groupSize: 6, rounds: 2 }
  : { canonical: 780, active: 652, shared: 325, six: 114, writes: 380, groupSize: 6, rounds: 1 };
config.links = config.active - config.shared + 5 * config.shared + config.six;
const base = "odontoart_pix_bench048";
const seedName = "bench048_" + scale + "_seed";
const output = "benchmark-048/" + scale + ".json";
const report = {
  scope: "Synthetic canonical UPDATE + sync_target_installment_links_v1 + grouped flush/commit; excludes ERP, worker job progress, history/contacts persistence, reuse scheduling and concurrent API",
  baseline: "All modes share schema 048; 046 path uses original v1 flush with shadow disabled (disabled 047 trigger overhead remains)",
  config, runner: { cpuCount: cpus().length, memoryBytes: totalmem(), node: process.version },
  startedAt: new Date().toISOString(), stage: "initializing", complete: false, results: []
};
async function save() {
  await mkdir("benchmark-048", { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
async function connect(database) {
  assert(database === base || database === "postgres" || /^bench048_(smoke|full)_(seed|r[12]_(legacy|shadow|pilot))$/.test(database));
  const c = new pg.Client({
    host: "127.0.0.1", port: 5432, user: "postgres", password: "postgres",
    database, ssl: false, application_name: "bench048-" + scale, connectionTimeoutMillis: 10000
  });
  await c.connect();
  const identity = (await c.query("select current_database() db, current_user username, current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.db, database);
  assert.equal(identity.username, "postgres");
  assert(identity.version.startsWith("16"), "Expected isolated PostgreSQL 16");
  await c.query("set statement_timeout='180s'");
  await c.query("set lock_timeout='10s'");
  return c;
}
function safeDb(name) {
  assert(/^bench048_(smoke|full)_(seed|r[12]_(legacy|shadow|pilot))$/.test(name));
  return '"' + name + '"';
}
async function clone(admin, name, template) {
  const source = template === base ? '"' + base + '"' : safeDb(template);
  await admin.query("create database " + safeDb(name) + " template " + source);
}
async function drop(admin, name) {
  // Only databases created by this invocation, on the disposable CI service.
  await admin.query("drop database " + safeDb(name));
}
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
async function worklist(c) {
  // Stable pseudo-random selection, sorted by home lot to approximate a
  // batch-oriented worker. All modes use the identical IDs and values.
  const list = (await c.query("with eligible as (select t.id, split_part(m.external_user_code,':',2)::int n from member_target_installments t join members m on m.id=t.member_id where split_part(m.external_user_code,':',2)::int<=$1), selected as (select id,n from eligible order by md5(n::text) limit $2) select id,n,9000-(n%5)*100 amount from selected order by (n-1)%40,md5(n::text)", [config.active,config.writes])).rows;
  assert.equal(list.length, config.writes);
  assert.equal(new Set(list.map(r => r.id)).size, config.writes);
  return list;
}
function cpuSnapshot() {
  const id = process.env.BENCH_PG_CONTAINER ?? "";
  if (!/^[a-f0-9]{12,64}$/.test(id)) return null;
  try {
    const raw = execFileSync("docker", ["exec", id, "cat", "/sys/fs/cgroup/cpu.stat"], { encoding: "utf8", timeout: 5000 });
    const match = raw.match(/^usage_usec\s+(\d+)$/m);
    if (match) return Number(match[1]);
  } catch { /* cgroup v1 fallback */ }
  try {
    const raw = execFileSync("docker", ["exec", id, "cat", "/sys/fs/cgroup/cpuacct/cpuacct.usage"], { encoding: "utf8", timeout: 5000 });
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value / 1000 : null;
  } catch { return null; }
}
async function snapshot(c) {
  await c.query("select pg_stat_force_next_flush()");
  await c.query("select pg_stat_clear_snapshot()");
  const table = (await c.query("select relname,seq_scan::float8,seq_tup_read::float8,idx_scan::float8,n_tup_upd::float8 from pg_stat_user_tables where relname in ('member_target_installments','campaign_batch_members','campaign_batches','batch_totals_shadow_contributions','batch_totals_shadow_totals') order by relname")).rows;
  const funcs = (await c.query("select funcname,calls::float8,total_time,self_time from pg_stat_user_functions where schemaname='public' and (funcname like '%batch%total%' or funcname like '%shadow%' or funcname='sync_target_installment_links_v1') order by funcname")).rows;
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
function percentile(values,p) {
  const v = [...values].sort((a,b)=>a-b);
  return v[Math.ceil(v.length*p)-1] ?? 0;
}
async function verifySource(c, list) {
  const values = list.map(r => r.amount);
  const mismatch = (await c.query("select count(*)::int n from unnest($1::uuid[],$2::bigint[]) e(id,amount) left join member_target_installments t on t.id=e.id where t.id is null or t.pending_amount_cents is distinct from e.amount", [list.map(r=>r.id),values])).rows[0].n;
  assert.equal(mismatch,0,"Canonical results mismatch");
  const total = (await c.query("select sum(pending_amount_cents)::text pending,count(*) filter(where payment_status is distinct from 'unpaid')::int wrong_status from member_target_installments")).rows[0];
  assert.equal(total.wrong_status,0);
  const expected = BigInt(config.canonical)*10000n-values.reduce((s,v)=>s+BigInt(10000-v),0n);
  assert.equal(total.pending,expected.toString(),"Unexpected canonical balance outside selected records");
}
async function scenario(c, observer, mode, round, expectedSizes, list) {
  if (mode !== "legacy") {
    await c.query("select public.set_batch_totals_shadow_v1(true)");
    await c.query("analyze public.batch_totals_shadow_contributions");
    await c.query("analyze public.batch_totals_shadow_totals");
  }
  if (mode === "pilot") await c.query("select public.set_grouped_incremental_totals_v1(true)");
  await audit(c,mode!=="legacy",expectedSizes);
  // Warm identical source paths and checkpoint before the measured window.
  await c.query("select sum(pending_amount_cents) from member_target_installments");
  await c.query("select count(*) from campaign_batch_members where deleted_at is null");
  await c.query("checkpoint");
  await c.query("set track_functions='pl'");
  await c.query("select pg_stat_force_next_flush()");
  await sleep(1100);
  const before = await snapshot(c);
  const serverPid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
  let running=true, observerError=null;
  const waits={ samples:0, active:0, events:{} };
  const poll = (async()=>{
    while(running){
      try {
        const r=(await observer.query("select state,wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) blocked from pg_stat_activity where pid=$1",[serverPid])).rows[0];
        if(r){
          waits.samples++;
          if(r.state==="active"){
            waits.active++;
            const label=(r.wait_event_type??"CPU_OR_UNINSTRUMENTED")+"/"+(r.wait_event??"-");
            waits.events[label]=(waits.events[label]??0)+1;
            if(r.blocked>0)waits.events.BLOCKED=(waits.events.BLOCKED??0)+1;
          }
        }
      }catch(e){ observerError=String(e); break; }
      await sleep(250);
    }
  })();
  const timings=[], cpuBefore=cpuSnapshot(), start=performance.now();
  let confirmed=0;
  try {
    for(let i=0;i<list.length;i+=config.groupSize){
      const items=list.slice(i,i+config.groupSize);
      const txStart=performance.now();
      await tx(c,async()=>{
        await beginGrouped(c);
        for(const r of items){
          const updated=await c.query("update member_target_installments set pending_amount_cents=$2 where id=$1",[r.id,r.amount]);
          assert.equal(updated.rowCount,1);
          await c.query("select public.sync_target_installment_links_v1($1)",[r.id]);
        }
        await flush(c,mode==="pilot");
      });
      timings.push(performance.now()-txStart);
      confirmed+=items.length;
      if (confirmed === list.length || Math.floor(confirmed/3000)!==Math.floor((confirmed-items.length)/3000)) {
        console.log("[048_BENCH_PROGRESS]", round, mode, confirmed, "/", list.length);
      }
    }
  } finally { running=false; }
  const elapsedMs=performance.now()-start;
  const cpuAfter=cpuSnapshot();
  await poll;
  assert.equal(observerError,null);
  await c.query("select pg_stat_force_next_flush()");
  await sleep(1100);
  const after=await snapshot(c);
  assert.equal(before.wal.stats_reset,after.wal.stats_reset);
  assert.equal(before.database.stats_reset,after.database.stats_reset);
  const table=deltaRows(before.table,after.table,"relname",["seq_scan","seq_tup_read","idx_scan","n_tup_upd"]);
  const functions=deltaRows(before.funcs,after.funcs,"funcname",["calls","total_time","self_time"]);
  const wal=deltaObject(before.wal,after.wal,["wal_bytes","wal_records","wal_fpi","wal_buffers_full"]);
  const database=deltaObject(before.database,after.database,["deadlocks","blks_read","blks_hit","temp_bytes"]);
  const count=name=>functions.find(f=>f.funcname===name)?.calls??0;
  const fullCalls=count("recalculate_batch_totals_many"), pilotCalls=count("project_grouped_incremental_totals_v1");
  const canonical=table.find(r=>r.relname==="member_target_installments");
  assert(canonical);
  const result={ round,mode,confirmed,transactions:timings.length,elapsedMs,
    writesPerSecond:confirmed*1000/elapsedMs, p50TransactionMs:percentile(timings,.5),
    p95TransactionMs:percentile(timings,.95),p99TransactionMs:percentile(timings,.99),
    dbCpuMs:cpuBefore===null||cpuAfter===null?null:(cpuAfter-cpuBefore)/1000,
    fullCalls,pilotCalls,readsPerWrite:canonical.seq_tup_read/confirmed,table,functions,wal,database,waits,
    audit:null };
  report.results.push(result);
  await save(); // Preserve metrics even if financial verification fails.
  assert.equal(confirmed,config.writes);
  assert.equal(database.deadlocks,0);
  assert.equal(fullCalls,mode==="pilot"?0:timings.length);
  assert.equal(pilotCalls,mode==="pilot"?timings.length:0);
  await verifySource(c,list);
  result.audit=await audit(c,mode!=="legacy",expectedSizes);
  await save();
  console.log("[048_BENCH_RESULT]",JSON.stringify(result));
}
async function main(){
  await save();
  const admin=await connect("postgres");
  try {
    const migrated=await connect(base);
    try {
      assert.equal((await migrated.query("select max(version)::int v from schema_migrations")).rows[0].v,48);
      report.postgres=(await migrated.query("select name,setting,unit from pg_settings where name in ('server_version','shared_buffers','work_mem','max_parallel_workers_per_gather','effective_cache_size','fsync','synchronous_commit','checkpoint_timeout','max_wal_size','track_io_timing','autovacuum') order by name")).rows;
    }finally{await migrated.end();}
    report.stage="seeding"; await save();
    await clone(admin,seedName,base);
    let expectedSizes,list;
    const seedDb=await connect(seedName);
    try{
      const start=performance.now();
      expectedSizes=await seed(seedDb);
      list=await worklist(seedDb);
      report.fixture={...expectedSizes,seedMs:performance.now()-start};
      console.log("[048_FIXTURE]",JSON.stringify(report.fixture));
      await save();
    }finally{await seedDb.end();}
    for(let round=1;round<=config.rounds;round++){
      const modes=round===1?["legacy","shadow","pilot"]:["pilot","shadow","legacy"];
      for(const mode of modes){
        report.stage="round "+round+" "+mode; await save();
        const name="bench048_"+scale+"_r"+round+"_"+mode;
        await clone(admin,name,seedName);
        const c=await connect(name), observer=await connect(name);
        try{await scenario(c,observer,mode,round,expectedSizes,list);}
        finally{await c.end();await observer.end();}
        await drop(admin,name);
      }
    }
    await drop(admin,seedName);
    report.stage="complete";report.complete=true;report.finishedAt=new Date().toISOString();
    await save();
    console.log("[048_BENCH_COMPLETE]",JSON.stringify(report.results.map(({round,mode,confirmed,transactions,elapsedMs,fullCalls,pilotCalls,readsPerWrite,dbCpuMs,wal,audit})=>({round,mode,confirmed,transactions,elapsedMs,fullCalls,pilotCalls,readsPerWrite,dbCpuMs,wal,audit}))));
  }finally{await admin.end();}
}
main().catch(async error=>{
  report.error={message:error.message,code:error.code??null,stack:error.stack};
  await save().catch(()=>undefined);
  console.error(error);process.exitCode=1;
});
