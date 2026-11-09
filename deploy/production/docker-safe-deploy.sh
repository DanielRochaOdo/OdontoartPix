#!/usr/bin/env bash
# Deploy controlado da VPS Docker ODONTOPIX: somente app; PostgreSQL intocado.
set -Eeuo pipefail
umask 077
[ "${EUID}" -eq 0 ] || { echo "Execute como root" >&2; exit 1; }

ROOT="${ODONTOPIX_ROOT:-/opt/odontopix}"
APP="${ROOT}/app"
COMPOSE="${ROOT}/compose.yaml"
TIMER=odontopix-worker.timer
SERVICE=odontopix-worker.service
MAINT=/run/odontopix-worker-maintenance
HEALTH=http://127.0.0.1:3100/api/health/db

cd "${ROOT}"
for cmd in docker git python3 flock curl systemctl; do
  command -v "${cmd}" >/dev/null || { echo "Comando ausente: ${cmd}" >&2; exit 1; }
done
test -f "${COMPOSE}"
test -f "${APP}/Dockerfile"

exec 9>/run/lock/odontopix-safe-deploy.lock
flock -n 9 || { echo "Outro deploy esta em andamento" >&2; exit 1; }
[ ! -e "${MAINT}" ] || { echo "Trava de manutencao presente: ${MAINT}" >&2; exit 1; }
systemctl is-active --quiet "${TIMER}" || {
  echo "Timer inativo antes do deploy; corrigir primeiro" >&2; exit 1;
}

OLD_IMAGE=""
NEW_IMAGE=""
BACKUP_COMPOSE=""
OVERRIDE=""
MARKED=0
SWITCH_STARTED=0

cleanup() {
  rc=$?
  trap - EXIT
  [ -z "${OVERRIDE}" ] || rm -f "${OVERRIDE}"
  [ "${rc}" -ne 0 ] || return 0
  echo "[SAFE_DEPLOY_FAILED] exit=${rc}" >&2
  [ "${MARKED}" -eq 1 ] || return 0
  if [ "${SWITCH_STARTED}" -eq 1 ] && [ -f "${BACKUP_COMPOSE}" ]; then
    cp -a "${BACKUP_COMPOSE}" "${COMPOSE}"
    docker compose -f "${COMPOSE}" up -d --no-deps --no-build --force-recreate app || true
  fi
  running="$(docker inspect odontopix-app-1 --format '{{.Config.Image}}' 2>/dev/null || true)"
  if [ "${running}" = "${OLD_IMAGE}" ] \
     && curl -fsS --max-time 5 "${HEALTH}" >/dev/null; then
    if systemctl start "${TIMER}" && systemctl is-active --quiet "${TIMER}"; then
      rm -f "${MAINT}/deployment"
      rmdir "${MAINT}" || true
      echo "[SAFE_DEPLOY_ROLLBACK_OK] timer=active" >&2
      return 0
    fi
  fi
  echo "ATENCAO: trava ${MAINT} preservada. Verifique a aplicacao antes de restaurar o worker." >&2
}
trap cleanup EXIT

echo "=== CODIGO E BUILD: SEM PARAR WORKER ==="
git -C "${APP}" switch main
git -C "${APP}" pull --ff-only origin main
REV="$(git -C "${APP}" rev-parse --short=12 HEAD)"
NEW_IMAGE="odontopix-app:${REV}"
OLD_IMAGE="$(docker inspect odontopix-app-1 --format '{{.Config.Image}}')"
CURRENT="$(docker compose -f "${COMPOSE}" config --format json |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["app"]["image"])')"
[ "${CURRENT}" = "${OLD_IMAGE}" ] || {
  echo "Compose aponta para ${CURRENT}, mas app roda ${OLD_IMAGE}. Resolva inconsistencia." >&2
  exit 1
}
docker build -t "${NEW_IMAGE}" -f "${APP}/Dockerfile" "${APP}"

