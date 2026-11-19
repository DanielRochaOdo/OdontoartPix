import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { base, state, connection, assertServer, databases, migrate } from './local-financial-lab.mjs';
import { seedFixture, removeFixture, verifyTotals } from './local-financial-fixtures.mjs';

function integer(name, fallback, min, max) {
  const value = Number(process.argv.find(v => v.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name} (${min}..${max}).`);
  return value;
}
const size = integer('size', 2000, 2, 100000);
const updates = integer('updates', 200, 2, size);
const rounds = integer('rounds', 2, 1, 10);
const recalcCalls = integer('recalc-calls', 30, 1, 1000);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0;
const rounded = value => Math.round(value * 100) / 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stats(client) {
  await client.query('select pg_stat_clear_snapshot()');
  return (await client.query(`select funcname,calls::float8,total_time,self_time from pg_stat_user_functions
    where schemaname='public' and (funcname like '%batch_total%' or funcname like '%target_installment%')`)).rows;
}
function statsDelta(before, after) {
  const previous = new Map(before.map(row => [row.funcname, row]));
  return after.map(row => {
    const old = previous.get(row.funcname) ?? {};
    return { function: row.funcname, calls: row.calls - (old.calls ?? 0),
      totalMs: rounded(row.total_time - (old.total_time ?? 0)), selfMs: rounded(row.self_time - (old.self_time ?? 0)) };
  }).filter(row => row.calls > 0);
}

async function scenario(s, kind, concurrency, round) {
  const pool = new pg.Pool({ ...connection(s, databases[kind]), max: 5 });
  const admin = await pool.connect();
  let fixture;
  const clients = [];
  try {
    await assertServer(admin, s);
    // Remove dead tuples from earlier synthetic scenarios before creating the
    // next mass. This maintenance is outside the measured interval.
    await admin.query('vacuum (analyze) campaign_batch_members');
    await admin.query('vacuum (analyze) member_target_installments');
    await admin.query('begin');
    try { fixture = await seedFixture(admin, size, `benchmark ${kind}`); await admin.query('commit'); }
    catch (error) { await admin.query('rollback'); throw error; }
    await admin.query('analyze campaign_batch_members');
    await admin.query('analyze member_target_installments');
    const job = (await admin.query(`insert into processing_jobs(campaign_id,batch_id,status,total_items)
      values($1,$2,'running',$3) returning id`, [fixture.campaign, fixture.batches[0], updates])).rows[0].id;
    const token = randomUUID();
    await admin.query(`update campaign_batch_members set processing_status='processing',processing_owner=$2,
      claim_token=$3,claimed_at=clock_timestamp() where id=any($1::uuid[])`, [fixture.links.slice(0, updates).map(r => r.id), job, token]);
    for (const batch of fixture.batches) await admin.query('select recalculate_batch_totals($1)', [batch]);
    // Warm both query paths before collecting statistics.
    for (let i = 0; i < 5; i++) {
      if (kind === 'candidate') await admin.query('select recalculate_batch_totals_many($1::uuid[])', [fixture.batches]);
      else for (const batch of fixture.batches) await admin.query('select recalculate_batch_totals($1)', [batch]);
    }
    await admin.query('select pg_stat_force_next_flush()');
    const recalcBefore = await stats(admin);
    const recalcTimes = [];
    for (let i = 0; i < recalcCalls; i++) {
      const start = performance.now();
      await admin.query('begin');
      if (kind === 'candidate') await admin.query('select recalculate_batch_totals_many($1::uuid[])', [fixture.batches]);
      else for (const batch of fixture.batches) await admin.query('select recalculate_batch_totals($1)', [batch]);
      await admin.query('commit');
      recalcTimes.push(performance.now() - start);
    }
    await admin.query('select pg_stat_force_next_flush()');
    const recalcAfter = await stats(admin);
    for (let i = 0; i < concurrency; i++) {
      const client = await pool.connect();
      await client.query("set statement_timeout='20s'");
      await client.query("set lock_timeout='10s'");
      clients.push(client);
    }
    let next = 0;
    let retries = 0;
    const failures = [];
    const timings = [];
    const before = await stats(admin);
    const start = performance.now();
    await Promise.all(clients.map(async client => {
      while (next < updates) {
        const index = next++;
        const itemStart = performance.now();
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client.query('begin');
            const locked = await client.query(`select id from campaign_batch_members where id=$1
              and processing_owner=$2 and claim_token=$3 for update`, [fixture.links[index].id, job, token]);
            if (locked.rowCount !== 1) throw new Error('Claim lost');
            await client.query(`update campaign_batch_members set payment_status='paid',payment_status_source='erp_payment',
              payment_amount_cents=$2::bigint,total_pending_amount_cents=10000-$2::bigint,
              processing_status='completed',last_erp_status_at=clock_timestamp(),processing_owner=null,
              claim_token=null,claimed_at=null where id=$1`, [fixture.links[index].id, index % 2 ? 6000 : 10000]);
            await client.query(`update processing_jobs set processed_items=processed_items+1,
              success_items=success_items+1,updated_at=now() where id=$1`, [job]);
            await client.query('commit');
            timings.push(performance.now() - itemStart);
            break;
          } catch (error) {
            await client.query('rollback');
            if (['40P01','40001','55P03'].includes(error.code) && attempt < 2) { retries++; await sleep(10 * (attempt + 1)); }
            else { failures.push({ index, code: error.code, message: error.message }); break; }
          }
        }
      }
      await client.query('select pg_stat_force_next_flush()');
    }));
    const elapsed = performance.now() - start;
    const after = await stats(admin);
    // Inspect BEFORE any repair or worker finalization can hide a race.
    const mismatches = await verifyTotals(admin, fixture.batches);
    const progress = (await admin.query('select processed_items,success_items,error_items from processing_jobs where id=$1', [job])).rows[0];
    const result = { kind, concurrency, round, size, sharedBatches: fixture.batches.length, updates,
      elapsedMs: rounded(elapsed), successful: timings.length, updatesPerSecond: rounded(timings.length * 1000 / elapsed),
      p50Ms: rounded(percentile(timings, .5)), p95Ms: rounded(percentile(timings, .95)),
      retries, failures, mismatches, progress,
      isolatedRecalc: { calls: recalcCalls, p50Ms: rounded(percentile(recalcTimes, .5)), p95Ms: rounded(percentile(recalcTimes, .95)),
        functions: statsDelta(recalcBefore, recalcAfter) }, functions: statsDelta(before, after) };
    console.log(JSON.stringify({ ...result, functions: undefined, isolatedRecalc: { ...result.isolatedRecalc, functions: undefined } }));
    return result;
  } finally {
    for (const client of clients) client.release();
    if (fixture) await removeFixture(admin, fixture);
    admin.release();
    await pool.end();
  }
}

async function main() {
  const s = await state();
  await migrate(s, databases.baseline, 43);
  await migrate(s, databases.candidate);
  const results = [];
  const file = path.join(base, `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    scope: 'Synthetic financial UPDATE trigger path + shared job progress; excludes ERP, contacts and history persistence.',
    complete: false, results };
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Report: ${file}`);
  for (let round = 1; round <= rounds; round++) {
    // Alternate version order to reduce warm-cache bias.
    for (const kind of round % 2 ? ['baseline','candidate'] : ['candidate','baseline']) {
      for (const concurrency of [1,2]) {
        results.push(await scenario(s, kind, concurrency, round));
        await fs.writeFile(file, JSON.stringify(report, null, 2));
      }
    }
  }
  report.complete = true;
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Report: ${file}`);
  if (results.some(r => r.failures.length || r.mismatches.length || r.progress.processed_items !== updates)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
