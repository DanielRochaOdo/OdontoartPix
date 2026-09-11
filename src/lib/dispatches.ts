import { dbQuery, getDbPool } from "@/lib/db/pool";

export type DispatchFilters = {
  query?: string;
  code?: string;
  installment?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  paymentDateFrom?: string;
  paymentDateTo?: string;
  status?: string[];
  payment?: string[];
  paidPending?: "all" | "yes" | "no";
  receipt?: string[];
  installmentType?: string[];
  campaign?: string[];
  batch?: string[];
  dispatchCount?: "all" | "never" | "1" | "2" | "3" | "4plus";
  lastDispatchFrom?: string;
  lastDispatchTo?: string;
};

export type DispatchListItem = {
  id: string;
  target_installment_ref_id: string;
  campaign_id: string;
  batch_id: string;
  member_id: string;
  target_installment_id: string;
  installment_type: string | null;
  due_date_text: string | null;
  processing_status: string;
  payment_status: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  installment_amount_cents: number;
  payment_amount_cents: number | null;
  total_pending_amount_cents: number;
  dispatch_count: number;
  last_dispatch_date: string | null;
  member: {
    cpf: string | null;
    name: string | null;
    external_user_code: string | null;
  };
  campaign: { name: string };
  batch: { name: string };
};

