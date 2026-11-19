// Isolated localhost lab. Never loads .env or .env.local.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const base = path.join(repo, '.local', 'financial-lab');
const stateFile = path.join(base, 'state.json');
const marker = 'odontoartpix-financial-lab-v1';
export const databases = Object.fromEntries(['baseline', 'candidate', 'test', 'dev'].map(k => [k, `odontoart_pix_lab_${k}`]));
const exec = promisify(execFile);
const binary = name => process.platform === 'win32' ? `${name}.exe` : name;
const exists = async file => fs.access(file).then(() => true, () => false);

export async function state() {
  const value = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  if (value.marker !== marker || value.host !== '127.0.0.1' || value.port !== 15432 ||
      path.resolve(value.data) !== path.join(base, 'data')) throw new Error('Invalid isolated lab state.');
  return value;
}

export function connection(s, database) {
  if (database !== 'postgres' && !Object.values(databases).includes(database)) throw new Error('Database outside lab allowlist.');
  return { host: '127.0.0.1', port: 15432, user: 'financial_lab', password: s.password,
    database, ssl: false, connectionTimeoutMillis: 5000, application_name: 'financial-local-lab' };
}

export async function assertServer(client, s) {
  const { rows: [r] } = await client.query("select current_setting('data_directory') as directory, host(inet_server_addr()) as host, inet_server_port() as port");
  if (path.resolve(r.directory).toLowerCase() !== s.data.toLowerCase() || r.host !== '127.0.0.1' || r.port !== 15432)
    throw new Error('Connected server is not this isolated lab.');
}

