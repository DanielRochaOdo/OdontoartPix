# OdontoartPix

Sistema web para importacao de campanhas, consulta de mensalidades e consolidacao de pendencias financeiras.

## Fluxo operacional

1. A importacao valida o arquivo e grava campanha, lote, associados e vinculos com status `pending`.
2. A importacao nao consulta o ERP.
3. O botao **Processar campanha** ou **Processar lote** cria jobs com status `queued`.
4. O clique em **Processar campanha** ou **Processar lote** faz um kickoff curto e dispara o worker duravel no GitHub Actions.
5. Em producao, o processamento pesado roda diretamente no runner do GitHub Actions, fora da Vercel.
6. Cada resposta do ERP e persistida em `campaign_batch_members`, `member_installments`, `member_plan_totals` e `consultation_logs`.
7. Dashboard, lista, campanha e lote leem metricas canonicas calculadas no PostgreSQL.

## Contrato da API de mensalidades

A consulta e server-side por `GET`:

```text
/api/Mensalidades?token=...&CodigoAssociadoEmpresa=...&HistoricoCompleto=true&limite=200&pagina=1
```

Regras:

- a consulta usa `HistoricoCompleto=true` e retorna parcelas pagas e abertas;
- a consulta usa `limite=200` e avanca pagina a pagina ate localizar a parcela-alvo; ao encontra-la, nao solicita paginas posteriores;
- se a parcela-alvo nao for localizada, a consulta segue ate `TotalPages`;
- parcela com `DescricaoRecebimento=ABERTO` representa pendencia;
- uma parcela so e paga quando `ValorPago` e `DescricaoRecebimento` estao preenchidos e a descricao e diferente de `ABERTO`;
- `DataPagamento` da parcela-alvo e persistida para exibicao na lista de associados;
- no dashboard, valores, contagens e status usam somente a parcela `target_installment_id` cadastrada no lote;
- o total pendente e a soma de `ValorFinal` da parcela-alvo nao paga;
- os valores de `DescricaoRecebimento` sao persistidos para o grafico de recebimentos do dashboard;
- as parcelas sao agrupadas por `Tipo_plano`;
- timeout, falha HTTP, rede ou payload invalido sao erros e nao podem virar pagamento confirmado;
- token, `CodigoAssociadoEmpresa`, CPF completo, Pix e link de cartao nao devem aparecer nos logs;
- o quarto grafico do dashboard agrupa somente parcelas-alvo pagas por `DescricaoRecebimento` e respeita os filtros de campanha/lote; sem filtros, considera todo o sistema ativo.

## Variaveis

Copie `.env.example` para `.env.local` e configure as variaveis necessarias para o ambiente local.

No environment `Production` do GitHub Actions, o worker duravel exige obrigatoriamente:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
PROCESSING_SYSTEM_USER_ID
```

O workflow de producao falha se qualquer uma dessas variaveis estiver ausente. Ele nao faz fallback para processamento pesado dentro de Functions da Vercel.

Os parametros operacionais de concorrencia, block size, tentativas, buffers e timeouts continuam sendo carregados de `processing_settings`, configurados pelo modulo **Configuracoes**. Variaveis do GitHub environment podem ser usadas como fallback de inicializacao quando aplicavel.

## Banco

Aplique as migrations em ordem. O processamento atual depende das migrations de fila, verdade financeira, prioridades e snapshots de reprocessamento presentes em `supabase/migrations`.

## Scheduler externo

O workflow `.github/workflows/process-batches.yml` usa um pulso de recuperacao a cada 5 minutos. Esse pulso roda no GitHub Actions e nao deve executar processamento pesado na Vercel.

O pulso nao significa que uma sincronizacao geral sera iniciada a cada 5 minutos. A janela efetiva da sincronizacao agendada continua sendo controlada transacionalmente no PostgreSQL.

Em producao:

```text
PROCESSING_ALLOW_SCHEDULED_SYNC=true
```

Em testes locais controlados, pode-se iniciar o worker com:

```bash
PROCESSING_ALLOW_SCHEDULED_SYNC=false npx --yes dotenv-cli@8.0.0 -e .env.local -- npx --yes tsx@4.20.5 scripts/process-batches-worker.ts
```

## Uso de Vercel

A Vercel deve atuar como camada web/control plane. O processamento em massa de ERP nao deve ser executado continuamente por `/api/cron/process-batches` em producao.

Para reduzir invocacoes, o indicador global usa polling adaptativo:

- sistema ocioso: consulta a cada 60 segundos;
- processamento ativo: consulta a cada 10 segundos;
- aba oculta: sem polling;
- eventos internos de processamento: atualizacao imediata;
- painel detalhado de erros aberto: atualizacao a cada 5 segundos.

## Validacao

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

Antes de processar uma base grande em producao, confirme no log do GitHub Actions:

```text
Using direct GitHub durable worker.
```

Depois valide uma campanha pequena, uma onda do Dashboard, um snapshot fechado de erros e um reprocessamento individual.
