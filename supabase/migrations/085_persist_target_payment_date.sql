-- Persiste DataPagamento retornada pelo ERP sem separar a gravacao da onda.
-- A RPC publica mantem o mesmo nome/assinatura; a implementacao anterior vira
-- a base interna e o wrapper acrescenta somente a data de pagamento.

alter table if exists public.member_installments
  add column if not exists payment_date_text text;

alter function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  rename to persist_processing_wave_v1_without_payment_date_v1;

create function public.persist_processing_wave_v1(
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
begin
  v_summary := public.persist_processing_wave_v1_without_payment_date_v1(
    p_job_id,
    p_batch_id,
    p_worker_id,
    p_wave_id,
    p_results
  );

  with success_items as (
    select
      (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id,
      item->'analysis' as analysis
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) item
    where item->>'resultType' = 'success'
  ), payment_dates as (
    select
      success_items.campaign_batch_member_id,
      installment->>'installmentCode' as installment_code,
      nullif(trim(installment->>'paymentDate'), '') as payment_date_text
    from success_items
    cross join lateral jsonb_array_elements(
      coalesce(success_items.analysis->'installments', '[]'::jsonb)
    ) installment
  )
  update public.member_installments persisted
  set payment_date_text = dates.payment_date_text,
      updated_at = now()
  from payment_dates dates
  where persisted.campaign_batch_member_id = dates.campaign_batch_member_id
    and trim(persisted.cod_parcela) = trim(dates.installment_code);

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1_without_payment_date_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
