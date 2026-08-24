#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Execute como root/sudo." >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/odontoartpix}"
RUN_USER="${RUN_USER:-odontoart}"
ENV_FILE="${ENV_FILE:-/etc/odontoartpix/app.env}"
APP_HOST="${APP_HOST:-127.0.0.1}"
APP_PORT="${APP_PORT:-3000}"
ENABLE_APP="${ENABLE_APP:-false}"

if [ ! -f "${APP_DIR}/package.json" ]; then
  echo "package.json nao encontrado em ${APP_DIR}. Ajuste APP_DIR." >&2
  exit 1
fi

if [ ! -f "${APP_DIR}/.next/BUILD_ID" ]; then
  echo "Build de producao nao encontrado em ${APP_DIR}/.next. Execute npm run build antes de instalar/iniciar o servico." >&2
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

if ! [[ "${APP_PORT}" =~ ^[0-9]+$ ]] || [ "${APP_PORT}" -lt 1 ] || [ "${APP_PORT}" -gt 65535 ]; then
  echo "APP_PORT deve ser um inteiro entre 1 e 65535." >&2
  exit 1
fi

if [ ! -x /usr/bin/npm ]; then
  echo "/usr/bin/npm nao encontrado. Instale Node.js/npm no servidor antes de continuar." >&2
  exit 1
fi

cat >/etc/systemd/system/odontoartpix-app.service <<EOF
[Unit]
Description=OdontoartPix Next.js application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStartPre=/usr/bin/test -f ${APP_DIR}/.next/BUILD_ID
ExecStart=/usr/bin/npm run start -- --hostname ${APP_HOST} --port ${APP_PORT}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}/.next

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# O instalador nunca publica/inicia a aplicacao por acidente.
# A ativacao exige ENABLE_APP=true explicitamente ou um systemctl start manual.
if [ "${ENABLE_APP}" = "true" ]; then
  systemctl enable --now odontoartpix-app.service
  echo "odontoartpix-app.service habilitado e iniciado em ${APP_HOST}:${APP_PORT}."
else
  systemctl disable --now odontoartpix-app.service >/dev/null 2>&1 || true
  echo "Unit instalada, mas a aplicacao permanece DESABILITADA/PARADA."
fi

systemctl status odontoartpix-app.service --no-pager || true
