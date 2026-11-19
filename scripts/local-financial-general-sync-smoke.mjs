// Real Dashboard HTTP routes + real worker, scoped synthetic campaigns only.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { base, repo, state, databases, connection, assertServer, environment } from './local-financial-lab.mjs';
import { seedFixture, verifyTotals, startMockErp } from './local-financial-fixtures.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'http://127.0.0.1:3100';
const reportFile = path.join(base, 'general-sync-smoke-report.json');

async function main() {
  const s = await state(), client = new pg.Client(connection(s, databases.dev));
  await client.connect();
  let server;
  const report = { generatedAt: new Date().toISOString(), complete: false, scenarios: [] };
  try {
    await assertServer(client, s);
    assert.equal((await client.query("select count(*)::int as n from general_sync_runs where status in ('queued','running','paused','cancelling')")).rows[0].n, 0, 'Finish the current local sync before this test.');
    // A competing watcher would invalidate the single-process drain/crash checks.
    for (const file of ['worker-service.json', 'worker-watch-status.json']) {
      const service = await fs.readFile(path.join(base, file), 'utf8').then(JSON.parse, () => null);
      if (service && !['stopped', 'failed'].includes(service.status)) {
        let alive = false;
        try { process.kill(service.pid, 0); alive = true; } catch { /* stale status */ }
        assert.equal(alive, false, 'Stop the lab watcher before running this smoke test.');
      }
    }
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@localhost.local', password: s.adminPassword }), signal: AbortSignal.timeout(120000) });
    assert.equal(login.status, 200);
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
    server = await startMockErp(s, { port: 3102, delayMs: 40, failures: { [retry.links[0].code]: [503] } });

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
        cwd: repo, env: { ...environment(s, databases.dev), MENSALIDADES_API_BASE_URL: 'http://127.0.0.1:3102' },
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
            if (active.processed > 0 && active.running > 0) { killed = child.kill(); break; }
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
      report.scenarios.push({ name, ...result });
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ name, status: result.status, queries: result.queries, reused: result.reused, divergences: result.divergences }));
    }

    const first = await start(standard);
    const initialWorker = await worker('normal');
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
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
