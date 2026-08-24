# Runbook de produção — OdontoartPix local

Este procedimento trata o corte da arquitetura com PostgreSQL próprio, autenticação local, Next.js local e worker systemd.

## Princípios do corte

- mantenha o ambiente que atende os usuários atualmente intacto até a validação local terminar;
- não habilite o timer do worker durante a instalação;
- mantenha `PROCESSING_ALLOW_SCHEDULED_SYNC=false` durante o primeiro corte;
- mantenha `processing_scheduler_state.scheduler_enabled=false` no banco;
- aplique migrations somente depois de backup validado;
- não considere rollback de código suficiente quando uma migration altera/remove estruturas: preserve um backup restaurável do banco.

## 1. Backup e estado inicial

Antes de alterar o banco:

1. gere backup consistente do banco/dados que precisam ser preservados;
2. confirme que o arquivo de backup existe e possui tamanho plausível;
3. registre o commit que está sendo validado;
4. confirme que o scheduler automático está desligado.

No PostgreSQL novo:

```sql
select set_local_processing_scheduler_enabled_v1(false);
```

No ambiente do worker:

```text
PROCESSING_ALLOW_SCHEDULED_SYNC=false
```

## 2. Preparar a aplicação no servidor

Exemplo de diretório:

```text
/opt/odontoartpix
```

No diretório da aplicação, instale as dependências:

```bash
npm ci
```

As migrations e o build devem usar o ambiente real preparado na etapa seguinte.

## 3. Arquivos de ambiente e preflight

Separe o processo web do worker:

```text
/etc/odontoartpix/app.env
/etc/odontoartpix/worker.env
```

Os dois precisam das variáveis de PostgreSQL. O worker também precisa das variáveis do ERP e de processamento.

Recomendação de permissão:

```bash
sudo chown root:odontoart /etc/odontoartpix/app.env /etc/odontoartpix/worker.env
sudo chmod 640 /etc/odontoartpix/app.env /etc/odontoartpix/worker.env
```

Nunca grave tokens/senhas no repositório.

Aplique migrations com o arquivo de ambiente explícito:

```bash
node --env-file=/etc/odontoartpix/app.env \
  ./node_modules/.bin/tsx scripts/migrate-local-db.ts
```

Antes de iniciar os serviços, execute o preflight com o mesmo ambiente:

```bash
node --env-file=/etc/odontoartpix/app.env \
  ./node_modules/.bin/tsx scripts/preflight-production.ts
```

O preflight não imprime senhas/tokens e valida:

- variáveis obrigatórias de PostgreSQL e ERP;
- `AUTH_COOKIE_SECURE=true`;
- conexão com PostgreSQL;
- correspondência entre todas as migrations do checkout e `schema_migrations`;
- identidade técnica do processamento ativa e sem login interativo;
- por padrão, scheduler automático desligado tanto no ambiente quanto no banco.

No primeiro corte, mantenha:

```text
PRODUCTION_PREFLIGHT_REQUIRE_SCHEDULER_OFF=true
PROCESSING_ALLOW_SCHEDULED_SYNC=false
```

Se o preflight falhar, não prossiga com a publicação.

### Build com o ambiente de produção

Não execute o binário do Next.js como filho direto de `node --env-file=...`. O Next/Turbopack cria Worker Threads durante o build e flags do processo Node podem ser herdadas pelos workers; `--env-file` não é uma opção válida de Worker Thread e pode causar `ERR_WORKER_INVALID_EXEC_ARGV`.

Carregue o `.env` de produção para um novo processo `npm` sem herdar `--env-file` em `process.execArgv`:

```bash
node <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { spawnSync } = require('node:child_process');

const envFile = '/etc/odontoartpix/app.env';
const fileEnv = parseEnv(fs.readFileSync(envFile, 'utf8'));
const env = { ...process.env, ...fileEnv };

if (env.DATABASE_NAME !== 'odontoart_pix') {
  throw new Error(`DATABASE_NAME inesperado para build de producao: ${env.DATABASE_NAME}`);
}
if (env.AUTH_COOKIE_SECURE !== 'true') {
  throw new Error('AUTH_COOKIE_SECURE deve ser true no build de producao.');
}

const result = spawnSync('/usr/bin/npm', ['run', 'build'], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
NODE
```

O ambiente já presente no processo filho tem precedência sobre os arquivos `.env*` que o Next.js possa descobrir no checkout.

## 4. Instalar a aplicação web sem publicar

```bash
sudo APP_DIR=/opt/odontoartpix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/app.env \
  APP_HOST=127.0.0.1 \
  APP_PORT=3000 \
  ENABLE_APP=false \
  bash deploy/systemd/install-app.sh
```

Inicie manualmente:

