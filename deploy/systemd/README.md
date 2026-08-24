# Worker local com systemd

O worker de processamento roda no mesmo ambiente que consegue acessar o PostgreSQL próprio e o ERP. O instalador **não habilita o timer por padrão**.

## Pré-requisitos

- aplicação instalada (padrão: `/opt/odontoartpix`);
- `npm ci` executado no diretório da aplicação;
- migrations aplicadas com `npm run db:migrate`;
- arquivo de ambiente do worker (padrão: `/etc/odontoartpix/worker.env`);
- usuário Linux do serviço (padrão: `odontoart`).

## Instalação sem ativação

```bash
sudo APP_DIR=/opt/odontoartpix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/worker.env \
  bash deploy/systemd/install-worker.sh
```

Isso instala `odontoartpix-worker.service` e `odontoartpix-worker.timer`, mas mantém o timer desabilitado.

## Teste manual

```bash
sudo systemctl start odontoartpix-worker.service
sudo journalctl -u odontoartpix-worker.service -n 100 --no-pager
```

## Ativação do consumo da fila

Depois da validação manual:

```bash
sudo systemctl enable --now odontoartpix-worker.timer
```

O timer apenas acorda o worker local. A criação automática de novas ondas gerais possui uma dupla trava independente:

1. `PROCESSING_ALLOW_SCHEDULED_SYNC=true` no arquivo de ambiente do worker;
2. `select set_local_processing_scheduler_enabled_v1(true);` no PostgreSQL.

Enquanto qualquer uma das duas estiver desabilitada, o automático não cria novas ondas. Ações manuais já enfileiradas continuam podendo ser consumidas pelo worker.

## Desativação imediata

```bash
sudo systemctl disable --now odontoartpix-worker.timer
```

Para desligar somente a criação automática de ondas, sem parar o consumo da fila manual:

```sql
select set_local_processing_scheduler_enabled_v1(false);
```
