-- O endpoint de historico completo pode levar mais de cinco segundos para
-- entregar uma pagina de 200 registros. Sem margem de leitura, a pagina 2
-- nunca chega a ser analisada.
update public.processing_settings
set mensalidades_api_connect_timeout_ms = greatest(mensalidades_api_connect_timeout_ms, 30000),
    mensalidades_api_read_timeout_ms = greatest(mensalidades_api_read_timeout_ms, 30000),
    updated_at = now()
where settings_key = 'default';