export type DispatchOperationHistoryItem = {
  id: string;
  requestKey: string;
  dispatchDate: string;
  status: "completed" | "reverted";
  itemCount: number;
  totalAmountCents: number;
  campaignNames: string;
  batchNames: string;
  createdByName: string;
  createdAt: string;
  revertedAt: string | null;
  filters: DispatchFilters;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function unique(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function safeDate(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return DATE_KEY.test(trimmed) ? trimmed : "";
}

export function normalizeDispatchFilters(filters: DispatchFilters = {}): DispatchFilters {
  const dispatchCount = ["never", "1", "2", "3", "4plus"].includes(filters.dispatchCount ?? "")
    ? filters.dispatchCount
    : "all";
  const paidPending = filters.paidPending === "yes" || filters.paidPending === "no"
    ? filters.paidPending
    : "all";

  return {
    query: filters.query?.trim() ?? "",
    code: filters.code?.trim() ?? "",
    installment: filters.installment?.trim() ?? "",
    dueDateFrom: safeDate(filters.dueDateFrom),
    dueDateTo: safeDate(filters.dueDateTo),
    paymentDateFrom: safeDate(filters.paymentDateFrom),
    paymentDateTo: safeDate(filters.paymentDateTo),
    status: unique(filters.status),
    payment: unique(filters.payment),
    paidPending,
    receipt: unique(filters.receipt),
    installmentType: unique(filters.installmentType),
    campaign: unique(filters.campaign),
    batch: unique(filters.batch),
    dispatchCount,
    lastDispatchFrom: safeDate(filters.lastDispatchFrom),
    lastDispatchTo: safeDate(filters.lastDispatchTo)
  };
}

function scopeValues(filters: DispatchFilters, targetIds: string[] = [], onlyEligible = false) {
  const normalized = normalizeDispatchFilters(filters);
  return [
    normalized.campaign ?? [],
    normalized.batch ?? [],
    normalized.status ?? [],
    normalized.payment ?? [],
    normalized.receipt ?? [],
    normalized.installmentType ?? [],
    normalized.query || null,
    normalized.code || null,
    normalized.installment || null,
    normalized.dueDateFrom || null,
    normalized.dueDateTo || null,
    normalized.paymentDateFrom || null,
    normalized.paymentDateTo || null,
    normalized.paidPending ?? "all",
    normalized.dispatchCount ?? "all",
    normalized.lastDispatchFrom || null,
    normalized.lastDispatchTo || null,
    targetIds,
    onlyEligible
  ] as const;
}

const FILTERED_SCOPE_CTE = `with scoped_links as (
  select cbm.*,
         c.name as campaign_name,
         b.name as batch_name
    from campaign_batch_members cbm
    join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
    join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
   where cbm.deleted_at is null
     and cbm.target_installment_ref_id is not null
     and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
     and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
), grouped as (
  select
    target_installment_ref_id,
    (array_agg(id order by created_at desc, id desc))[1] as representative_id,
    (array_agg(campaign_id order by created_at desc, id desc))[1] as representative_campaign_id,
    (array_agg(batch_id order by created_at desc, id desc))[1] as representative_batch_id,
    case
      when bool_or(processing_status = 'error') then 'error'
      when bool_or(processing_status = 'processing') then 'processing'
      when bool_or(processing_status = 'retrying') then 'retrying'
      when bool_and(processing_status = 'completed') then 'completed'
      else 'pending'
    end as aggregate_processing_status,
    string_agg(distinct campaign_name, ', ' order by campaign_name) as campaign_names,
    string_agg(distinct batch_name, ', ' order by batch_name) as batch_names
  from scoped_links
  group by target_installment_ref_id
), dispatch_stats as (
  select
    de.target_installment_ref_id,
    count(*)::int as dispatch_count,
    max(de.dispatch_date)::date as last_dispatch_date
  from dispatch_events de
  join dispatch_operations operation
    on operation.id = de.operation_id
   and operation.status = 'completed'
  where (cardinality($1::uuid[]) = 0 or de.campaign_id = any($1::uuid[]))
    and (cardinality($2::uuid[]) = 0 or de.batch_id = any($2::uuid[]))
  group by de.target_installment_ref_id
), base as (
  select
    grouped.representative_id as id,
    grouped.target_installment_ref_id,
    grouped.representative_campaign_id as campaign_id,
    grouped.representative_batch_id as batch_id,
    canonical.member_id,
    canonical.external_installment_code as target_installment_id,
    canonical.installment_type,
    canonical.due_date_text,
    canonical.payment_status,
    canonical.payment_description,
    canonical.payment_date_text,
    canonical.amount_cents,
    canonical.paid_amount_cents,
    canonical.pending_amount_cents,
    grouped.aggregate_processing_status as processing_status,
    grouped.campaign_names,
    grouped.batch_names,
    m.name as member_name,
    m.cpf,
    m.external_user_code,
    coalesce(dispatch_stats.dispatch_count, 0) as dispatch_count,
    dispatch_stats.last_dispatch_date,
    case
      when canonical.payment_status = 'agreed' then '-'
      else coalesce(nullif(trim(canonical.payment_description), ''), '-')
    end as receipt_description,
    case
      when trim(coalesce(canonical.due_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$'
        then to_date(trim(canonical.due_date_text), 'DD/MM/YYYY')
      when trim(coalesce(canonical.due_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
        then to_date(substring(trim(canonical.due_date_text) from 1 for 10), 'YYYY-MM-DD')
      when trim(coalesce(canonical.due_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
        then to_date(trim(canonical.due_date_text), 'MM/DD/YY')
      else null
    end as due_date,
    case
      when trim(coalesce(canonical.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$'
        then to_date(trim(canonical.payment_date_text), 'DD/MM/YYYY')
      when trim(coalesce(canonical.payment_date_text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
        then to_date(substring(trim(canonical.payment_date_text) from 1 for 10), 'YYYY-MM-DD')
      when trim(coalesce(canonical.payment_date_text, '')) ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$'
        then to_date(trim(canonical.payment_date_text), 'MM/DD/YY')
      else null
    end as payment_date
  from grouped
  join member_target_installments canonical on canonical.id = grouped.target_installment_ref_id
  join members m on m.id = canonical.member_id and m.deleted_at is null
  left join dispatch_stats on dispatch_stats.target_installment_ref_id = grouped.target_installment_ref_id
), filtered as (
  select *
  from base
  where (cardinality($3::text[]) = 0 or processing_status = any($3::text[]))
    and (cardinality($4::text[]) = 0 or payment_status = any($4::text[]))
    and (cardinality($5::text[]) = 0 or receipt_description = any($5::text[]))
    and (cardinality($6::text[]) = 0 or installment_type = any($6::text[]))
    and ($7::text is null or lower(concat_ws(' ', member_name, cpf, external_user_code, target_installment_id, installment_type, due_date_text, campaign_names, batch_names, processing_status, payment_status, receipt_description, payment_date_text)) like '%' || lower($7::text) || '%')
    and ($8::text is null or external_user_code = $8::text)
    and ($9::text is null or target_installment_id = $9::text)
    and ($10::date is null or due_date >= $10::date)
    and ($11::date is null or due_date <= $11::date)
    and ($12::date is null or payment_date >= $12::date)
    and ($13::date is null or payment_date <= $13::date)
    and (
      $14::text = 'all'
      or ($14::text = 'yes' and payment_status = 'paid' and pending_amount_cents > 0)
      or ($14::text = 'no' and pending_amount_cents <= 0)
    )
    and (
      $15::text = 'all'
      or ($15::text = 'never' and dispatch_count = 0)
      or ($15::text = '1' and dispatch_count = 1)
      or ($15::text = '2' and dispatch_count = 2)
      or ($15::text = '3' and dispatch_count = 3)
      or ($15::text = '4plus' and dispatch_count >= 4)
    )
    and ($16::date is null or last_dispatch_date >= $16::date)
    and ($17::date is null or last_dispatch_date <= $17::date)
    and (cardinality($18::uuid[]) = 0 or target_installment_ref_id = any($18::uuid[]))
    and (
      not $19::boolean
      or (
        coalesce(payment_status, '') not in ('paid', 'agreed', 'excluded')
        and pending_amount_cents > 0
      )
    )
)`;

export async function getDispatchList(): Promise<DispatchListItem[]> {
  const result = await dbQuery<{
    id: string;
    target_installment_ref_id: string;
    campaign_id: string;
    batch_id: string;
    member_id: string;
    target_installment_id: string;
    installment_type: string | null;
    due_date_text: string | null;
    processing_status: string;
    payment_status: string | null;
    payment_description: string | null;
    payment_date_text: string | null;
    amount_cents: number;
    paid_amount_cents: number | null;
    pending_amount_cents: number;
    dispatch_count: number;
    last_dispatch_date: string | null;
    member_name: string | null;
    cpf: string | null;
    external_user_code: string | null;
    campaign_names: string;
    batch_names: string;
  }>(
    `${FILTERED_SCOPE_CTE}
     select id,
            target_installment_ref_id,
            campaign_id,
            batch_id,
            member_id,
            target_installment_id,
            installment_type,
            due_date_text,
            processing_status,
            payment_status,
            payment_description,
            payment_date_text,
            amount_cents::float8,
            paid_amount_cents::float8,
            pending_amount_cents::float8,
            dispatch_count,
            last_dispatch_date::text,
            member_name,
            cpf,
            external_user_code,
            campaign_names,
            batch_names
       from filtered
      order by member_name asc nulls last, target_installment_id asc`,
    scopeValues({}, [], false)
  );

  return result.rows.map((row) => ({
    id: row.id,
    target_installment_ref_id: row.target_installment_ref_id,
    campaign_id: row.campaign_id,
    batch_id: row.batch_id,
    member_id: row.member_id,
    target_installment_id: row.target_installment_id,
    installment_type: row.installment_type,
    due_date_text: row.due_date_text,
    processing_status: row.processing_status,
    payment_status: row.payment_status,
    payment_description: row.payment_description,
    payment_date_text: row.payment_date_text,
    installment_amount_cents: Number(row.amount_cents ?? 0),
    payment_amount_cents: row.paid_amount_cents == null ? null : Number(row.paid_amount_cents),
    total_pending_amount_cents: Number(row.pending_amount_cents ?? 0),
    dispatch_count: Number(row.dispatch_count ?? 0),
    last_dispatch_date: row.last_dispatch_date,
    member: {
      cpf: row.cpf,
      name: row.member_name,
      external_user_code: row.external_user_code
    },
    campaign: { name: row.campaign_names },
    batch: { name: row.batch_names }
  }));
}

export async function getDispatchHistory(limit = 100): Promise<DispatchOperationHistoryItem[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const result = await dbQuery<{
    id: string;
    request_key: string;
    dispatch_date: string;
    status: "completed" | "reverted";
    item_count: number;
    total_amount_cents: number;
    filters: DispatchFilters;
    created_at: string;
    reverted_at: string | null;
    created_by_name: string | null;
    campaign_names: string | null;
    batch_names: string | null;
  }>(
    `select operation.id,
            operation.request_key::text,
            operation.dispatch_date::text,
            operation.status,
            operation.item_count,
            operation.total_amount_cents::float8,
            operation.filters,
            operation.created_at::text,
            operation.reverted_at::text,
            coalesce(u.name, u.email, 'Usuário') as created_by_name,
            coalesce(labels.campaign_names, '-') as campaign_names,
            coalesce(labels.batch_names, '-') as batch_names
       from dispatch_operations operation
       left join users u on u.id = operation.created_by
       left join lateral (
         select string_agg(distinct c.name, ', ' order by c.name) as campaign_names,
                string_agg(distinct b.name, ', ' order by b.name) as batch_names
           from dispatch_events event
           left join campaigns c on c.id = event.campaign_id
           left join campaign_batches b on b.id = event.batch_id
          where event.operation_id = operation.id
       ) labels on true
      order by operation.created_at desc
      limit $1`,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    requestKey: row.request_key,
    dispatchDate: row.dispatch_date,
    status: row.status,
    itemCount: Number(row.item_count ?? 0),
    totalAmountCents: Number(row.total_amount_cents ?? 0),
    campaignNames: row.campaign_names ?? "-",
    batchNames: row.batch_names ?? "-",
    createdByName: row.created_by_name ?? "Usuário",
    createdAt: row.created_at,
    revertedAt: row.reverted_at,
    filters: normalizeDispatchFilters(row.filters ?? {})
  }));
}

