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

## Fase 2a — cache local de catálogo após a primeira medição

**Linha de base de 17/11/2026:** 4 requisições completas de panorama,
`request_data_total` P50=3109,9 ms e P95=3260,9 ms; pico de
`poolWaiting`=6. Em média, as 6 facetas levaram 1,2–3,1 segundos
incluindo espera no pool, enquanto as 3 consultas analíticas levaram
~2,1–2,5 segundos. O P95 com N=4 é praticamente o máximo da amostra.

O módulo agora conserva **somente** a resposta global, sem filtros, de
`getAssociadosCardFilterOptions({})` por 180 segundos **após** concluir
a busca. Uma requisição simultânea aguarda o mesmo carregamento
(`singleflight`), e uma falha não é armazenada.

A aba continua sempre executando `metrics`, `groups` e `page`
diretamente no banco. Valores, status, somatórios e filtros financeiros
não são armazenados no cache; o SQL do catálogo permaneceu inalterado.

As etapas adicionais no log são `catalog_cache_hit`,
`catalog_cache_miss` e `catalog_inflight_wait`. Em acertos, os
eventos `facet_*` desaparecem porque as seis consultas realmente
deixam de ser executadas.

**Comparação pós-deploy:** antes e depois da publicação, medir
3–5 aplicações de filtros no mesmo módulo, ignorando o primeiro acesso
(cache frio). Comparar `request_data_total`, `poolWaiting` e
número de `facet_*`; nunca somar durações de consultas paralelas.
Primeiro acesso, ou acesso após TTL, ainda pode executar as seis facetas.

Limitações assumidas: cada processo/contêiner possui seu cache e as
opções podem ficar desatualizadas por até três minutos após mudanças.
Não existe Redis nem invalidação distribuída. A presença de mais
instâncias pode produzir um acerto e uma perda independentes.

Apenas após medir este ganho iniciar o carregamento seletivo por aba
(Fase 3) e o SQL *filter-first* com comparação de IDs canônicos (Fase 4).

## Fase 3 — consultas seletivas por aba

**Validação após o cache:** em quatro carregamentos de Panorama foram observados
3 `catalog_cache_hit` e 1 `catalog_cache_miss`; o P50 conjunto de
`request_data_total` foi 732,4 ms (amostra pequena e misturada). O cache
de opções evitou as 6 consultas de facetas nos 3 acertos, mas as 3 consultas
analíticas ainda foram chamadas mesmo quando sua resposta não era exibida.

Agora `getAnalyticsReport` executa sempre a consulta `metrics` e apenas
uma segunda consulta, dependendo da aba:

| Abas | Queries | Não executa |
|---|---|---|
| Panorama, Horários, Comportamento, Comparativos | `metrics` + `groups` | `page` (50 faturas) |
| Faturas | `metrics` + `page` | `groups` (gráficos) |

Retornos `rows: []` fora da aba Faturas e `groups: []` na aba Faturas
não afetam componentes, pois essas informações já não eram renderizadas
nas respectivas abas. Todas as métricas financeiras e parâmetros SQL
permanecem sem modificações; `ANALYTICS_BASE_SQL`, `METRICS_SQL`,
`GROUP_SQL`, `PAGE_SQL`, as 21 entradas de filtro e `getAnalyticsExportRows`
são preservados. A contagem e o pagamento da parcela canônica seguem
independentes do número de lotes associados.

O rastreamento mantém os nomes `metrics`, `groups` e `page`;
uma etapa ausente indica **consulta eliminada por seletividade**, não erro.
A próxima comparação deve medir cada aba com cache de catálogo aquecido
e confirmar que o número de etapas analíticas é **2**, em vez de 3.
Nenhuma alteração de banco, índices, pool ou worker.
