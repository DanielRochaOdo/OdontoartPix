-- Endurece o reprocessamento contra a principal falha observada em producao:
-- ERP_TIMEOUT em massa durante consultas concorrentes ao HistoricoCompleto.
--
-- Objetivos:
-- 1) reduzir a pressao simultanea sobre o ERP;
-- 2) dar tempo realista para conexao/leitura paginada;
-- 3) espaciar retries de timeout para evitar tempestade de novas chamadas;
-- 4) persistir processing_error_code no proprio associado, sem depender de logs.

-- Aplica imediatamente ao preset atualmente salvo os mesmos limites publicados
-- no codigo. O worker le processing_settings antes de processar, portanto a
-- mudanca passa a valer sem depender de o usuario salvar novamente o preset.
update public.processing_settings
set processing_concurrency = case preset_key
      when 'conservador' then 4
      when 'mediano' then 8
      when 'agressivo' then 12
      else least(greatest(coalesce(processing_concurrency, 8), 1), 12)
    end,
    processing_erp_concurrency = case preset_key
      when 'conservador' then 4
      when 'mediano' then 8
      when 'agressivo' then 12
      else least(greatest(coalesce(processing_erp_concurrency, processing_concurrency, 8), 1), 12)
    end,
    processing_persistence_batch_size = case preset_key
      when 'conservador' then 4
      when 'mediano' then 8
      when 'agressivo' then 12
      else least(greatest(coalesce(processing_persistence_batch_size, 8), 1), 12)
    end,
    processing_max_buffered_results = case preset_key
      when 'conservador' then 4
      when 'mediano' then 8
      when 'agressivo' then 12
      else least(greatest(coalesce(processing_max_buffered_results, 8), 1), 12)
    end,
    mensalidades_api_connect_timeout_ms = 15000,
    mensalidades_api_read_timeout_ms = 20000,
    processing_max_attempts = 3,
    processing_worker_cycle_budget_ms = 110000,
    updated_at = timezone('utc', now())
where settings_key = 'default';

-- O wrapper atual ja concentra toda persistencia da onda (inclusive
-- DataPagamento). Mantemos essa implementacao intacta como base interna e
-- acrescentamos apenas a politica de timeout + codigo diagnostico.
alter function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  rename to persist_processing_wave_v1_before_timeout_hardening_v1;

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
  v_adjusted_results jsonb;
  v_now timestamptz := timezone('utc', now());
begin
  -- Para ERP_TIMEOUT, o retry curto anterior (aprox. 1,2s / 2,4s) fazia a
  -- segunda chamada chegar enquanto o ERP ainda estava sob a mesma pressao.
  -- A primeira repeticao espera 10s e a segunda 30s. Retry-After de HTTP 429
  -- continua sendo tratado no worker e nao passa por esta regra.
  select coalesce(
    jsonb_agg(
      case
        when item->>'resultType' = 'retry'
         and item->>'errorCode' = 'ERP_TIMEOUT'
        then jsonb_set(
          item,
          '{nextRetryAt}',
          to_jsonb(
            (
              v_now + case
                when coalesce(cbm.processing_attempts, 1) <= 1
                  then interval '10 seconds'
                else interval '30 seconds'
              end
            )::text
          ),
          true
        )
        else item
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  into v_adjusted_results
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
       with ordinality as entries(item, ordinal)
  left join public.campaign_batch_members cbm
    on cbm.id = nullif(item->>'campaignBatchMemberId', '')::uuid;

  v_summary := public.persist_processing_wave_v1_before_timeout_hardening_v1(
    p_job_id,
    p_batch_id,
    p_worker_id,
    p_wave_id,
    v_adjusted_results
  );

  -- processing_error_code e estado funcional do processamento, nao log.
  -- Persiste o codigo somente quando o resultado desta onda realmente venceu
  -- a disputa de claim e produziu o estado tecnico correspondente.
  with result_codes as (
    select
      (item->>'campaignBatchMemberId')::uuid as member_id,
      item->>'resultType' as result_type,
      nullif(left(item->>'errorCode', 100), '') as error_code
    from jsonb_array_elements(v_adjusted_results) item
  )
  update public.campaign_batch_members cbm
     set processing_error_code = case
           when rc.result_type = 'success' then null
           else rc.error_code
         end,
         updated_at = timezone('utc', now())
    from result_codes rc
   where cbm.id = rc.member_id
     and (
       (rc.result_type = 'success' and cbm.processing_status = 'completed')
       or (rc.result_type = 'retry' and cbm.processing_status = 'retrying')
       or (rc.result_type = 'error' and cbm.processing_status = 'error')
     );

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1_before_timeout_hardening_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;

-- Classifica os timeouts ja existentes para que a tela/SQL nao mostre mais
-- SEM_CODIGO. Nenhum status, valor financeiro ou tentativa e alterado aqui.
update public.campaign_batch_members
   set processing_error_code = 'ERP_TIMEOUT',
       updated_at = timezone('utc', now())
 where processing_status in ('error', 'retrying')
   and processing_error_code is null
   and trim(coalesce(last_error, '')) = 'A consulta ao ERP excedeu o tempo limite.';
