#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Execute como root/sudo." >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/odontoartpix}"
RUN_USER="${RUN_USER:-odontoart}"
ENV_FILE="${ENV_FILE:-/etc/odontoartpix/worker.env}"
TIMER_SECONDS="${TIMER_SECONDS:-10}"
ENABLE_TIMER="${ENABLE_TIMER:-false}"

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

if ! [[ "${TIMER_SECONDS}" =~ ^[0-9]+$ ]] || [ "${TIMER_SECONDS}" -lt 2 ]; then
  echo "TIMER_SECONDS deve ser inteiro >= 2." >&2
  exit 1
fi

cat >/etc/systemd/system/odontoartpix-worker.service <<EOF
[Unit]
Description=OdontoartPix PostgreSQL local worker
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/npm run worker:drain -- --delay-ms=1000 --max-cycles=1000
TimeoutStartSec=0
Nice=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/odontoartpix-worker.timer <<EOF
[Unit]
Description=Wake OdontoartPix local worker when queue may have work

[Timer]
OnBootSec=15s
OnUnitInactiveSec=${TIMER_SECONDS}s
AccuracySec=1s
Persistent=true
Unit=odontoartpix-worker.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

# Instalar nunca ativa processamento automaticamente. A ativacao exige
# ENABLE_TIMER=true de forma explicita, alem das travas de scheduler no env/DB.
if [ "${ENABLE_TIMER}" = "true" ]; then
  systemctl enable --now odontoartpix-worker.timer
  echo "odontoartpix-worker.timer habilitado."
else
  systemctl disable --now odontoartpix-worker.timer >/dev/null 2>&1 || true
  echo "Units instaladas, mas timer permanece DESABILITADO."
fi

systemctl status odontoartpix-worker.timer --no-pager || true
