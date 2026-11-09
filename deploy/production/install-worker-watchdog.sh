#!/usr/bin/env bash
# Instalacao opcional do watchdog independente no host Docker.
set -Eeuo pipefail
[ "${EUID}" -eq 0 ] || { echo "Execute como root" >&2; exit 1; }
SOURCE="${ODONTOPIX_ROOT:-/opt/odontopix}/app/deploy/production/worker-watchdog.py"
test -f "${SOURCE}" || { echo "Arquivo ausente: ${SOURCE}" >&2; exit 1; }
install -Dm 0755 "${SOURCE}" /usr/local/libexec/odontopix-worker-watchdog.py
install -d -m 0700 /var/lib/odontopix-worker-watchdog /var/log/odontopix

cat > /etc/systemd/system/odontopix-worker-watchdog.service <<'UNIT'
[Unit]
Description=ODONTOPIX - Vigia independente do timer do worker
After=local-fs.target docker.service
Wants=docker.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 /usr/local/libexec/odontopix-worker-watchdog.py
TimeoutStartSec=45
NoNewPrivileges=true
UNIT

cat > /etc/systemd/system/odontopix-worker-watchdog.timer <<'UNIT'
[Unit]
Description=ODONTOPIX - Monitor do worker a cada minuto

[Timer]
OnBootSec=90s
OnUnitInactiveSec=60s
AccuracySec=5s
Persistent=true
Unit=odontopix-worker-watchdog.service

[Install]
WantedBy=timers.target
UNIT

cat > /etc/logrotate.d/odontopix-worker-watchdog <<'ROTATE'
/var/log/odontopix/worker-incidents.jsonl {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0600 root root
}
ROTATE

systemctl daemon-reload
if [ "${ENABLE_WATCHDOG:-false}" = true ]; then
  systemctl enable --now odontopix-worker-watchdog.timer
  echo "[WORKER_WATCHDOG_INSTALLED] enabled"
else
  echo "[WORKER_WATCHDOG_INSTALLED] aguardando ENABLE_WATCHDOG=true"
  echo "Para ativar: systemctl enable --now odontopix-worker-watchdog.timer"
fi
