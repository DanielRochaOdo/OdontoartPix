# OdontoartPix

Sistema web para importacao de campanhas, consulta de mensalidades e consolidacao de pendencias financeiras.

## Fluxo operacional

1. A importacao valida o arquivo e grava campanha, lote, associados e vinculos com status `pending`.
2. A importacao nao consulta o ERP.
3. Uma acao explicita do usuario — Dashboard, campanha, lote, associado ou reprocessamento de erros — grava o trabalho no PostgreSQL.
4. A API web apenas cria/altera o job e acorda o worker duravel no GitHub Actions. O ERP nao e processado dentro da request da Vercel.
5. Em producao, o processamento pesado roda diretamente no runner do GitHub Actions.
6. Cada resposta do ERP e persistida em `campaign_batch_members`, `member_installments`, `member_plan_totals` e `consultation_logs`.
7. Dashboard e indicadores acompanham mudancas por Supabase Realtime; nao existe polling continuo de Functions Vercel para descobrir progresso.
8. Dashboard, lista, campanha e lote leem metricas canonicas calculadas no PostgreSQL.

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

Copie `.env.example` para `.env.local` e configure as variaveis necessarias.

### Nova conta Vercel

A Vercel e apenas camada web/control plane. Configure as variaveis normais da aplicacao e, para que as acoes do usuario possam acordar o worker, configure tambem:

```text
GITHUB_ACTIONS_TOKEN
GITHUB_ACTIONS_REPO_OWNER=DanielRochaOdo
GITHUB_ACTIONS_REPO_NAME=OdontoartPix
GITHUB_ACTIONS_WORKFLOW_ID=process-batches.yml
GITHUB_ACTIONS_REF=main
```

`GITHUB_ACTIONS_TOKEN` deve possuir permissao para disparar GitHub Actions no repositorio. Nao crie Vercel Cron para `/api/cron/process-batches`: essa rota esta deliberadamente desativada e retorna HTTP 410.

### GitHub Actions - environment Production

O worker duravel exige obrigatoriamente:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MENSALIDADES_API_BASE_URL
MENSALIDADES_API_TOKEN
PROCESSING_SYSTEM_USER_ID
```

O workflow falha se qualquer segredo estiver ausente. Nao existe fallback para processamento pesado na Vercel.

Os parametros operacionais de concorrencia, block size, tentativas, buffers e timeouts continuam sendo carregados de `processing_settings`, configurados pelo modulo **Configuracoes**.

## Banco

Aplique as migrations em ordem. Alem das migrations de fila e verdade financeira, a arquitetura orientada a eventos depende de:

```text
090_processing_realtime_event_bus.sql
091_event_driven_processing_scheduler.sql
092_route_scheduled_sync_v2_to_finish_based_v3.sql
```

A migration `090` cria um sinal Realtime sem dados de associados. O navegador recebe somente a mudanca de revisao e consulta snapshots agregados diretamente no Supabase autenticado.

A migration `091` usa Supabase Cron (`pg_cron`), `pg_net` e Vault. O cron de banco executa uma verificacao interna leve a cada minuto, mas **nao chama Vercel nem inicia GitHub Actions enquanto `next_run_at` nao tiver vencido**.

Para habilitar o disparo automatico, armazene no **Supabase Vault** um token GitHub com permissao de Actions usando exatamente o nome:

```text
odontoartpix_github_actions_token
```

Exemplo no SQL Editor, substituindo apenas o primeiro parametro localmente — nunca versione o valor:

```sql
select vault.create_secret(
  'SEU_TOKEN_GITHUB',
  'odontoartpix_github_actions_token',
  'Dispara o worker duravel do OdontoartPix quando next_run_at vencer'
);
```

O token fica criptografado no Vault e e lido somente pela funcao de dispatch do banco.

## Scheduler orientado ao fim da onda

O automatico nao possui mais cron periodico no GitHub Actions.

A regra e:

```text
fim real da ultima onda geral
        +
intervalo configurado (1, 5, 30, 60 ou 120 min)
        =
next_run_at
```

Exemplo: se o intervalo for 30 minutos e uma onda terminar as 10:18, a proxima fica elegivel as 10:48. Uma onda manual do Dashboard tambem reinicia esse relogio.

A cada minuto o Supabase verifica apenas se `next_run_at <= now()`. Se ainda nao venceu, termina dentro do proprio banco. Se venceu e nao existe onda ativa, ele acorda o GitHub Actions uma unica vez. Se nao houver nenhum lote elegivel naquele momento, `next_run_at` avanca novamente pelo intervalo configurado, evitando runners repetidos.

O workflow `.github/workflows/process-batches.yml` possui somente `workflow_dispatch`:

- `source=scheduler`: permite criar a onda automatica;
- qualquer acao do usuario: apenas consome o trabalho explicitamente solicitado e nao cria onda automatica por acidente.

## Supabase Realtime em vez de polling

Os componentes de processamento nao executam mais loops `setInterval` para consultar status na Vercel.

Fluxo:

```text
worker persiste mudanca
       ↓
trigger incrementa processing_realtime_signal
       ↓
Supabase Realtime avisa o navegador
       ↓
navegador autenticado consulta RPC de snapshot direto no Supabase
```

Quando a aba esta oculta, as leituras de snapshot sao adiadas. Ao voltar para a aba, ocorre uma unica atualizacao. As acoes explicitas do usuario continuam chamando APIs web, pois sao comandos e nao polling.

Isso se aplica ao indicador global, painel completo da onda no Dashboard, tratativa dos erros da onda e progresso do snapshot de erros filtrados.

## Protecao contra Fluid Active CPU

`/api/cron/process-batches` nao contem mais o motor de processamento. A rota retorna HTTP `410 VERCEL_PROCESSING_DISABLED` e tem duracao maxima curta. Mesmo que uma automacao antiga tente chama-la, nenhuma consulta em massa ao ERP sera executada na Vercel.

Em testes locais controlados:

```bash
PROCESSING_ALLOW_SCHEDULED_SYNC=false npx --yes dotenv-cli@8.0.0 -e .env.local -- npx --yes tsx@4.20.5 scripts/process-batches-worker.ts
```

## Validacao

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

Antes de processar uma base grande em producao, confirme no GitHub Actions:

```text
Using direct GitHub durable worker.
```

Para um dispatch vindo de usuario, o log deve mostrar `Scheduled sync allowed: false`. Para o automatico disparado pelo Supabase, deve mostrar `Scheduled sync allowed: true`.

Depois valide uma campanha pequena, uma onda do Dashboard, um snapshot fechado de erros e um reprocessamento individual.
