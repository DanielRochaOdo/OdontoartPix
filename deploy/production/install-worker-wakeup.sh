#!/usr/bin/env bash
# Instalacao opcional; nao altera o timer nem inicia o listener sem ENABLE_WORKER_WAKEUP=true.
set -Eeuo pipefail
[ "${EUID}" -eq 0 ] || { echo "Execute como root" >&2; exit 1; }
SOURCE="${ODONTOPIX_ROOT:-/opt/odontopix}/app/deploy/production/odontopix-worker-wakeup.service"
test -f "${SOURCE}" || { echo "Arquivo ausente: ${SOURCE}" >&2; exit 1; }
install -Dm 0644 "${SOURCE}" /etc/systemd/system/odontopix-worker-wakeup.service
systemctl daemon-reload
if [ "${ENABLE_WORKER_WAKEUP:-false}" = "true" ]; then
  systemctl enable --now odontopix-worker-wakeup.service
  echo "[WORKER_WAKEUP_INSTALLED] enabled"
else
  echo "[WORKER_WAKEUP_INSTALLED] unit instalada, ainda desativada"
fi
