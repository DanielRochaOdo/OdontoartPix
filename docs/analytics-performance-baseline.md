# Visão Analítica — Fase 1: linha de base de desempenho

Este diagnóstico é **opt-in** e não altera consultas SQL, filtros, valores, índices, esquema,
concorrência ou configuração do PostgreSQL. A instrumentação mede a duração percebida
pela aplicação (inclui espera no pool do Node, execução no banco e transferência de resultado).

## Habilitação controlada

Por padrão, `ANALYTICS_PERF_ENABLED` não está definida e **nenhum evento é emitido**.

1. Após publicar a versão validada pelo deploy seguro, configure temporariamente
   `ANALYTICS_PERF_ENABLED: "true"` **apenas em** `services.app.environment`
   de `/opt/odontopix/compose.yaml`. Preserve as outras variáveis e credenciais.
   Alterar somente o arquivo `.env` não basta se o Compose não repassar essa variável.
2. Recrie **somente o app** com
   `docker compose -f /opt/odontopix/compose.yaml up -d --no-deps --no-build --force-recreate app`
   e verifique `curl -fsS http://127.0.0.1:3100/api/health/db`.
   Não reinicie nem altere o container PostgreSQL ou o worker.
3. Navegue no módulo autorizado e aplique 3 a 5 vezes cada um dos cenários:
   - mês corrente sem outros filtros;
   - apenas um lote;
   - múltiplos lotes;
   - pesquisa textual;
   - faixa de horário e período combinados.
   Faça as medições em um momento de atividade representativa, sem provocar sincronização.
4. Resuma os logs sem compartilhar parâmetros de pesquisa:
   ```bash
   docker logs --since 30m odontopix-app-1 2>&1 |
     python3 /opt/odontopix/app/scripts/summarize-analytics-performance.py
   ```
5. Ao concluir, remova `ANALYTICS_PERF_ENABLED` de `services.app.environment`
   (ou atribua `"false"`) e recrie **apenas o app** com o comando acima.

## O que o evento registra

Formato `[ANALYTICS_PERF] { ... }`. Campos: `traceId` aleatório, aba `tab`, etapa
`stage`, tempo `elapsedMs`, resultado `outcome`, e contadores do pool
`poolTotal`, `poolIdle`, `poolWaiting`.

Etapas: `metrics`, `groups`, `page`, `facet_status`, `facet_payment`,
`facet_receipt`, `facet_installmentType`, `facet_campaign`, `facet_batch`,
`request_data_total`.

**Não registra** nomes, CPF, IDs de associados, nomes de lotes, valores dos filtros,
texto SQL, endereços IP ou dados financeiros. Não executa nenhuma consulta adicional.

Os tempos por etapa se sobrepõem porque as consultas continuam em paralelo;
não devem ser somados para estimar o tempo total. Use `request_data_total`
para a espera de dados da página, lembrando que não inclui latência de rede
nem renderização do navegador.

## Gates da Fase 1

- Nenhuma mudança no resultado financeiro ou na quantidade de consultas.
- Os testes e o build de produção precisam passar.
- Registrar p50 e p95 de `request_data_total`, de cada `facet_*` e de
  `metrics`, `groups`, `page`, bem como o pico de `poolWaiting`.
- Somente depois desse baseline iniciar cache, seletividade por aba e refatoração SQL.
