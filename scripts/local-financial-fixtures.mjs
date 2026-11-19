import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { base, state, connection, assertServer, databases, migrate } from './local-financial-lab.mjs';

export async function seedFixture(client, size, label, processing = 'completed') {
  if (!Number.isSafeInteger(size) || size < 2 || size > 100000) throw new Error('Fixture size must be 2..100000.');
  const tag = randomUUID();
  const campaign = (await client.query('insert into campaigns(name) values($1) returning id', [`LAB ${label} ${tag.slice(0, 8)}`])).rows[0].id;
  const batches = (await client.query(`insert into campaign_batches(campaign_id,name)
    select $1, 'LAB lote ' || n from generate_series(1,3) n returning id`, [campaign])).rows.map(r => r.id);
  await client.query(`insert into members(cpf,cpf_hash,name,external_user_code)
    select '00000000000', $1 || ':' || n, 'Associado sintetico ' || n,
      $1 || ':' || lpad(n::text,6,'0') from generate_series(1,$2::int) n`, [tag, size]);
  await client.query(`insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,
    installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status)
    select $1::uuid,batch,m.id,'LAB-1',10000,'unpaid','erp_open_invoice',10000,$4
    from members m cross join unnest($2::uuid[]) batch where m.cpf_hash like $3`, [campaign, batches, `${tag}:%`, processing]);
  // These lab tables may have been empty at the last autovacuum. Refresh
  // statistics after bulk insertion before planning joins over the new mass.
  await client.query('analyze campaign_batch_members');
  await client.query('analyze member_target_installments');
  for (const batch of batches) await client.query('select recalculate_batch_totals($1)', [batch]);
  const { rows: links } = await client.query(`select cbm.id,m.external_user_code as code
    from campaign_batch_members cbm join members m on m.id=cbm.member_id
    where cbm.batch_id=$1 order by m.external_user_code`, [batches[0]]);
  return { tag, campaign, batches, links };
}

export async function removeFixture(client, fixture) {
  await client.query('delete from campaigns where id=$1', [fixture.campaign]);
  await client.query('delete from members where cpf_hash like $1', [`${fixture.tag}:%`]);
}

// Independent read-only oracle: never calls a recalculation function.
export async function verifyTotals(client, batchIds) {
  const { rows } = await client.query(`with expected as (
    select b.id,count(cbm.id)::int as total_records,
      count(cbm.id) filter(where cbm.processing_status='completed')::int as processed_records,
      count(cbm.id) filter(where canonical.payment_status='paid')::int as paid_records,
      count(cbm.id) filter(where canonical.payment_status='unpaid')::int as unpaid_records,
      count(cbm.id) filter(where cbm.processing_status='error' and
        (canonical.payment_status is null or canonical.payment_status not in ('paid','agreed','excluded')))::int as error_records,
      coalesce(sum(canonical.pending_amount_cents),0)::bigint as total_pending_amount_cents,
      coalesce(sum(canonical.amount_cents),0)::bigint as total_amount_cents,
      case when count(cbm.id) filter(where cbm.processing_status='processing')>0 then 'processando'
        when count(cbm.id) filter(where cbm.processing_status in ('pending','queued','retrying','aguardando') and
          (canonical.payment_status is null or canonical.payment_status not in ('paid','agreed','excluded')))>0 then 'aguardando'
        when count(cbm.id) filter(where cbm.processing_status='error' and
          (canonical.payment_status is null or canonical.payment_status not in ('paid','agreed','excluded')))>0 then 'concluido_com_erros'
        when count(cbm.id)>0 and count(cbm.id)=count(cbm.id) filter(where cbm.processing_status='completed') then 'concluido'
        else 'aguardando' end as status
    from campaign_batches b left join campaign_batch_members cbm on cbm.batch_id=b.id and cbm.deleted_at is null
    left join member_target_installments canonical on canonical.id=cbm.target_installment_ref_id
    where b.id=any($1::uuid[]) group by b.id
  ) select b.id, to_jsonb(b) as stored, to_jsonb(e) as expected
    from campaign_batches b join expected e on e.id=b.id
    where row(b.total_records,b.processed_records,b.paid_records,b.unpaid_records,b.error_records,
      b.total_pending_amount_cents,b.total_amount_cents,b.status) is distinct from
    row(e.total_records,e.processed_records,e.paid_records,e.unpaid_records,e.error_records,
      e.total_pending_amount_cents,e.total_amount_cents,e.status)`, [batchIds]);
  return rows;
}

export async function startMockErp(s, { port = 3101, failures = {}, delayMs = 0 } = {}) {
  const pool = new pg.Pool(connection(s, databases.dev));
  await assertServer(pool, s);
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

async function seedDev() {
  const s = await state();
  await migrate(s, databases.dev);
  const client = new pg.Client(connection(s, databases.dev));
  await client.connect();
  try {
    await assertServer(client, s);
    const existing = await client.query("select id from campaigns where name like 'LAB interface %' and deleted_at is null limit 1");
    if (!existing.rowCount) {
      await client.query('begin');
      try {
        const fixture = await seedFixture(client, 240, 'interface', 'pending');
        await client.query('commit');
        await fs.writeFile(path.join(base, 'dev-fixture.json'), JSON.stringify(fixture, null, 2));
      } catch (error) { await client.query('rollback'); throw error; }
    }
    const email = 'admin@localhost.local';
    await client.query(`insert into users(name,email,password_hash,role,active) values('Administrador local',$1,$2,'administrador',true)
      on conflict(lower(email)) do update set password_hash=excluded.password_hash,active=true`, [email, await bcrypt.hash(s.adminPassword, 10)]);
    await client.query(`update processing_settings set config=config || $1::jsonb where settings_key='default'`, [JSON.stringify({
      processing_persistence_concurrency: 2, processing_erp_concurrency: 8, processing_concurrency: 8,
      processing_block_size: 80, processing_max_buffered_results: 80, worker_count: 1,
      processing_productive_delay_ms: 0 })]);
    await client.query('update processing_scheduler_state set scheduler_enabled=false');
    await fs.writeFile(path.join(base, 'login.json'), JSON.stringify({ url: 'http://127.0.0.1:3100', email, password: s.adminPassword }, null, 2), { mode: 0o600 });
    console.log(`Synthetic UI ready. Login saved in ${path.join(base, 'login.json')}`);
  } finally { await client.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) seedDev().catch(error => { console.error(error); process.exitCode = 1; });
