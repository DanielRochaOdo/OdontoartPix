# Contador de vidas ativas

O painel `/vidas-ativas` consulta a API da Odontoart, persiste snapshots no PostgreSQL e apresenta o total de vidas ativas, titulares, dependentes, data da consulta, gráficos e crescimento no período selecionado.

## Configuração

Defina as variáveis abaixo no ambiente da aplicação:

```env
VIDAS_ATIVAS_API_ENDPOINT=https://SEU_ENDPOINT
VIDAS_ATIVAS_API_TOKEN=SEU_TOKEN
VIDAS_ATIVAS_API_TIMEOUT_MS=15000
CRON_SECRET=UM_SEGREDO_LONGO_E_ALEATORIO
```

`VIDAS_ATIVAS_API_ENDPOINT` aceita a origem (`https://host.exemplo.com`) ou a URL completa terminando em `/v2/api/contratos/vidasAtivas`. O token é adicionado somente no servidor e nunca é enviado ao navegador.

Depois de atualizar o código, execute as migrations normalmente:

```bash
npm run db:migrate
```

A migration `100_active_lives_snapshots.sql` cria o histórico das amostras e uma chave única por janela de 5 minutos, evitando duplicações quando mais de um cliente tenta atualizar simultaneamente.

## Coleta a cada 5 minutos

Enquanto o painel estiver aberto, o navegador chama a rota autenticada de coleta a cada 5 minutos. Para manter o histórico 24/7, configure o agendador já usado na infraestrutura para executar a cada 5 minutos:

```text
GET https://SEU_HOST/api/cron/vidas-ativas
Authorization: Bearer SEU_CRON_SECRET
Cron: */5 * * * *
```

A rota de cron não expõe o token da API externa. Ela apenas dispara a mesma rotina server-side usada pelo painel.

## Endpoints internos

- `GET /api/vidas-ativas?from=2026-09-01&to=2026-09-30`: retorna snapshot atual, primeiro/último snapshot do período, variações e série amostrada para gráficos.
- `POST /api/vidas-ativas/coletar`: coleta autenticada para usuários do sistema. Envie `{ "force": true }` para o botão “Atualizar agora”.
- `GET /api/cron/vidas-ativas`: coleta para o agendador, protegida por `CRON_SECRET`.

## Regra de crescimento

A variação do período é calculada como:

```text
variacao_absoluta = ultimo_snapshot - primeiro_snapshot
variacao_percentual = variacao_absoluta / primeiro_snapshot * 100
```

O cálculo é feito separadamente para `totalVidasAtivas`, `totalTitularesAtivos` e `totalDependentesAtivos`. Para períodos de até 3 dias, os gráficos usam uma amostra por hora; em períodos maiores, uma amostra por dia.
