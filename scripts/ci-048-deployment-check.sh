#!/usr/bin/env bash
set -euo pipefail
[[ "$CI" == true && "$GITHUB_ACTIONS" == true && "$OPERATIONAL048_ISOLATED" == yes ]]
[[ "$DATABASE_HOST" == 127.0.0.1 && "$DATABASE_PORT" == 5432 && "$DATABASE_NAME" == odontoart_pix_ops048 && "$DATABASE_USER" == postgres ]]
[[ "$CI_PG_CONTAINER" =~ ^[a-f0-9]{12,64}$ ]]
mkdir -p operational-048
exec > >(tee operational-048/deployment.log) 2>&1
admin(){ docker exec -i "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d odontoart_pix_ops048 "$@"; }
runtime(){ docker exec -i -e PGPASSWORD=ci-ops048-app "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U odontoart_pix_app -d odontoart_pix_ops048 "$@"; }
check(){ local actual; actual="$(admin -Atc "$1")"; [[ "$actual" == "$2" ]] || { echo "Expected [$2], got [$actual] for $1"; exit 1; }; }
migration=db/migrations/048_grouped_incremental_batch_totals_pilot.sql
tmp="$(mktemp -d)"
restore(){ if [[ -f "$tmp/048.sql" ]]; then mv "$tmp/048.sql" "$migration"; fi; rmdir "$tmp"; }
trap restore EXIT
mv "$migration" "$tmp/048.sql"
npm run db:migrate
check 'select max(version) from schema_migrations' 47
admin <<'SQL'
grant usage on schema public to odontoart_pix_app;
grant select on public.schema_migrations,public.processing_scheduler_state,public.users to odontoart_pix_app;
select public.set_batch_totals_shadow_v1(true);
SQL
DATABASE_USER=odontoart_pix_app DATABASE_PASSWORD=ci-ops048-app npm run preflight:production
# Direct migration execution by the runtime role must be rejected at its guard.
if runtime --single-transaction -f - < "$tmp/048.sql" > operational-048/runtime-migration.log 2>&1; then
  echo 'ERROR runtime role installed 048'; exit 1
fi
grep -F 'Migration 048 requires the database administrator' operational-048/runtime-migration.log
check 'select max(version) from schema_migrations' 47
check "select to_regclass('public.grouped_incremental_totals_state') is null" t
mv "$tmp/048.sql" "$migration"
npm run db:migrate
check 'select max(version) from schema_migrations' 48
check 'select enabled from public.grouped_incremental_totals_state' f
check 'select enabled from public.batch_totals_shadow_state' t
DATABASE_USER=odontoart_pix_app DATABASE_PASSWORD=ci-ops048-app npm run preflight:production
# Exercise old entry point with the new schema and 048 disabled.
admin <<'SQL'
begin;
select set_config('odontoart.grouped_batch_totals','on',true);
select public.flush_grouped_batch_totals_v1();
commit;
select public.set_grouped_incremental_totals_v1(true);
select public.set_grouped_incremental_totals_v1(false);
SQL
check 'select enabled from public.grouped_incremental_totals_state' f
check 'select enabled from public.batch_totals_shadow_state' t
check 'select count(*) from public.batch_totals_shadow_audit_v1 where official_differs or shadow_differs or orphan_batch' 0
check 'select count(*) from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution' 0
# Same preflight algorithm, old migration inventory. Never fake migration history.
mv "$migration" "$tmp/048.sql"
if DATABASE_USER=odontoart_pix_app DATABASE_PASSWORD=ci-ops048-app npm run preflight:production > operational-048/old-preflight.log 2>&1; then
  echo 'ERROR old preflight accepted unknown migration'; exit 1
fi
grep -F 'O banco possui migrations que nao existem neste checkout: 48' operational-048/old-preflight.log
mv "$tmp/048.sql" "$migration"
DATABASE_USER=odontoart_pix_app DATABASE_PASSWORD=ci-ops048-app npm run preflight:production
echo '[048_DEPLOYMENT_CHECK] admin install passed, runtime rejected, 048 disabled, shadow preserved, old preflight rejects schema 48 as expected'
echo '[048_DEPLOYMENT_LIMIT] no image swap or real server; old-image rollback needs explicit procedure; use new image with pilot disabled for functional rollback'