export function environment(s, database) {
  connection(s, database);
  return { ...process.env, DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '15432', DATABASE_NAME: database,
    DATABASE_USER: 'financial_lab', DATABASE_PASSWORD: s.password, DATABASE_SSL: 'false', DATABASE_POOL_MAX: '10',
    AUTH_COOKIE_SECURE: 'false', MENSALIDADES_API_BASE_URL: 'http://127.0.0.1:3101', MENSALIDADES_API_TOKEN: 'local-fixture',
    PROCESSING_ALLOW_SCHEDULED_SYNC: 'false', PROCESSING_PIPELINE_V2_ENABLED: 'true',
    PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED: 'true', PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED: 'true',
    GENERAL_SYNC_UNIQUE_TARGETS_ENABLED: 'true', PROCESSING_PERSISTENCE_PROFILE_ENABLED: 'true',
    PROCESSING_PERSISTENCE_PILOT_ENABLED: 'false', PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED: 'false',
    PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1' };
}

async function run(file, args) {
  return exec(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
}

export async function migrate(s, database, maxVersion = Infinity) {
  const client = new pg.Client(connection(s, database));
  await client.connect();
  try {
    await assertServer(client, s);
    await client.query('create table if not exists schema_migrations(version integer primary key, name text not null, applied_at timestamptz not null default now())');
    await client.query('select pg_advisory_lock(2026082401)');
    const files = (await fs.readdir(path.join(repo, 'db/migrations'))).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (version > maxVersion || (await client.query('select 1 from schema_migrations where version=$1', [version])).rowCount) continue;
      await client.query('begin');
      try {
        await client.query(await fs.readFile(path.join(repo, 'db/migrations', file), 'utf8'));
        await client.query('insert into schema_migrations(version,name) values($1,$2) on conflict do nothing', [version, file]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw new Error(`${database}: ${file}: ${error.message}`, { cause: error }); }
    }
  } finally { await client.end(); }
  console.log(`Migrations ready: ${database} (limit ${maxVersion}).`);
}

async function up() {
  await fs.mkdir(base, { recursive: true });
  let s;
  if (await exists(stateFile)) s = await state();
  else {
    const binIndex = process.argv.indexOf('--bin');
    const bin = path.resolve(binIndex < 0 ? path.join(base, 'tools/pgsql/bin') : process.argv[binIndex + 1]);
    if (!await exists(path.join(bin, binary('initdb')))) throw new Error('PostgreSQL binaries missing. Pass --bin directory.');
    const data = path.join(base, 'data');
    if (await exists(data)) throw new Error('Data directory exists without a lab marker.');
    s = { marker, host: '127.0.0.1', port: 15432, bin, data, password: randomBytes(24).toString('base64url'),
      adminPassword: randomBytes(15).toString('base64url') };
    const passwordFile = path.join(base, 'init-password.tmp');
    await fs.writeFile(passwordFile, s.password, { mode: 0o600 });
    try { await run(path.join(bin, binary('initdb')), ['-D', data, '-U', 'financial_lab', '-E', 'UTF8', '--locale=C', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]); }
    finally { await fs.rm(passwordFile, { force: true }); }
    await fs.appendFile(path.join(data, 'postgresql.conf'), "\nlisten_addresses='127.0.0.1'\nport=15432\nmax_connections=40\nshared_buffers='128MB'\ntrack_functions='pl'\nlog_lock_waits=on\ndeadlock_timeout='100ms'\nfsync=on\nsynchronous_commit=on\n");
    await fs.writeFile(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  const ctl = path.join(s.bin, binary('pg_ctl'));
  let running = true;
  try { await run(ctl, ['-D', s.data, 'status']); } catch (e) { if (e.code === 3) running = false; else throw e; }
  if (!running) await new Promise((resolve, reject) => {
    // PostgreSQL inherits pipe handles on Windows. Wait for pg_ctl exit, with
    // no pipes held open by the background server.
    const starter = spawn(ctl, ['-D', s.data, '-l', path.join(base, 'postgres.log'), '-w', 'start'],
      { windowsHide: true, stdio: 'ignore' });
    starter.once('error', reject);
    starter.once('exit', code => code === 0 ? resolve() : reject(new Error(`pg_ctl start exited ${code}; inspect postgres.log`)));
  });
  const admin = new pg.Client(connection(s, 'postgres'));
  await admin.connect();
  try {
    await assertServer(admin, s);
    for (const database of Object.values(databases)) {
      if (!(await admin.query('select 1 from pg_database where datname=$1', [database])).rowCount) await admin.query(`create database "${database}"`);
    }
  } finally { await admin.end(); }
  console.log('Isolated PostgreSQL ready at 127.0.0.1:15432.');
}

async function child(script, args, env) {
  const processChild = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('exit', code => code === 0 ? resolve() : reject(new Error(`Command exited ${code}`)));
  });
}

export function workerOptions(args) {
  const pollArg = args.find(arg => arg.startsWith('--poll-ms='));
  const pollMs = pollArg ? Number(pollArg.slice('--poll-ms='.length)) : 5000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new Error('--poll-ms must be an integer >= 1000.');
  return { watch: args.includes('--watch'), pollMs,
    args: ['--drain', ...args.filter(arg => arg !== '--watch' && arg !== '--drain' && !arg.startsWith('--poll-ms='))] };
}

async function worker(s, args) {
  const options = workerOptions(args);
  const execute = () => child(path.join(repo, 'node_modules/tsx/dist/cli.mjs'),
    ['scripts/process-local-worker.ts', ...options.args], environment(s, databases.dev));
  if (!options.watch) return execute();

  const check = new pg.Client(connection(s, databases.dev));
  await check.connect();
  try { await assertServer(check, s); } finally { await check.end(); }
  const stopFile = path.join(base, 'worker-service.stop');
  const statusFile = path.join(base, 'worker-service.json');
  await fs.rm(stopFile, { force: true });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const report = status => fs.writeFile(statusFile, JSON.stringify({
    pid: process.pid, status, database: databases.dev, updatedAt: new Date().toISOString(), pollMs: options.pollMs
  }, null, 2));
  try {
    while (!stopping && !await exists(stopFile)) {
      await report('running_cycle');
      await execute();
      await report('waiting');
      // Idle/future retries still wait even with --delay-ms=0.
      const deadline = Date.now() + options.pollMs;
      while (!stopping && Date.now() < deadline && !await exists(stopFile)) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      }
    }
    await report('stopped');
  } catch (error) { await report('failed'); throw error; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (command === 'up') return up();
  const s = await state();
  if (command === 'status') console.log((await run(path.join(s.bin, binary('pg_ctl')), ['-D', s.data, 'status'])).stdout.trim());
  else if (command === 'stop') await run(path.join(s.bin, binary('pg_ctl')), ['-D', s.data, '-m', 'fast', '-w', 'stop']);
  else if (command === 'migrate') {
    for (const [kind, database] of Object.entries(databases)) await migrate(s, database, kind === 'baseline' ? 43 : Infinity);
  } else if (command === 'test') {
    await migrate(s, databases.test);
    await child(path.join(repo, 'node_modules/vitest/vitest.mjs'), ['run', ...process.argv.slice(3)], { ...environment(s, databases.test), CI: 'true' });
  } else if (command === 'dev') {
    await migrate(s, databases.dev);
    const { startMockErp } = await import('./local-financial-fixtures.mjs');
    const server = await startMockErp(s);
    try { await child(path.join(repo, 'node_modules/next/dist/bin/next'), ['dev', '--hostname', '127.0.0.1', '--port', '3100'], environment(s, databases.dev)); }
    finally { server.close(); }
  } else if (command === 'worker') {
    await worker(s, process.argv.slice(3));
  } else if (command === 'worker-stop') {
    await fs.writeFile(path.join(base, 'worker-service.stop'), 'stop after current cycle');
    console.log('Local worker will stop after its current cycle.');
  } else throw new Error('Usage: local-financial-lab.mjs up|status|stop|migrate|test|dev|worker [--watch]|worker-stop');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