active_syncs() {
  docker exec odontopix-db-1 sh -lc \
    'exec psql -X -v ON_ERROR_STOP=1 -A -t -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c "select count(*) from general_sync_runs where status in ('"'"'queued'"'"','"'"'running'"'"','"'"'paused'"'"','"'"'cancelling'"'"')"' |
    tr -d '[:space:]'
}
ensure_idle() {
  n="$(active_syncs)"
  [[ "${n}" =~ ^[0-9]+$$ ]] || { echo "Falha na consulta de sincronizacoes" >&2; exit 1; }
  [ "${n}" -eq 0 ] || { echo "${n} sincronizacao(oes) ativa(s); deploy recusado para preservar leituras" >&2; exit 1; }
}
ensure_idle

echo "=== BACKUP ANTES DAS MIGRATIONS ==="
mkdir -p "${ROOT}/backups"
DUMP="${ROOT}/backups/pre-${REV}-$(date +%Y%m%d-%H%M%S).dump"
docker exec odontopix-db-1 sh -lc \
  'exec pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"' > "${DUMP}"
test -s "${DUMP}"
docker exec -i odontopix-db-1 pg_restore -l < "${DUMP}" >/dev/null

OVERRIDE="$(mktemp /tmp/odontopix-image-XXXXXXXX.yaml)"
printf 'services:\n  app:\n    image: %s\n' "${NEW_IMAGE}" > "${OVERRIDE}"
echo "=== MIGRATIONS E PREFLIGHT NA IMAGEM NOVA, TIMER CONTINUA ATIVO ==="
docker compose -f "${COMPOSE}" -f "${OVERRIDE}" run \
  --rm --no-deps --entrypoint npm app run db:migrate
docker compose -f "${COMPOSE}" -f "${OVERRIDE}" run \
  --rm --no-deps --entrypoint npm app run preflight:production

# Se uma nova sincronizacao iniciou durante o preflight, recusar o corte.
ensure_idle
echo "=== CORTE CONTROLADO, SEM TOCAR NO POSTGRESQL ==="
BACKUP_COMPOSE="${ROOT}/compose.yaml.bak-${REV}-$(date +%Y%m%d-%H%M%S)"
cp -a "${COMPOSE}" "${BACKUP_COMPOSE}"
mkdir "${MAINT}"
MARKED=1
printf 'commit=%s\nstarted=%s\n' "${REV}" "$(date -Is)" > "${MAINT}/deployment"
systemctl stop "${TIMER}"

for i in $(seq 1 120); do
  state="$(systemctl show -p ActiveState --value "${SERVICE}")"
  if [ "${state}" = inactive ] || [ "${state}" = failed ]; then break; fi
  sleep 3
done
state="$(systemctl show -p ActiveState --value "${SERVICE}")"
[ "${state}" = inactive ] || [ "${state}" = failed ] || {
  echo "Worker ainda em ciclo, abortando antes da troca" >&2; exit 1;
}
# Apos parar o timer, checar novamente (o ultimo ciclo pode iniciar uma onda).
ensure_idle

echo "=== RECRIAR SOMENTE APP ==="
SWITCH_STARTED=1
grep -Fq "${OLD_IMAGE}" "${COMPOSE}"
sed -i "s|${OLD_IMAGE}|${NEW_IMAGE}|g" "${COMPOSE}"
FINAL="$(docker compose -f "${COMPOSE}" config --format json |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["app"]["image"])')"
[ "${FINAL}" = "${NEW_IMAGE}" ]
docker compose -f "${COMPOSE}" up -d --no-deps --no-build --force-recreate app

test "$(docker inspect odontopix-app-1 --format '{{.Config.Image}}')" = "${NEW_IMAGE}"
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "${HEALTH}" >/dev/null; then HEALTH_OK=1; break; fi
  sleep 3
done
[ "${HEALTH_OK}" -eq 1 ]

echo "=== RESTAURAR TIMER ==="
systemctl start "${TIMER}"
systemctl is-active --quiet "${TIMER}"
rm -f "${MAINT}/deployment"
rmdir "${MAINT}"
MARKED=0
echo "[SAFE_DEPLOY_OK] imagem=${NEW_IMAGE} backup=${DUMP} timer=active"
