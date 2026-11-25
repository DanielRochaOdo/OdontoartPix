// CI-only real HTTP routes + real worker, isolated PostgreSQL service. No production access.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import pg from 'pg';
import { seedFixture, verifyTotals } from './local-financial-fixtures.mjs';

assert.equal(process.env.CI,'true');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.OPERATIONAL048_ISOLATED,'yes');
assert.equal(process.env.DATABASE_HOST,'127.0.0.1');
assert.equal(process.env.DATABASE_PORT,'5432');
assert.equal(process.env.DATABASE_NAME,'odontoart_pix_ops048');
assert.equal(process.env.DATABASE_USER,'postgres');
const repo=process.cwd(), base=path.join(repo,'operational-048');
const dbConfig={host:'127.0.0.1',port:5432,database:'odontoart_pix_ops048',user:'postgres',password:'postgres',ssl:false};
const runtimeConfig={...dbConfig,user:'odontoart_pix_app',password:'ci-ops048-app'};
const env={...process.env,DATABASE_HOST:'127.0.0.1',DATABASE_PORT:'5432',DATABASE_NAME:dbConfig.database,DATABASE_USER:runtimeConfig.user,DATABASE_PASSWORD:runtimeConfig.password,DATABASE_SSL:'false',DATABASE_POOL_MAX:'10',
  AUTH_COOKIE_SECURE:'false', MENSALIDADES_API_BASE_URL:'http://127.0.0.1:3102', MENSALIDADES_API_TOKEN:'local-fixture',
  PROCESSING_ALLOW_SCHEDULED_SYNC:'false',PROCESSING_PIPELINE_V2_ENABLED:'true',PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED:'true',PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED:'true',
  GENERAL_SYNC_UNIQUE_TARGETS_ENABLED:'true',PROCESSING_PERSISTENCE_PROFILE_ENABLED:'true',PROCESSING_PERSISTENCE_PILOT_ENABLED:'false',PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED:'false',
  PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED:'false',PROCESSING_GROUPED_PERSISTENCE_ENABLED:'true',NEXT_TELEMETRY_DISABLED:'1'};
async function startMockErp( { port = 3101, failures = {}, delayMs = 0 } = {}) {
  const pool = new pg.Pool(runtimeConfig);
  const requests = [];
  const attempts = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1:3101');
      if (url.pathname !== '/api/Mensalidades' || url.searchParams.get('token') !== 'local-fixture') {
        response.writeHead(404).end(); return;
      }
      const code = url.searchParams.get('CodigoAssociadoEmpresa') ?? '';
      const attempt = (attempts.get(code) ?? 0) + 1;
      attempts.set(code, attempt);
      const status = failures[code]?.[attempt - 1] ?? 200;
      requests.push({ code, attempt, status, at: new Date().toISOString() });
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (status !== 200) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'Synthetic ERP transient failure' }));
        return;
      }
      const { rows } = await pool.query(`select t.external_installment_code as id from member_target_installments t
        join members m on m.id=t.member_id where m.external_user_code=$1`, [code]);
      const mode = Number(code.split(':').at(-1)) % 5;
      const description = ['PIX','PIX','ABERTO','ACORDADO','EXCLUIDA'][mode] ?? 'ABERTO';
      const data = rows.map(row => ({ Id: row.id, cod_usuario: code, Valor: '100,00', ValorFinal: '100,00',
        ValorPago: mode === 0 ? '100,00' : mode === 1 ? '60,00' : '0,00',
        DescricaoRecebimento: description, DescricaoPagamento: 'PIX', vencimento: '2026-11-18' }));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ codigo: 1, mensagem: 'ERP local simulado', erros: [],
        dados: { CurrentPage: 1, TotalPages: 1, TotalCount: data.length, PageSize: 200, Data: data } }));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  server.on('close', () => { void pool.end(); });
  server.labRequests = requests;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`Mock ERP: http://127.0.0.1:${port} (synthetic records only).`);
  return server;
}



