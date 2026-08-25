#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Execute como root/sudo." >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/odontoart-pix}"
RUN_USER="${RUN_USER:-odontoart}"
ENV_FILE="${ENV_FILE:-/etc/odontoartpix/app.env}"
SERVICE_NAME="${SERVICE_NAME:-odontoart-pix-worker}"
TIMER_SECONDS="${TIMER_SECONDS:-30}"
ENABLE_TIMER="${ENABLE_TIMER:-false}"
WORKER_LIMIT="${WORKER_LIMIT:-60}"
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-50}"
WORKER_DELAY_MS="${WORKER_DELAY_MS:-0}"
WORKER_DATABASE_POOL_MAX="${WORKER_DATABASE_POOL_MAX:-30}"

if [ ! -f "${APP_DIR}/package.json" ]; then
  echo "package.json nao encontrado em ${APP_DIR}. Ajuste APP_DIR." >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "Arquivo de ambiente nao encontrado: ${ENV_FILE}" >&2
  exit 1
fi

if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "Usuario do servico nao existe: ${RUN_USER}" >&2
  exit 1
fi

for numeric_var in TIMER_SECONDS WORKER_LIMIT WORKER_CONCURRENCY WORKER_DELAY_MS WORKER_DATABASE_POOL_MAX; do
  value="${!numeric_var}"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "${numeric_var} deve ser inteiro >= 0." >&2
    exit 1
  fi
done

if [ "${TIMER_SECONDS}" -lt 2 ]; then
  echo "TIMER_SECONDS deve ser inteiro >= 2." >&2
  exit 1
fi

if [ "${WORKER_LIMIT}" -lt 1 ] || [ "${WORKER_CONCURRENCY}" -lt 1 ] || [ "${WORKER_DATABASE_POOL_MAX}" -lt 1 ]; then
  echo "WORKER_LIMIT, WORKER_CONCURRENCY e WORKER_DATABASE_POOL_MAX devem ser >= 1." >&2
  exit 1
fi

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=OdontoartPix - Worker de processamento
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
Environment=DATABASE_POOL_MAX=${WORKER_DATABASE_POOL_MAX}
ExecStart=/usr/bin/npx tsx scripts/process-local-worker.ts --limit=${WORKER_LIMIT} --concurrency=${WORKER_CONCURRENCY} --drain --delay-ms=${WORKER_DELAY_MS}
TimeoutStartSec=infinity
Nice=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/${SERVICE_NAME}.timer <<EOF
[Unit]
Description=OdontoartPix - Agenda do worker local

[Timer]
OnBootSec=15s
OnUnitInactiveSec=${TIMER_SECONDS}s
AccuracySec=1s
Persistent=true
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

# Instalar nunca ativa processamento automaticamente. A ativacao exige
# ENABLE_TIMER=true de forma explicita, alem das travas de scheduler no env/DB.
if [ "${ENABLE_TIMER}" = "true" ]; then
  systemctl enable --now ${SERVICE_NAME}.timer
  echo "${SERVICE_NAME}.timer habilitado."
else
  systemctl disable --now ${SERVICE_NAME}.timer >/dev/null 2>&1 || true
  echo "Units instaladas, mas timer permanece DESABILITADO."
fi

systemctl status ${SERVICE_NAME}.timer --no-pager || true
