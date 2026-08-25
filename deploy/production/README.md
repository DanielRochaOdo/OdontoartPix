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

Diretório de produção atual:

```text
/opt/odontoart-pix
```

No diretório da aplicação:

```bash
npm ci
npm run db:migrate
npm run build
```

Todos os três comandos devem terminar sem erro antes de instalar os serviços.

## 3. Arquivo de ambiente e preflight

A aplicação web e o worker usam o mesmo arquivo de ambiente de produção:

```text
/etc/odontoartpix/app.env
```

O worker recebe `DATABASE_POOL_MAX=30` como override exclusivo da unit systemd, sem aumentar o pool da aplicação web.

Recomendação de permissão:

```bash
sudo chown root:odontoart /etc/odontoartpix/app.env
sudo chmod 640 /etc/odontoartpix/app.env
```

Nunca grave tokens/senhas no repositório.

Antes de iniciar os serviços, carregue as variáveis reais do ambiente e execute:

```bash
npm run preflight:production
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

## 4. Instalar a aplicação web sem publicar

```bash
sudo APP_DIR=/opt/odontoart-pix \
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

A unit oficial de produção é `odontoart-pix-worker.service`, acionada por `odontoart-pix-worker.timer`. Não crie uma segunda unit com outro nome enquanto esse timer estiver ativo.

Perfil de performance validado em produção em 25/08/2026:

```text
PROCESSING_BLOCK_SIZE=60
PROCESSING_CONCURRENCY=50
PROCESSING_ERP_CONCURRENCY=50
PROCESSING_MAX_BUFFERED_RESULTS=60
PROCESSING_PRODUCTIVE_DELAY_MS=0
WORKER_LIMIT=60
WORKER_CONCURRENCY=50
WORKER_DELAY_MS=0
WORKER_DATABASE_POOL_MAX=30
TIMER_SECONDS=30
```

Benchmark real de referência: 732 associados processados em 136,825 segundos, aproximadamente `5,35 associados/s`.

Instalação:

```bash
sudo APP_DIR=/opt/odontoart-pix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/app.env \
  SERVICE_NAME=odontoart-pix-worker \
  TIMER_SECONDS=30 \
  WORKER_LIMIT=60 \
  WORKER_CONCURRENCY=50 \
  WORKER_DELAY_MS=0 \
  WORKER_DATABASE_POOL_MAX=30 \
  ENABLE_TIMER=false \
  bash deploy/systemd/install-worker.sh
```

Confirme:

```bash
systemctl is-enabled odontoart-pix-worker.timer || true
systemctl is-active odontoart-pix-worker.timer || true
```

O esperado nesta etapa é `disabled` e `inactive`.

## 6. Validação funcional antes do tráfego público

Valide uma carga pequena e conhecida:

1. login local;
2. Dashboard;
3. importação de uma campanha/lote pequeno;
4. criação do job em `queued` sem consulta ao ERP durante a importação;
5. execução manual de `odontoart-pix-worker.service`;
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
3. execute novamente:

```bash
npm ci
npm run db:migrate
npm run preflight:production
npm run build
```

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
sudo journalctl -u odontoart-pix-worker.service -f
```

## 10. Ativar o consumo contínuo

Depois do tráfego web estabilizado:

```bash
sudo systemctl enable --now odontoart-pix-worker.timer
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
sudo systemctl disable --now odontoart-pix-worker.timer
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
