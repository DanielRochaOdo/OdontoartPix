# OdontoartPix

Sistema web para importação de campanhas, consulta de mensalidades e consolidação de pendências financeiras.

## Fluxo operacional

1. A importação valida o arquivo e grava campanha, lote, associados e vínculos com status `pending`.
2. A importação não consulta o ERP.
3. O botão **Processar campanha** ou **Processar lote** cria jobs com status `queued`.
4. O cron `/api/cron/process-batches` reserva um job com lease e processa um bloco limitado.
5. Cada resposta do ERP é persistida em `campaign_batch_members`, `member_installments`, `member_plan_totals` e `consultation_logs`.
6. Dashboard, lista, campanha e lote leem métricas canônicas calculadas no PostgreSQL.

## Contrato da API de mensalidades

A consulta é server-side por `GET`:

```text
/api/mensalidade/BuscarDadosMensalidades?token=...&CpfUsuario=...
```

Regras:

- `parcelas` precisa ser um array;
- parcela com `cod_parcela` preenchido representa pendência;
- array válido sem `cod_parcela` representa associado pago;
- o total pendente é a soma de `ValorFinal`;
- as parcelas são agrupadas por `Tipo_plano`;
- timeout, falha HTTP, rede ou payload inválido são erros e não podem virar pagamento confirmado;
- token, CPF completo, Pix e link de cartão não devem aparecer nos logs.

## Variáveis

Copie `.env.example` para `.env.local` e configure:

```text
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
MENSALIDADES_API_TIMEOUT_MS
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
PROCESSING_BLOCK_SIZE
PROCESSING_CONCURRENCY
PROCESSING_LEASE_SECONDS
```

## Banco

Aplique as migrations em ordem. As migrations `009_processing_pipeline_and_metrics.sql` e `010_campaign_list_metrics.sql` adicionam o scheduler durável, persistência normalizada e as métricas canônicas.

## Cron

O `vercel.json` agenda:

```text
GET /api/cron/process-batches
Authorization: Bearer <CRON_SECRET>
```

Cada execução processa somente um bloco. O job volta para `queued` quando ainda existem itens pendentes.

## Validação

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

Antes de processar uma base grande, valide com uma campanha pequena e confirme:

- importação termina sem chamar o ERP;
- campanha inicia em `aguardando`;
- o botão cria job `queued` e retorna HTTP 202;
- o cron altera o estado para `processando`;
- `paid + unpaid = completed`;
- `pending + processing + completed + errored = total`;
- o valor pendente corresponde à soma das parcelas persistidas.