```bash
sudo systemctl start odontoartpix-app.service
sudo systemctl status odontoartpix-app.service --no-pager
sudo journalctl -u odontoartpix-app.service -n 100 --no-pager
```

Teste a conectividade local com o banco:

```bash
curl -fsS http://127.0.0.1:3000/api/health/db
```

Não prossiga se o endpoint não responder HTTP 200.

## 5. Instalar o worker sem ativar o timer

```bash
sudo APP_DIR=/opt/odontoartpix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/worker.env \
  ENABLE_TIMER=false \
  bash deploy/systemd/install-worker.sh
```

Confirme:

```bash
systemctl is-enabled odontoartpix-worker.timer || true
systemctl is-active odontoartpix-worker.timer || true
```

O esperado nesta etapa é `disabled` e `inactive`.

## 6. Validação funcional antes do tráfego público

Valide uma carga pequena e conhecida:

1. login local;
2. Dashboard;
3. importação de uma campanha/lote pequeno;
4. criação do job em `queued` sem consulta ao ERP durante a importação;
5. execução manual de `worker:once`/`odontoartpix-worker.service`;
6. persistência da parcela-alvo;
7. atualização da UI/SSE;
8. pausa/interrupção de processamento.

Matriz financeira obrigatória:

| Condição da parcela-alvo | Resultado |
| --- | --- |
| `DescricaoRecebimento == "ABERTO"` | `unpaid` |
| `DescricaoRecebimento != "ABERTO"` e `ValorPago >= Valor` | `paid` |
| `DescricaoRecebimento != "ABERTO"` e `ValorPago < Valor` | erro |
| alvo ausente depois da paginação necessária | erro |

Também confirme que:

- a paginação para ao encontrar a parcela-alvo;
- alvo ausente nunca vira `paid` ou `unpaid` por inferência;
- o erro de alvo ausente pode ser reprocessado manualmente;
- uma sincronização completa futura volta a considerar esse registro.

## 7. Reverse proxy HTTPS

O Next.js deve permanecer em `127.0.0.1:3000` e ser publicado por reverse proxy.

Existe um exemplo em:

```text
deploy/nginx/odontoartpix.conf.example
```

Antes de qualquer troca de tráfego, valide a configuração do proxy. Em Nginx:

```bash
sudo nginx -t
```

O caminho `/api/processing/events` exige buffering desabilitado e timeout longo por usar Server-Sent Events.

## 8. Merge e atualização final

Somente após a validação do candidato:

1. mescle o PR aprovado em `main`;
2. atualize o código do servidor para o commit de `main`;
3. execute novamente `npm ci`, migrations, preflight e o build com o mesmo procedimento seguro da etapa 3;
4. reinicie a aplicação:

```bash
sudo systemctl restart odontoartpix-app.service
```

5. repita o health check e um login antes de trocar o tráfego.

## 9. Troca de tráfego

Somente depois dos testes do `main` no servidor:

1. aponte o reverse proxy/DNS para o ambiente local conforme a infraestrutura vigente;
2. valide HTTPS;
3. valide login e sessão;
4. valide Dashboard;
5. valide o SSE de processamento;
6. monitore logs da aplicação.

Comandos úteis:

```bash
sudo journalctl -u odontoartpix-app.service -f
sudo journalctl -u odontoartpix-worker.service -f
```

## 10. Ativar o consumo contínuo

Depois do tráfego web estabilizado:

```bash
sudo systemctl enable --now odontoartpix-worker.timer
```

Isso ativa o consumo da fila, mas não precisa ativar novas ondas automáticas.

## 11. Ativar ondas automáticas — opcional e posterior

Somente quando o processamento manual/geral estiver validado em produção:

1. altere o ambiente do worker para:

```text
PROCESSING_ALLOW_SCHEDULED_SYNC=true
```

2. habilite a trava do banco:

```sql
select set_local_processing_scheduler_enabled_v1(true);
```

3. reinicie o timer/worker se necessário.

A partir dessa etapa, para usar o preflight apenas como verificação de consistência sem exigir scheduler desligado, defina explicitamente:

```text
PRODUCTION_PREFLIGHT_REQUIRE_SCHEDULER_OFF=false
```

## Rollback imediato

Se houver problema após o corte:

1. impeça novo processamento:

```bash
sudo systemctl disable --now odontoartpix-worker.timer
```

2. desligue a criação automática de ondas:

```sql
select set_local_processing_scheduler_enabled_v1(false);
```

3. reverta o tráfego público para o ambiente anterior;
4. preserve logs e estado do banco para diagnóstico;
5. pare a aplicação local se necessário:

```bash
sudo systemctl stop odontoartpix-app.service
```

Se o problema exigir voltar para um schema anterior, restaure o backup compatível. Não tente resolver uma migration destrutiva apenas trocando o commit da aplicação.