export async function createDispatchOperation(input: {
  requestKey: string;
  dispatchDate: string;
  filters: DispatchFilters;
  targetIds?: string[];
  createdBy: string;
}) {
  const pool = getDbPool();
  const client = await pool.connect();
  const filters = normalizeDispatchFilters(input.filters);
  const targetIds = unique(input.targetIds).slice(0, 20_000);

  try {
    await client.query("begin");

    const existing = await client.query<{
      id: string;
      item_count: number;
      total_amount_cents: number;
      status: string;
    }>(
      `select id, item_count, total_amount_cents::float8, status
         from dispatch_operations
        where request_key = $1::uuid
        limit 1`,
      [input.requestKey]
    );

    if (existing.rows[0]) {
      await client.query("commit");
      return {
        id: existing.rows[0].id,
        itemCount: Number(existing.rows[0].item_count ?? 0),
        totalAmountCents: Number(existing.rows[0].total_amount_cents ?? 0),
        status: existing.rows[0].status,
        idempotent: true
      };
    }

    const operation = await client.query<{ id: string }>(
      `insert into dispatch_operations(request_key, dispatch_date, filters, created_by)
       values ($1::uuid, $2::date, $3::jsonb, $4::uuid)
       returning id`,
      [input.requestKey, input.dispatchDate, JSON.stringify(filters), input.createdBy]
    );
    const operationId = operation.rows[0]?.id;
    if (!operationId) throw new Error("Nao foi possivel criar a operacao de disparo.");

    const values = [...scopeValues(filters, targetIds, true), operationId, input.dispatchDate];
    const inserted = await client.query<{ item_count: number; total_amount_cents: number }>(
      `${FILTERED_SCOPE_CTE}, inserted as (
         insert into dispatch_events(
           operation_id,
           campaign_id,
           batch_id,
           campaign_batch_member_id,
           target_installment_ref_id,
           dispatch_date
         )
         select $20::uuid,
                filtered.campaign_id,
                filtered.batch_id,
                filtered.id,
                filtered.target_installment_ref_id,
                $21::date
           from filtered
         on conflict (operation_id, target_installment_ref_id) do nothing
         returning target_installment_ref_id
       )
       select count(*)::int as item_count,
              coalesce(sum(canonical.amount_cents), 0)::float8 as total_amount_cents
         from inserted
         join member_target_installments canonical
           on canonical.id = inserted.target_installment_ref_id`,
      values
    );

    const itemCount = Number(inserted.rows[0]?.item_count ?? 0);
    const totalAmountCents = Number(inserted.rows[0]?.total_amount_cents ?? 0);
    if (itemCount === 0) {
      await client.query("rollback");
      throw new Error("Nenhuma parcela elegivel para registrar disparo com os filtros atuais.");
    }

    await client.query(
      `update dispatch_operations
          set item_count = $2,
              total_amount_cents = $3
        where id = $1::uuid`,
      [operationId, itemCount, totalAmountCents]
    );

    await client.query("commit");
    return {
      id: operationId,
      itemCount,
      totalAmountCents,
      status: "completed",
      idempotent: false
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Mantem o erro original.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function revertDispatchOperation(operationId: string, revertedBy: string) {
  const result = await dbQuery<{ id: string; item_count: number }>(
    `update dispatch_operations
        set status = 'reverted',
            reverted_by = $2::uuid,
            reverted_at = now()
      where id = $1::uuid
        and status = 'completed'
      returning id, item_count`,
    [operationId, revertedBy]
  );

  if (!result.rows[0]) {
    throw new Error("Operacao nao encontrada ou ja revertida.");
  }

  return {
    id: result.rows[0].id,
    itemCount: Number(result.rows[0].item_count ?? 0)
  };
}
