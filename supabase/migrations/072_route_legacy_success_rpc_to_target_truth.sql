-- A migration 009 criou persist_member_processing_success com 4 argumentos.
-- A migration 059 adicionou uma sobrecarga com 5 argumentos e default, sem
-- substituir a assinatura antiga. Chamadas PostgREST com quatro argumentos
-- podiam continuar executando a lógica legada.
--
-- Mantemos a assinatura de 4 argumentos por compatibilidade, mas ela passa a
-- delegar explicitamente para a implementação canônica de 5 argumentos.

create or replace function public.persist_member_processing_success(
  p_campaign_batch_member_id uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.persist_member_processing_success(
    p_campaign_batch_member_id,
    p_http_status,
    p_duration_ms,
    p_analysis,
    true
  );
end;
$$;

revoke all on function public.persist_member_processing_success(uuid, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_success(uuid, integer, integer, jsonb)
  to service_role;
