# OdontoartPix

Sistema web para importacao de campanhas, consulta de mensalidades e consolidacao de pendencias financeiras.

## Fluxo operacional

1. A importacao valida o arquivo e grava campanha, lote, associados e vinculos com status `pending`.
2. A importacao nao consulta o ERP.
3. O botao **Processar campanha** ou **Processar lote** cria jobs com status `queued`.
4. O cron `/api/cron/process-batches` reserva um job com lease e processa um bloco limitado a cada hora.
5. Cada resposta do ERP e persistida em `campaign_batch_members`, `member_installments`, `member_plan_totals` e `consultation_logs`.
6. Dashboard, lista, campanha e lote leem metricas canonicas calculadas no PostgreSQL.

## Contrato da API de mensalidades

A consulta e server-side por `GET`:

```text
/api/Mensalidades?token=...&CodigoAssociadoEmpresa=...
```

Regras:

- `parcelas` precisa ser um array;
- parcela com `cod_parcela` preenchido representa pendencia;
- array valido sem `cod_parcela` representa associado pago;
- o total pendente e a soma de `ValorFinal`;
- as parcelas sao agrupadas por `Tipo_plano`;
- timeout, falha HTTP, rede ou payload invalido sao erros e nao podem virar pagamento confirmado;
- token, `CodigoAssociadoEmpresa`, CPF completo, Pix e link de cartao nao devem aparecer nos logs.

## Variaveis

Copie `.env.example` para `.env.local` e configure:

```text
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
MENSALIDADES_API_TIMEOUT_MS
MENSALIDADES_API_CONNECT_TIMEOUT_MS
MENSALIDADES_API_READ_TIMEOUT_MS
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
PROCESSING_WORKER_COUNT
PROCESSING_BLOCK_SIZE
PROCESSING_CONCURRENCY
PROCESSING_MAX_ATTEMPTS
PROCESSING_STALE_HEARTBEAT_MS
PROCESSING_LEASE_SECONDS
PROCESSING_WORKER_CYCLE_BUDGET_MS
PROCESSING_PRODUCTIVE_DELAY_MS
```

## Banco

Aplique as migrations em ordem. As migrations `009_processing_pipeline_and_metrics.sql` e `010_campaign_list_metrics.sql` adicionam o scheduler duravel, persistencia normalizada e as metricas canonicas.

## Cron

O `vercel.json` agenda:

```text
GET /api/cron/process-batches
Authorization: Bearer <CRON_SECRET>
```

Cada execucao processa somente um bloco. O job volta para `queued` quando ainda existem itens pendentes.

## Operacao

Defaults iniciais do worker:

- ate 10 workers paralelos;
- ate 30 itens claimados por lote;
- ate 10 chamadas simultaneas por worker;
- timeout de 15s para conexao e 15s para leitura;
- ate 3 tentativas totais por item;
- reclaim apos 120s sem heartbeat;
- orcamento de 40s por ciclo;
- lease global de 15 minutos;
- atraso de 25ms entre lotes produtivos.

## Validacao

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

Antes de processar uma base grande, valide com uma campanha pequena e confirme:

- importacao termina sem chamar o ERP;
- campanha inicia em `aguardando`;
- o botao cria job `queued` e retorna HTTP 202;
- o cron altera o estado para `processando`;
- `paid + unpaid = completed`;
- `pending + processing + completed + errored = total`;
- o valor pendente corresponde a soma das parcelas persistidas.
