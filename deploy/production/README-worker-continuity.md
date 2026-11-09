# Continuidade do processamento na VPS Docker ODONTOPIX

Aplicavel somente a VPS atual: checkout em /opt/odontopix/app,
Compose em /opt/odontopix/compose.yaml, Docker app odontopix-app-1
e db odontopix-db-1; systemd odontopix-worker.timer e .service.

## Deploy seguro

Execute APENAS quando nao houver sincronizacao geral ativa:

```bash
sudo bash /opt/odontopix/app/deploy/production/docker-safe-deploy.sh
```

O script atualiza main e constrói a imagem com o timer ATIVO, sem derrubar
o processamento. Verifica o estado das sincronizacoes antes das migrations,
gera backup PostgreSQL pg_dump -Fc, valida o indice do backup, executa
migrations e preflight em container temporario da NOVA imagem e revalida
se uma onda automatica iniciou durante o preparo.

Somente na etapa final cria a trava de manutencao
/run/odontopix-worker-maintenance, para o watchdog nao religar o worker
durante a troca. Para o timer, espera ate o worker atual terminar,
revalida a ausencia de sincronizacao ativa, substitui SOMENTE o app com
docker compose up -d --no-deps --no-build --force-recreate app, confirma
a imagem e executa health check antes de reativar o timer.

Em erro apos a troca, faz rollback SOMENTE do app e do Compose anterior.
So reativa o timer se a imagem anterior estiver saudavel. Se o rollback
nao for saudavel, deixa a manutencao marcada e o timer parado para analise.
Nao usar docker compose down. Nunca recriar ou reiniciar o banco.

ATENCAO: reverter imagem nao reverte migration aplicada. Mudancas
incompativeis de schema exigem plano de migration proprio.

## Watchdog independente

Apos o merge e atualizacao do checkout, instalar no HOST:

```bash
sudo ENABLE_WATCHDOG=true bash /opt/odontopix/app/deploy/production/install-worker-watchdog.sh
systemctl is-active odontopix-worker-watchdog.timer
```

Roda com Python padrao fora do app a cada 60 segundos. Verifica
o estado do timer, Docker, health HTTP e heartbeats em PostgreSQL.
Se o timer estiver inativo, SOMENTE o reativa caso esteja enabled,
NAO exista trava de manutencao e o app esteja saudavel.
Se estiver disabled, em manutencao, com container parado ou sem health,
nao reativa. Uma sincronizacao sem heartbeat E sem progresso por
mais de cinco minutos gera alerta de diagnostico, sem restart.

O monitor registra eventos JSONL em
/var/log/odontopix/worker-incidents.jsonl e no journal systemd.
O log e rotacionado diariamente por 30 dias. Os eventos incluem
timer_inactive, timer_recovered, timer_restored_externally,
timer_recovery_blocked, timer_recovery_failed, worker_service_failure,
sync_without_progress e sync_activity_restored.

Monitoramento a cada 60s pode nao detectar paradas mais curtas.
Os tempos relatados medem a indisponibilidade OBSERVADA do timer,
e nao equivalem necessariamente a intervalos sem HTTP para o ERP.

## Relatorio operacional

```bash
journalctl -u odontopix-worker-watchdog.service -n 80 --no-pager
python3 /opt/odontopix/app/deploy/production/worker-incidents-report.py
systemctl status odontopix-worker.timer --no-pager
```

## Manutencao manual

Antes de parar intencionalmente:

```bash
sudo mkdir /run/odontopix-worker-maintenance
sudo systemctl stop odontopix-worker.timer
```

Ao finalizar, depois de validar o app:

```bash
curl -fsS http://127.0.0.1:3100/api/health/db
sudo systemctl start odontopix-worker.timer
sudo rmdir /run/odontopix-worker-maintenance
```

O watchdog NAO remove trava de manutencao antiga automaticamente,
pois pode indicar deploy incompleto. Investigue antes de remover.
Para desativacao intencional e duradoura, utilize
systemctl disable --now odontopix-worker.timer (o watchdog respeita disabled).

As units antigas do runbook de instalacao local (odontoart-pix-worker)
sao DIFERENTES das unidades realmente usadas na VPS; nao instale dois timers.
