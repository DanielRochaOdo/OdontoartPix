# Aplicação web e worker local com systemd

A arquitetura de produção local usa dois componentes independentes:

- `odontoartpix-app.service`: mantém o Next.js em execução;
- `odontoartpix-worker.service` + `odontoartpix-worker.timer`: consomem a fila de processamento.

Os instaladores são seguros por padrão: **nem a aplicação web nem o timer do worker são ativados automaticamente**.

## Pré-requisitos

- aplicação instalada (padrão: `/opt/odontoartpix`);
- `npm ci` executado no diretório da aplicação;
- build de produção criado com `npm run build`;
- migrations aplicadas com `npm run db:migrate`;
- arquivo de ambiente da aplicação (padrão: `/etc/odontoartpix/app.env`);
- arquivo de ambiente do worker (padrão: `/etc/odontoartpix/worker.env`);
- usuário Linux dos serviços (padrão: `odontoart`).

## 1. Aplicação Next.js

Instale a unit sem iniciar/publicar a aplicação:

```bash
sudo APP_DIR=/opt/odontoartpix \
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

O worker roda no ambiente que consegue acessar o PostgreSQL próprio e o ERP.

Instalação sem ativar o timer:

```bash
sudo APP_DIR=/opt/odontoartpix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/worker.env \
  bash deploy/systemd/install-worker.sh
```

Isso instala `odontoartpix-worker.service` e `odontoartpix-worker.timer`, mas mantém o timer desabilitado.

### Teste manual do worker

Antes do teste, mantenha a fila pequena e controlada.

```bash
sudo systemctl start odontoartpix-worker.service
sudo journalctl -u odontoartpix-worker.service -n 100 --no-pager
```

Valide no banco/UI os resultados da parcela-alvo:

- `DescricaoRecebimento == "ABERTO"` => `unpaid`;
- `DescricaoRecebimento != "ABERTO"` e `ValorPago >= Valor` => `paid`;
- parcela-alvo ausente após a paginação necessária => erro;
- ausência da parcela nunca infere pagamento.

## 3. Ativação do consumo contínuo da fila

Somente depois da validação manual:

```bash
sudo systemctl enable --now odontoartpix-worker.timer
```

O timer apenas acorda o worker local. A criação automática de novas ondas gerais possui uma dupla trava independente:

1. `PROCESSING_ALLOW_SCHEDULED_SYNC=true` no arquivo de ambiente do worker;
2. `select set_local_processing_scheduler_enabled_v1(true);` no PostgreSQL.

Enquanto qualquer uma das duas estiver desabilitada, o automático não cria novas ondas. Ações manuais já enfileiradas continuam podendo ser consumidas pelo worker.

## 4. Desativação imediata

Parar o consumo da fila:

```bash
sudo systemctl disable --now odontoartpix-worker.timer
```

Parar a aplicação web local:

```bash
sudo systemctl disable --now odontoartpix-app.service
```

Para desligar somente a criação automática de ondas, sem parar o consumo das solicitações manuais:

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
7. conferir a regra financeira e o reprocessamento de erros;
8. configurar/validar reverse proxy HTTPS e SSE;
9. trocar o tráfego público somente após os testes;
10. habilitar o timer do worker;
11. manter o scheduler de ondas automáticas desligado até uma validação posterior, se desejado.
