# Aplicação web e worker local com systemd

A arquitetura de produção local usa dois componentes independentes:

- `odontoartpix-app.service`: mantém o Next.js em execução;
- `odontoart-pix-worker.service` + `odontoart-pix-worker.timer`: consomem a fila de processamento.

Os instaladores são seguros por padrão: **nem a aplicação web nem o timer do worker são ativados automaticamente**.

## Pré-requisitos

- aplicação instalada em `/opt/odontoart-pix`;
- `npm ci` executado no diretório da aplicação;
- build de produção criado com `npm run build`;
- migrations aplicadas com `npm run db:migrate`;
- arquivo de ambiente da aplicação e do worker em `/etc/odontoartpix/app.env`;
- usuário Linux dos serviços (padrão: `odontoart`).

## 1. Aplicação Next.js

Instale a unit sem iniciar/publicar a aplicação:

```bash
sudo APP_DIR=/opt/odontoart-pix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/app.env \
  APP_HOST=127.0.0.1 \
  APP_PORT=3000 \
  bash deploy/systemd/install-app.sh
```

O instalador exige que `.next/BUILD_ID` exista, evitando iniciar uma versão sem `npm run build` concluído.

### Teste manual da aplicação

```bash
sudo systemctl start odontoartpix-app.service
sudo systemctl status odontoartpix-app.service --no-pager
sudo journalctl -u odontoartpix-app.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/api/health/db
```

O `curl` deve responder HTTP 200 antes de qualquer troca de tráfego público.

Depois da validação funcional:

```bash
sudo systemctl enable odontoartpix-app.service
```

> O serviço fica em `127.0.0.1:3000` por padrão. Publique-o por reverse proxy HTTPS. O exemplo em `deploy/nginx/odontoartpix.conf.example` inclui a configuração necessária para o SSE de `/api/processing/events`.

## 2. Worker local

O worker roda no ambiente que acessa o PostgreSQL próprio e o ERP.

O perfil **Agressivo** abaixo foi validado em produção em 25/08/2026 com throughput de aproximadamente `5,35 associados/s` em um lote real de 732 itens:

```text
WORKER_LIMIT=60
WORKER_CONCURRENCY=50
WORKER_DELAY_MS=0
WORKER_DATABASE_POOL_MAX=30
PROCESSING_BLOCK_SIZE=60
PROCESSING_CONCURRENCY=50
PROCESSING_ERP_CONCURRENCY=50
PROCESSING_MAX_BUFFERED_RESULTS=60
PROCESSING_PRODUCTIVE_DELAY_MS=0
```

Os argumentos da unit são limites máximos. O worker também respeita os valores do preset salvo no banco, portanto perfis mais conservadores continuam reduzindo bloco e concorrência sem reinstalar a unit.

Instalação sem ativar o timer:

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

Isso instala `odontoart-pix-worker.service` e `odontoart-pix-worker.timer`, mas mantém o timer desabilitado.

> Não instale uma segunda unit com outro nome enquanto `odontoart-pix-worker.timer` estiver ativo. O objetivo é manter um único consumidor local da fila.

### Teste manual do worker

Antes do teste, mantenha a fila pequena e controlada.

```bash
sudo systemctl start odontoart-pix-worker.service
sudo journalctl -u odontoart-pix-worker.service -n 100 --no-pager
```

Valide no banco/UI os resultados da parcela-alvo:

- `DescricaoRecebimento == "ABERTO"` => `unpaid`;
- `DescricaoRecebimento != "ABERTO"` com `ValorPago` válido => `paid`;
- se `ValorPago < Valor`, o registro permanece `paid` com `total_pending_amount_cents = Valor - ValorPago`;
- parcela-alvo ausente após a paginação necessária => erro;
- ausência da parcela nunca infere pagamento.

## 3. Consumo contínuo e sincronização automática

Somente depois da validação manual do worker:

```bash
sudo systemctl enable --now odontoart-pix-worker.timer
```

O timer acorda o worker para consumir a fila e deve permanecer ativo inclusive quando a sincronização automática estiver desativada, pois também atende solicitações manuais.

A criação automática de novas sincronizações gerais é controlada em **Configurações > Frequência automática**. A fonte única de verdade é:

```text
processing_scheduler_state.scheduler_enabled
```

- `false`: não cria novas sincronizações gerais automaticamente; o Dashboard continua permitindo sincronização manual;
- `true`: cria sincronizações automáticas conforme `processing_settings.scheduled_interval_minutes`;
- ao ativar, o próximo ciclo passa a contar a partir do momento da ativação.

Equivalente administrativo no PostgreSQL:

```sql
select set_local_processing_scheduler_enabled_v1(true);
select set_local_processing_scheduler_enabled_v1(false);
```

Não é necessário alterar arquivo de ambiente para ligar ou desligar o automático.

## 4. Desativação imediata

Parar todo o consumo da fila:

```bash
sudo systemctl disable --now odontoart-pix-worker.timer
```

Parar a aplicação web local:

```bash
sudo systemctl disable --now odontoartpix-app.service
```

Para desligar **somente** a criação automática de novas sincronizações, sem interromper jobs manuais:

- use o botão **Desativar** em `Configurações > Frequência automática`; ou
- execute:

```sql
select set_local_processing_scheduler_enabled_v1(false);
```

## 5. Ordem segura de corte

1. instalar dependências e build;
2. aplicar migrations;
3. instalar as units sem ativação automática;
4. iniciar `odontoartpix-app.service` manualmente;
5. validar `/api/health/db`, login, Dashboard e importação pequena;
6. processar uma fila pequena com o worker;
7. conferir regra financeira, pago com pendência e reprocessamento de erros;
8. configurar/validar reverse proxy HTTPS e SSE;
9. trocar o tráfego público somente após os testes;
10. habilitar `odontoart-pix-worker.timer`;
11. validar sincronização manual pelo Dashboard com automático desativado;
12. se desejado, ativar Frequência automática pela interface e validar a temporização antes de definir o intervalo definitivo.
