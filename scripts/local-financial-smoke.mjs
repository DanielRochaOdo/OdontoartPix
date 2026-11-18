// Exercise the real HTTP authentication/enqueue routes and real worker against
// synthetic fixtures in the dedicated localhost database.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { base, repo, state, databases, connection, assertServer, environment } from './local-financial-lab.mjs';
import { seedFixture, verifyTotals } from './local-financial-fixtures.mjs';

async function main() {
  const s = await state();
  const client = new pg.Client(connection(s, databases.dev));
  await client.connect();
  try {
    await assertServer(client, s);
    const origin = 'http://127.0.0.1:3100';
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@localhost.local', password: s.adminPassword }), signal: AbortSignal.timeout(120000) });
    assert.equal(login.status, 200, 'Local login must succeed');
    assert.equal((await login.json()).success, true);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'Login must issue a session cookie');
    await client.query('begin');
    let fixture;
    try { fixture = await seedFixture(client, 80, 'fluxo completo', 'pending'); await client.query('commit'); }
    catch (error) { await client.query('rollback'); throw error; }
    const response = await fetch(`${origin}/api/lotes/${fixture.batches[0]}/processar`, {
      method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(120000) });
    const queued = await response.json();
    assert.equal(response.status, 202, JSON.stringify(queued));
    assert.equal(queued.data.totalItems, 80);
    const logFile = path.join(base, 'worker-smoke.log');
    const log = await fs.open(logFile, 'w');
    try {
      const worker = spawn(process.execPath, [path.join(repo, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/process-local-worker.ts', '--drain', '--delay-ms=0', '--max-cycles=10'],
      { cwd: repo, env: environment(s, databases.dev), windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}; inspect ${logFile}`)));
      });
    } finally { await log.close(); }
    const job = (await client.query('select status,total_items,processed_items,success_items,error_items from processing_jobs where id=$1', [queued.data.jobId])).rows[0];
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.processed_items, 80);
    assert.equal(job.success_items, 80);
    assert.equal(job.error_items, 0);
    assert.deepEqual(await verifyTotals(client, fixture.batches), []);
    const canonical = (await client.query(`select payment_status,count(*)::int as count,sum(amount_cents)::text as amount,
      sum(paid_amount_cents)::text as paid,sum(pending_amount_cents)::text as pending
      from member_target_installments t join members m on m.id=t.member_id
      where m.cpf_hash like $1 group by payment_status order by payment_status`, [`${fixture.tag}:%`])).rows;
    assert.deepEqual(canonical, [
      { payment_status: 'agreed', count: 16, amount: '160000', paid: '0', pending: '0' },
      { payment_status: 'excluded', count: 16, amount: '160000', paid: '0', pending: '0' },
      { payment_status: 'paid', count: 32, amount: '320000', paid: '256000', pending: '64000' },
      { payment_status: 'unpaid', count: 16, amount: '160000', paid: '0', pending: '160000' }
    ]);
    const html = await fetch(`${origin}/campanhas/${fixture.campaign}`, { headers: { cookie }, signal: AbortSignal.timeout(120000) });
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('LAB fluxo completo'), 'Campaign page must render fixture');
    const logText = await fs.readFile(logFile, 'utf8');
    assert.match(logText, /persistenceConcurrency["']?\s*:\s*2/);
    const report = { generatedAt: new Date().toISOString(), origin, job, canonical,
      campaignUrl: `${origin}/campanhas/${fixture.campaign}`, sharedBatches: fixture.batches,
      checks: ['HTTP login', 'HTTP enqueue', 'real worker with persistenceConcurrency=2', 'mock ERP',
        '80 successful items', 'partial/paid/unpaid/agreed/excluded', 'all three stored totals', 'authenticated HTML'],
      browserInteraction: 'Not verified: browser control unavailable in this session' };
    await fs.writeFile(path.join(base, 'smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await client.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
