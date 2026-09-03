-- Reconciliacao defensiva para bases legadas: um vinculo importado/pending mais
-- recente nao pode apagar uma verdade financeira ja confirmada em outro vinculo.
-- Entre verdades confirmadas, a observacao mais recente continua vencendo.

with ranked as (
  select
    cbm.member_id,
    trim(cbm.target_installment_id) as installment_code,
    cbm.due_date_text,
    cbm.installment_amount_cents,
    cbm.payment_amount_cents,
    cbm.total_pending_amount_cents,
    cbm.payment_status,
    cbm.payment_status_source,
    cbm.last_erp_status_at,
    cbm.last_checked_at,
    cbm.updated_at,
    cbm.created_at,
    target.base_amount_cents as target_base_amount_cents,
    target.paid_amount_cents as target_paid_amount_cents,
    target.payment_description,
    target.payment_date_text,
    row_number() over (
      partition by cbm.member_id, trim(cbm.target_installment_id)
      order by
        case when cbm.payment_status in ('paid', 'unpaid', 'agreed') then 0 else 1 end,
        case
          when cbm.last_erp_status_at is not null
            or coalesce(cbm.payment_status_source, '') like 'erp_%'
          then 0
          else 1
        end,
        coalesce(cbm.last_erp_status_at, cbm.last_checked_at, cbm.updated_at, cbm.created_at) desc,
        cbm.updated_at desc,
        cbm.created_at desc,
        cbm.id desc
    ) as rn
  from campaign_batch_members cbm
  left join lateral (
    select
      mi.base_amount_cents,
      mi.paid_amount_cents,
      nullif(trim(mi.payment_description), '') as payment_description,
      nullif(trim(mi.payment_date_text), '') as payment_date_text
    from member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
    order by mi.updated_at desc, mi.created_at desc, mi.id desc
    limit 1
  ) target on true
  where cbm.deleted_at is null
    and nullif(trim(cbm.target_installment_id), '') is not null
), source as (
  select * from ranked where rn = 1
)
update member_target_installments canonical
   set due_date_text = coalesce(source.due_date_text, canonical.due_date_text),
       amount_cents = greatest(coalesce(source.target_base_amount_cents, source.installment_amount_cents, canonical.amount_cents, 0), 0),
       paid_amount_cents = case
         when source.payment_status = 'agreed' then 0
         else greatest(coalesce(source.target_paid_amount_cents, source.payment_amount_cents, canonical.paid_amount_cents, 0), 0)
       end,
       pending_amount_cents = greatest(coalesce(source.total_pending_amount_cents, canonical.pending_amount_cents, 0), 0),
       payment_status = coalesce(source.payment_status, canonical.payment_status),
       payment_status_source = coalesce(source.payment_status_source, canonical.payment_status_source),
       payment_description = coalesce(source.payment_description, canonical.payment_description),
       payment_date_text = coalesce(source.payment_date_text, canonical.payment_date_text),
       amount_source = case
         when source.last_erp_status_at is not null
           or coalesce(source.payment_status_source, '') like 'erp_%'
         then 'erp'
         else canonical.amount_source
       end,
       last_erp_status_at = coalesce(source.last_erp_status_at, canonical.last_erp_status_at),
       financial_observed_at = coalesce(
         source.last_erp_status_at,
         source.last_checked_at,
         source.updated_at,
         source.created_at,
         canonical.financial_observed_at
       ),
       updated_at = now()
  from source
 where canonical.member_id = source.member_id
   and canonical.external_installment_code = source.installment_code;

do $$
declare
  v_target record;
begin
  for v_target in select id from member_target_installments loop
    perform sync_target_installment_links_v1(v_target.id);
  end loop;
end;
$$;

insert into schema_migrations(version, name)
values (27, 'reconcile_canonical_backfill_truth')
on conflict (version) do nothing;
