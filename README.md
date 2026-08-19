# OdontoartPix

Sistema web para importacao de campanhas, consulta de mensalidades e consolidacao de pendencias financeiras.

## Fluxo operacional

1. A importacao valida o arquivo e grava campanha, lote, associados e vinculos com status `pending`.
2. A importacao nao consulta o ERP.
3. Processamentos de dashboard, campanha, lote, associado e reprocessamento de erros entram na fila priorizada.
4. A prioridade operacional e: Dashboard + erros da onda > Campanha > Lote > Associado.
5. A aplicacao apenas cria/atualiza a fila e dispara o worker duravel; o processamento pesado nao deve depender da request da Vercel.
6. Em producao, o GitHub Actions executa `scripts/process-batches-worker.ts` diretamente quando os secrets do ERP/Supabase estao configurados. O endpoint da Vercel permanece como fallback.
7. Cada resposta do ERP e persistida em `campaign_batch_members`, `member_installments`, `member_plan_totals` e `consultation_logs`.
8. Dashboard, lista, campanha e lote leem metricas canonicas calculadas no PostgreSQL.

## Contrato da API de mensalidades

A consulta e server-side por `GET`:

```text
/api/Mensalidades?token=...&CodigoAssociadoEmpresa=...&HistoricoCompleto=true&limite=200&pagina=1
```

Regras:

- a consulta usa `HistoricoCompleto=true` e retorna parcelas pagas e abertas;
- a consulta usa `limite=200` e avanca pagina a pagina somente enquanto a parcela-alvo ainda nao foi localizada;
- ao encontrar `target_installment_id` por `Id`, `CodigoParcela` ou `cod_parcela`, a consulta encerra a paginacao imediatamente e analisa a parcela encontrada;
- se a parcela-alvo nao aparecer, a consulta segue ate `TotalPages`;
- parcela com `DescricaoRecebimento=ABERTO` representa pendencia;
- uma parcela so e paga quando `ValorPago` e `DescricaoRecebimento` estao preenchidos e a descricao e diferente de `ABERTO`;
- `DataPagamento` da parcela-alvo e persistida e exibida na listagem de associados;
- no dashboard, valores, contagens e status usam somente a parcela `target_installment_id` cadastrada no lote;
- o total pendente e a soma de `ValorFinal` da parcela-alvo nao paga;
- os valores de `DescricaoRecebimento` sao persistidos para o grafico de recebimentos do dashboard;
- timeout, falha HTTP, rede ou payload invalido sao erros e nao podem virar pagamento confirmado;
- token, `CodigoAssociadoEmpresa`, CPF completo, Pix e link de cartao nao devem aparecer nos logs.

## Reprocessamento de erros

O reprocessamento de erros filtrados usa snapshot fechado:

- o clique fotografa exatamente os IDs que estavam com erro naquele instante;
- erros novos que surgirem depois nao entram automaticamente no mesmo pedido;
- todos os IDs do snapshot precisam receber uma nova tentativa antes do pedido ser concluido;
- o progresso separa aguardando, reprocessando, resolvidos e continuaram com erro;
- `100% concluido` significa que todos receberam nova tentativa, nao que todos foram resolvidos;
- o reprocessamento usa o mesmo perfil ativo do modulo Configuracoes (Conservador, Mediano ou Agressivo).

## Variaveis de ambiente

Use `.env.example` como referencia. Os valores armazenados em `processing_settings` no banco prevalecem sobre os defaults de ambiente para os parametros do worker.

### Vercel Production

A aplicacao precisa, no minimo, das credenciais do ERP/Supabase e das variaveis para disparar o GitHub Actions:

```text
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
GITHUB_ACTIONS_TOKEN
GITHUB_ACTIONS_REPO_OWNER=DanielRochaOdo
GITHUB_ACTIONS_REPO_NAME=OdontoartPix
GITHUB_ACTIONS_WORKFLOW_ID=process-batches.yml
GITHUB_ACTIONS_REF=main
```

`GITHUB_ACTIONS_TOKEN` precisa permitir disparo de Actions no repositorio.

### GitHub Actions - Environment `Production`

Para o modo duravel direto, configure os secrets:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
PROCESSING_SYSTEM_USER_ID
```

Quando esses quatro primeiros secrets estao presentes, o workflow processa diretamente no runner do GitHub, evitando usar a Vercel para o trabalho pesado.

Mantenha tambem os secrets de fallback:

```text
PROCESS_BATCHES_URL=https://mensalidades.odontoart.com/api/cron/process-batches
CRON_SECRET=<mesmo valor configurado na Vercel>
PROCESSING_SYSTEM_USER_ID
```

As variaveis opcionais do GitHub Actions podem definir defaults de emergencia:

```text
PROCESSING_WORKER_COUNT
PROCESSING_BLOCK_SIZE
PROCESSING_CONCURRENCY
PROCESSING_ERP_CONCURRENCY
```

Na operacao normal, o modulo Configuracoes persiste esses parametros em `processing_settings` e o worker os le diretamente do Supabase.

## Banco

Aplique as migrations em ordem antes de publicar o codigo correspondente. Nunca use `db reset --linked` ou `migration repair` como substituto de uma migration faltante em producao.

## Scheduler externo

O workflow `.github/workflows/process-batches.yml` possui pulso a cada 5 minutos e tambem aceita `workflow_dispatch`.

O pulso de 5 minutos nao significa iniciar uma sincronizacao geral a cada 5 minutos. A janela real de sincronizacao agendada e controlada de forma transacional no banco.

Em producao:

```text
PROCESSING_ALLOW_SCHEDULED_SYNC=true
```

O valor `false` deve ser usado apenas em testes locais controlados para impedir que o worker de desenvolvimento crie sincronizacoes agendadas.

Depois de publicar esta versao na `main`, o workflow **Process Batches** deve estar habilitado no GitHub Actions. Enquanto uma branch local estiver sendo testada contra o mesmo Supabase, mantenha-o desabilitado para evitar concorrencia com codigo da `main`.

## Operacao

Defaults de fallback do codigo:

- `PROCESSING_WORKER_COUNT=10`;
- `PROCESSING_BLOCK_SIZE=60`;
- `PROCESSING_CONCURRENCY=15`;
- `PROCESSING_ERP_CONCURRENCY=15`;
- timeout de conexao ERP de 30s;
- timeout de leitura ERP de 30s;
- ate 3 tentativas por item;
- stale heartbeat de 120s;
- lease de 900s;
- pagina ERP de ate 200 itens.

Esses defaults nao substituem o perfil configurado no modulo Configuracoes.

## Validacao

Antes do merge para `main`:

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

Validacoes operacionais recomendadas:

- importacao termina sem chamar o ERP;
- processamento cria fila e retorna HTTP 202;
- dashboard e erros da propria onda usam prioridade 1;
- campanha, lote e associado respeitam a ordem de prioridade;
- interromper o Dashboard encerra a onda, nao cria estado de pausa recuperavel;
- snapshot filtrado processa exatamente os IDs fotografados no clique;
- `resolved + failed = requested` ao finalizar um snapshot de erros;
- valores financeiros so mudam apos nova verdade recebida do ERP;
- a parcela-alvo paga exige evidencia explicita de `ValorPago` + `DescricaoRecebimento` valida.
