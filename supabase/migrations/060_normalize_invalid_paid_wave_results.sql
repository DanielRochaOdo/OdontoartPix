-- Resultados legados que chegam como paid sem confirmacao explicita da
-- parcela-alvo devem voltar para a fila, sem derrubar o job inteiro.

create or replace function public.persist_processing_wave_v1(
  p_job_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_wave_id uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary jsonb;
  v_normalized_results jsonb;
begin
  select coalesce(
    jsonb_agg(
      case
        when result_item->>'resultType' = 'success'
          and result_item->'analysis'->>'paymentStatus' = 'paid'
          and not exists (
            select 1
            from jsonb_array_elements(coalesce(result_item->'analysis'->'installments', '[]'::jsonb)) installment
            where trim(installment->>'installmentCode') = trim(
              coalesce(
                (
                  select cbm.target_installment_id
                  from public.campaign_batch_members cbm
                  where cbm.id = (result_item->>'campaignBatchMemberId')::uuid
                ),
                ''
              )
            )
              and nullif(trim(installment->>'paidAmountCents'), '') is not null
              and nullif(trim(coalesce(installment->>'paymentDescription', installment->>'situation')), '') is not null
              and upper(trim(coalesce(installment->>'paymentDescription', installment->>'situation'))) <> 'ABERTO'
          )
        then jsonb_set(
          jsonb_set(
            jsonb_set(result_item, '{analysis,paymentStatus}', '"unpaid"'::jsonb, true),
            '{analysis,paymentStatusSource}', '"erp_open_invoice"'::jsonb, true
          ),
          '{nextCheckAt}', to_jsonb((now() + interval '55 minutes')::text), true
        )
        else result_item
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  into v_normalized_results
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) with ordinality as entries(result_item, ordinal);

  v_summary := public.persist_processing_wave_v1_legacy(
    p_job_id,
    p_batch_id,
    p_worker_id,
    p_wave_id,
    v_normalized_results
  );

  with success_items as (
    select
      (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id,
      item->'analysis' as analysis
    from jsonb_array_elements(v_normalized_results) item
    where item->>'resultType' = 'success'
  ), installment_values as (
    select
      success_items.campaign_batch_member_id,
      installment->>'installmentCode' as installment_code,
      case
        when installment ? 'paidAmountCents'
          and installment->>'paidAmountCents' is not null
        then (installment->>'paidAmountCents')::bigint
        else null
      end as paid_amount_cents
    from success_items
    cross join lateral jsonb_array_elements(coalesce(success_items.analysis->'installments', '[]'::jsonb)) installment
  )
  update public.member_installments persisted
  set paid_amount_cents = iv.paid_amount_cents,
      updated_at = now()
  from installment_values iv
  where persisted.campaign_batch_member_id = iv.campaign_batch_member_id
    and persisted.cod_parcela = iv.installment_code;

  update public.campaign_batch_members cbm
  set payment_amount_cents = coalesce((
    select mi.paid_amount_cents
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      and mi.paid_amount_cents is not null
      and nullif(trim(mi.situation), '') is not null
      and upper(trim(mi.situation)) <> 'ABERTO'
  ), 0),
      updated_at = now()
  where cbm.id in (
    select (item->>'campaignBatchMemberId')::uuid
    from jsonb_array_elements(v_normalized_results) item
    where item->>'resultType' = 'success'
  );

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