const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'http://127.0.0.1:3100';
const grouped = true;
const reportFile = path.join(base, grouped ? 'general-sync-grouped-smoke-report.json' : 'general-sync-smoke-report.json');

async function main() {
  await fs.mkdir(base,{recursive:true});
  const client = new pg.Client(dbConfig);
  await client.connect();
  let server, app, appDone, appLog;
  const report = { generatedAt: new Date().toISOString(), grouped, complete: false, scenarios: [] };
  try {
    const identity=(await client.query("select current_database() db,current_user username, current_setting('server_version_num') version")).rows[0];
    assert.equal(identity.db,dbConfig.database);assert.equal(identity.username,'postgres');assert(identity.version.startsWith('16'));
    assert.equal((await client.query("select count(*)::int n from campaigns")).rows[0].n,0);
    assert.equal((await client.query("select max(version)::int v from schema_migrations")).rows[0].v,48);
    // Grant application access to ordinary source tables only, never to private
    // shadow/projection tables or audit views. Migrations grant runtime functions.
    const relations=(await client.query("select format('%I.%I',schemaname,tablename) as name from pg_tables where schemaname='public' and tablename not like 'batch_totals_shadow_%' and tablename not like 'grouped_incremental_totals_%'")).rows;
    for(const r of relations) await client.query("grant select,insert,update,delete on "+r.name+" to odontoart_pix_app");
    await client.query("grant usage,select on all sequences in schema public to odontoart_pix_app");
    await client.query("alter role odontoart_pix_app in database odontoart_pix_ops048 set track_functions='pl'");
    await client.query("update processing_scheduler_state set scheduler_enabled=false");
    await client.query("update processing_settings set config=config || $1::jsonb where settings_key='default'",[JSON.stringify({
      processing_persistence_concurrency:2,processing_erp_concurrency:8,processing_concurrency:8,processing_block_size:80,processing_max_buffered_results:80,worker_count:1,processing_productive_delay_ms:0})]);
    const password=randomUUID();
    await client.query("insert into users(name,email,password_hash,role,active) values('Administrador CI','admin@localhost.local',$1,'administrador',true)",[await bcrypt.hash(password,10)]);
    const runtime=new pg.Client(runtimeConfig);await runtime.connect();
    try{
      assert.equal((await runtime.query("select current_user username")).rows[0].username,'odontoart_pix_app');
      for(const sql of ["select public.set_grouped_incremental_totals_v1(true)","select public.set_batch_totals_shadow_v1(true)","update public.grouped_incremental_totals_state set enabled=true","update public.batch_totals_shadow_totals set total_records=0"]){
        await assert.rejects(runtime.query(sql), e=>e.code==='42501');
      }
    }finally{await runtime.end();}
    report.permissions={role:'odontoart_pix_app',adminAndPrivateWritesDenied:true,productionGrantsIdentical:false};
    appLog=await fs.open(path.join(base,'next.log'),'w');
    app=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3100'],{cwd:repo,env,stdio:['ignore',appLog.fd,appLog.fd]});
    appDone=new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',(code,signal)=>resolve({code,signal}));});
    const deadline=Date.now()+120000;
    let login;
    while(Date.now()<deadline){
      try{
        login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@localhost.local',password}),signal:AbortSignal.timeout(20000)});
        if(login.status===200)break;
      }catch{}
      if(app.exitCode!==null)throw Error('Next dev exited; inspect next.log');
      await sleep(500);
    }
    assert.equal(login?.status,200,'Authenticated HTTP startup failed');

    assert.equal((await client.query("select count(*)::int as n from general_sync_runs where status in ('queued','running','paused','cancelling')")).rows[0].n, 0, 'Finish the current local sync before this test.');
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    assert.ok(cookie);
    async function api(route, body) {
      const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120000) });
      const result = await response.json();
      assert.ok(response.ok && result.success, JSON.stringify(result));
      return result.data;
    }
    async function fixture(size, label) {
      await client.query('begin');
      try { const f = await seedFixture(client, size, label, 'pending'); await client.query('commit'); return { ...f, size }; }
      catch (error) { await client.query('rollback'); throw error; }
    }
    const standard = await fixture(40, 'sync geral');
    const retry = await fixture(10, 'sync retry');
    const interrupted = await fixture(80, 'sync interrupcao');
    const concurrent=await fixture(40,'sync concurrent API');
    await client.query("select public.recalculate_batch_totals_many(array(select id from campaign_batches))");
    await client.query("select public.set_batch_totals_shadow_v1(true)");
    await client.query("select public.set_grouped_incremental_totals_v1(true)");
    server = await startMockErp({ port:3102, delayMs:40, failures:{[retry.links[0].code]:[503]} });
    async function audit(label){
      const totals=(await client.query("select count(*) filter(where official_differs)::int official,count(*) filter(where shadow_differs)::int shadow,count(*) filter(where orphan_batch)::int orphans from public.batch_totals_shadow_audit_v1")).rows[0];
      const links=(await client.query("select count(*) filter(where differs)::int differences,count(*) filter(where orphan_contribution)::int orphans,count(*) filter(where missing_contribution)::int missing from public.batch_totals_shadow_link_audit_v1")).rows[0];
      assert.deepEqual(totals,{official:0,shadow:0,orphans:0},label);
      assert.deepEqual(links,{differences:0,orphans:0,missing:0},label);
      for(const table of ['grouped_batch_totals_pending','grouped_incremental_totals_pending','batch_totals_shadow_dirty','batch_totals_shadow_transactions']){
        assert.equal((await client.query("select count(*)::int n from public."+table)).rows[0].n,0,table);
      }
      return {totals,links};
    }
    const projectionCount=async()=>Number((await client.query("select coalesce((select calls from pg_stat_user_functions where schemaname='public' and funcname='project_grouped_incremental_totals_v1'),0)::text n")).rows[0].n);
    const projectionBefore=await projectionCount();

    async function start(f) {
      const data = await api('/api/dashboard/general-sync', { campaignIds: [f.campaign] });
      assert.equal(data.created, true);
      return data.run.id;
    }
    async function worker(label, crashRunId) {
      const logFile = path.join(base, `general-sync-${label}.log`);
      const log = await fs.open(logFile, 'w');
      // --import keeps the worker in this PID, so killing it really closes its DB sessions.
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/process-local-worker.ts', '--drain', '--delay-ms=0'], {
        cwd: repo, env,
        windowsHide: true, stdio: ['ignore', log.fd, log.fd]
      });
      let exited = false, killed = false;
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
      });
      const timeout = setTimeout(() => { child.kill(); }, 120000);
      try {
        if (crashRunId) {
          const deadline = Date.now() + 60000;
          while (!exited && Date.now() < deadline) {
            const active = (await client.query(`select coalesce(sum(processed_items),0)::int as processed,
              count(*) filter(where status='running')::int as running from processing_jobs where general_sync_run_id=$1`, [crashRunId])).rows[0];
            if (active.processed > 0 && active.running > 0) { killed = child.kill('SIGKILL'); break; }
            await sleep(25);
          }
          assert.equal(killed, true, 'Must interrupt a running worker after at least one commit.');
        }
        const result = await done;
        if (!crashRunId) assert.equal(result.code, 0, `Inspect ${logFile}`);
        return { logFile, killed, ...result };
      } finally {
        clearTimeout(timeout);
        if (!exited) { child.kill(); await done; }
        await log.close();
      }
    }
    async function verify(f, id, expectedUnique) {
      const run = await api(`/api/dashboard/general-sync/${id}`);
      assert.equal(run.status, 'completed', JSON.stringify(run));
      assert.equal(run.completedBatchCount, 3);
      assert.equal(run.processedCount, expectedUnique);
      assert.equal(run.successCount, expectedUnique);
      assert.equal(run.errorCount, 0);
      assert.equal(run.reusedCount, expectedUnique * 2);
      assert.equal(run.recordCount, run.processedCount + run.reusedCount);
      assert.ok(run.batches.every(b => b.status === 'completed'));
      const divergence = await verifyTotals(client, f.batches);
      assert.deepEqual(divergence, [], 'Stored totals must match before any repair.');
      const operational = (await client.query(`select status,total_records,processed_records from campaign_batches where id=any($1::uuid[])`, [f.batches])).rows;
      assert.ok(operational.every(b => b.status === 'concluido' && b.total_records === f.size && b.processed_records === f.size));
      const financial = (await client.query(`select payment_status,count(*)::int as count,sum(amount_cents)::text as amount,
        sum(paid_amount_cents)::text as paid,sum(pending_amount_cents)::text as pending
        from member_target_installments t join members m on m.id=t.member_id where m.cpf_hash like $1
        group by payment_status order by payment_status`, [`${f.tag}:%`])).rows;
      const n = f.size / 5;
      assert.deepEqual(financial, [
        { payment_status: 'agreed', count: n, amount: String(n*10000), paid: '0', pending: '0' },
        { payment_status: 'excluded', count: n, amount: String(n*10000), paid: '0', pending: '0' },
        { payment_status: 'paid', count: 2*n, amount: String(n*20000), paid: String(n*16000), pending: String(n*4000) },
        { payment_status: 'unpaid', count: n, amount: String(n*10000), paid: '0', pending: String(n*10000) }
      ]);
      const jobs = (await client.query('select status,total_items,processed_items,success_items,error_items from processing_jobs where general_sync_run_id=$1', [id])).rows;
      assert.ok(jobs.length > 0 && jobs.every(j => j.status === 'completed' && j.error_items === 0));
      return { runId: id, status: run.status, queries: run.processedCount, reused: run.reusedCount, batches: operational, financial, jobs, divergences: 0 };
    }
    async function record(name, result) {
      report.scenarios.push({ name, ...result, audit:await audit(name) });
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ name, status: result.status, queries: result.queries, reused: result.reused, divergences: result.divergences }));
    }

    const first = await start(standard);
    const initialWorker = await worker(grouped ? 'grouped-normal' : 'normal');
    if (grouped) {
      const metrics = await fs.readFile(initialWorker.logFile, 'utf8');
      assert.match(metrics, /persistenceGrouped: true/);
      assert.doesNotMatch(metrics, /LOCAL_WORKER_GROUPED_PERSISTENCE_FALLBACK/);
      const groups = [...metrics.matchAll(/persistenceGroupedTransactions: (\d+),\s*persistenceGroupedItems: (\d+)/g)];
      assert.ok(groups.some(([, tx, items]) => Number(tx) > 0 && Number(items) > Number(tx)),
        'At least one worker cycle must actually commit multiple results per transaction.');
      assert.equal((await client.query('select count(*)::int as n from grouped_batch_totals_pending')).rows[0].n, 0);
    }
    await record('single drain including fully reused batches', { ...await verify(standard, first, 40), ...initialWorker });
    assert.equal(server.labRequests.filter(r => r.code.startsWith(standard.tag)).length, 40);
    assert.ok(standard.links.every(link => server.labRequests.filter(r => r.code === link.code).length === 1));

    const repeated = await start(standard);
    await worker('repeated');
    await record('second sync preserves paid/partial/agreed/excluded', await verify(standard, repeated, 8));
    assert.equal(server.labRequests.filter(r => r.code.startsWith(standard.tag)).length, 48);

    const retryId = await start(retry);
    // Obey the real retry timestamps. No direct date/claim/status mutations.
    let cycles = 0;
    do {
      await worker(`retry-${++cycles}`);
      if ((await api(`/api/dashboard/general-sync/${retryId}`)).status === 'completed') break;
      await sleep(1500);
    } while (cycles < 10);
    await record('HTTP 503 then real retry succeeds', { ...await verify(retry, retryId, 10), cycles });
    const retryRequests = server.labRequests.filter(r => r.code.startsWith(retry.tag));
    assert.equal(retryRequests.length, 11);
    assert.deepEqual(retryRequests.filter(r => r.code === retry.links[0].code).map(r => r.status), [503,200]);

    const crashId = await start(interrupted);
    const crash = await worker('interrupted', crashId);
    const beforeRecovery = (await client.query('select status,processed_items from processing_jobs where general_sync_run_id=$1', [crashId])).rows;
    assert.ok(beforeRecovery.some(j => j.status === 'running' && j.processed_items > 0));
    await worker('recovered');
    const recoveryLog = await fs.readFile(path.join(base, 'general-sync-recovered.log'), 'utf8');
    assert.match(recoveryLog, /LOCAL_WORKER_RECOVERY/);
    await record('real worker interruption and recovery', { ...await verify(interrupted, crashId, 80), crash, beforeRecovery });
    // Actual DELETE route overlaps a real grouped worker transaction. The
    // extra missing-installment link is added AFTER the run snapshot, so
    // its removal does not alter the planned financial workload.
    const concurrentId=await start(concurrent);
    const extra=randomUUID(), extraCode='OPS048-'+extra;
    await client.query("insert into members(id,cpf,cpf_hash,name,external_user_code) values($1,'00000000000',$2,'Synthetic deletion',$2)",[extra,extraCode]);
    const extraLink=(await client.query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status,last_error) values($1,$2,$3,$4,10000,'unpaid','erp_open_invoice',10000,'error','Parcela alvo nao foi localizada') returning id",[concurrent.campaign,concurrent.batches[0],extra,extraCode])).rows[0].id;
    assert.equal((await client.query("select count(*)::int n from general_sync_run_eligible_links where run_id=$1 and member_link_id=$2",[concurrentId,extraLink])).rows[0].n,0);
    await client.query("select public.recalculate_batch_totals_many($1::uuid[])",[concurrent.batches]);
    // Test-only immediate trigger pauses the grouped transaction after it
    // has acquired lot locks, but before the deferred shadow advisory lock.
    const gate='202611250481';
    await client.query("create function public.ci048_gate() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(202611250481::bigint); return new; end; $$");
    await client.query("create trigger ci048_gate before insert on public.grouped_incremental_totals_pending for each row execute function public.ci048_gate()");
    const locker=new pg.Client(dbConfig);await locker.connect();
    let runningWorker, removal;
    try{
      await locker.query("select pg_advisory_lock($1::bigint)",[gate]);
      const lockPid=(await locker.query("select pg_backend_pid() pid")).rows[0].pid;
      runningWorker=worker('api-concurrent').then(value=>({value}),error=>({error}));
      const until=Date.now()+30000;
      let blockedWorker;
      while(Date.now()<until){
        blockedWorker=(await client.query("select pid from pg_stat_activity where datname=current_database() and usename='odontoart_pix_app' and query like '%flush_grouped_batch_totals_v2%' and $1::int=any(pg_blocking_pids(pid))",[lockPid])).rows[0]?.pid;
        if(blockedWorker)break;
        await sleep(50);
      }
      assert.ok(blockedWorker,'Worker must be gated inside actual v2 flush');
      removal=fetch(origin+'/api/associados/'+extraLink,{method:'DELETE',headers:{cookie},signal:AbortSignal.timeout(60000)}).then(async res=>({status:res.status,body:await res.json()}),error=>({error}));
      const deadline=Date.now()+30000;
      let blockedApi=false;
      while(Date.now()<deadline){
        blockedApi=(await client.query("select exists(select 1 from pg_stat_activity where datname=current_database() and usename='odontoart_pix_app' and query like '%recalculate_batch_totals_many%' and $1::int=any(pg_blocking_pids(pid))) blocked",[blockedWorker])).rows[0].blocked;
        if(blockedApi)break;
        await sleep(50);
      }
      assert.equal(blockedApi,true,'API must demonstrably wait on the grouped worker lot lock');
      await locker.query("select pg_advisory_unlock($1::bigint)",[gate]);
      const response=await removal;
      assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.success,true);
      const outcome=await runningWorker;if(outcome.error)throw outcome.error;
      await record('real HTTP DELETE overlaps grouped worker lock',{...await verify(concurrent,concurrentId,40),blockedApi:true,worker:outcome.value});
      assert.equal((await client.query("select deleted_at is not null as deleted from campaign_batch_members where id=$1",[extraLink])).rows[0].deleted,true);
    }finally{
      await locker.end();if(removal)await removal;if(runningWorker)await runningWorker;
      await client.query("drop trigger ci048_gate on public.grouped_incremental_totals_pending");
      await client.query("drop function public.ci048_gate()");
    }
    // Abrupt disconnect while an incremental projection is queued but
    // uncommitted. Snapshot the canonical and derived state, terminate
    // the isolated backend, and retry the identical logical write.
    const target=(await client.query("select target_installment_ref_id id from campaign_batch_members where batch_id=$1 and deleted_at is null and payment_status='unpaid' limit 1",[concurrent.batches[0]])).rows[0].id;
    const readTarget=async()=> (await client.query("select pending_amount_cents, payment_status from member_target_installments where id=$1",[target])).rows[0];
    const original=await readTarget();
    const interruptedTx=new pg.Client(runtimeConfig);await interruptedTx.connect();
    let lost=false;
    interruptedTx.on('error',()=>{lost=true;});
    try{
      await interruptedTx.query("begin");
      await interruptedTx.query("select set_config('odontoart.grouped_batch_totals','on',true)");
      await interruptedTx.query("update member_target_installments set pending_amount_cents=9000 where id=$1",[target]);
      await interruptedTx.query("select public.sync_target_installment_links_v1($1)",[target]);
      await interruptedTx.query("select public.flush_grouped_batch_totals_v2()");
      assert.deepEqual(await readTarget(),original);
      const pid=(await interruptedTx.query("select pg_backend_pid() pid")).rows[0].pid;
      assert.equal((await client.query("select pg_terminate_backend($1,5000) terminated",[pid])).rows[0].terminated,true);
    }finally{await interruptedTx.end().catch(()=>undefined);}
    assert.deepEqual(await readTarget(),original);
    await audit('terminated uncommitted projection');
    const retryClient=new pg.Client(runtimeConfig);await retryClient.connect();
    try{
      for(let i=0;i<2;i++){
        await retryClient.query("begin");
        await retryClient.query("select set_config('odontoart.grouped_batch_totals','on',true)");
        await retryClient.query("update member_target_installments set pending_amount_cents=9000 where id=$1",[target]);
        await retryClient.query("select public.sync_target_installment_links_v1($1)",[target]);
        await retryClient.query("select public.flush_grouped_batch_totals_v2()");
        await retryClient.query("commit");
      }
    }finally{await retryClient.end();}
    assert.equal((await readTarget()).pending_amount_cents,'9000');
    await record('backend termination before commit and repeated retry',{status:'completed',terminated:true,connectionErrorObserved:lost});
    await client.query("select pg_stat_clear_snapshot()");
    const projections=await projectionCount()-projectionBefore;
    assert(projections>0,'Actual worker/runtime must execute 048 projection');
    report.incrementalProjections=projections;
    assert.equal((await client.query("select deadlocks::int n from pg_stat_database where datname=current_database()")).rows[0].n,0);
    await client.query("select public.set_grouped_incremental_totals_v1(false)");
    assert.equal((await client.query("select enabled from public.grouped_incremental_totals_state")).rows[0].enabled,false);
    await record('reversion to 047 with full repair',{status:'completed'});
    report.requests = server.labRequests;
    report.complete = true;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(`Complete report: ${reportFile}`);
  } catch (error) {
    report.error = error.message;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    throw error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if(app){app.kill('SIGTERM');await appDone;}
    if(appLog)await appLog.close();
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
