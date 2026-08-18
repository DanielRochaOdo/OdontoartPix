-- A API de mensalidades pode levar mais de cinco segundos ate enviar os
-- cabecalhos da resposta, especialmente na primeira pagina de historico.
update public.processing_settings
set mensalidades_api_connect_timeout_ms = greatest(mensalidades_api_connect_timeout_ms, 30000),
    updated_at = now()
where settings_key = 'default';
