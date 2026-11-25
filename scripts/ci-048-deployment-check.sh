#!/usr/bin/env bash
set -euo pipefail
[[ "$CI" == true && "$GITHUB_ACTIONS" == true && "$OPERATIONAL048_ISOLATED" == yes ]]
[[ "$DATABASE_HOST" == 127.0.0.1 && "$DATABASE_PORT" == 5432 && "$DATABASE_NAME" == odontoart_pix_ops048 && "$DATABASE_USER" == postgres ]]
[[ "$CI_PG_CONTAINER" =~ ^[a-f0-9]{12,64}$ ]]
mkdir -p operational-048
exec > >(tee operational-048/deployment.log) 2>&1
bash -n deploy/production/docker-safe-deploy.sh
bash -n scripts/048-maintenance-sql.sh
guard=deploy/production/guard-048-deploy.sh
[[ "$(bash "$guard" 47 0)" == ordinary ]]
[[ "$(bash "$guard" 48 1)" == verify-running-image ]]
if bash "$guard" 47 1 > operational-048/generic-transition.log 2>&1; then exit 1; fi
grep -F '[048_TRANSITION_REFUSED]' operational-048/generic-transition.log
if bash "$guard" 48 0 > operational-048/generic-downgrade.log 2>&1; then exit 1; fi
grep -F '[048_DOWNGRADE_REFUSED]' operational-048/generic-downgrade.log
if bash "$guard" invalid 1; then exit 1; fi
echo '[048_GENERIC_DEPLOY_GUARD_VERIFIED]'
admin(){ docker exec -i "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d odontoart_pix_ops048 "$@"; }
runtime(){ docker exec -i -e PGPASSWORD=ci-ops048-app "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U odontoart_pix_app -d odontoart_pix_ops048 "$@"; }
check(){ local actual; actual="$(admin -Atc "$1")"; [[ "$actual" == "$2" ]] || { echo "Expected [$2], got [$actual] for $1"; exit 1; }; }
migration=db/migrations/048_grouped_incremental_batch_totals_pilot.sql
tmp="$(mktemp -d)"
restore(){ if [[ -f "$tmp/048.sql" ]]; then mv "$tmp/048.sql" "$migration"; fi; rm -rf -- "$tmp"; }
trap restore EXIT
mv "$migration" "$tmp/048.sql"
npm run db:migrate
check 'select max(version) from schema_migrations' 47
admin <<'SQL'
grant usage on schema public to odontoart_pix_app;
grant select on public.schema_migrations,public.processing_scheduler_state,public.users to odontoart_pix_app;
grant create on schema public to odontoart_pix_app;
grant insert,update,delete on public.schema_migrations to odontoart_pix_app;
alter default privileges for role postgres in schema public grant select,insert,update,delete on tables to odontoart_pix_app;
alter default privileges for role postgres in schema public grant select,update,usage on sequences to odontoart_pix_app;
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
# Populated database: 40 canonical installments shared by three batches.
node --input-type=module <<'JS'
import pg from 'pg';
import {seedFixture,verifyTotals} from './scripts/local-financial-fixtures.mjs';
const client=new pg.Client({host:process.env.DATABASE_HOST,port:Number(process.env.DATABASE_PORT),database:process.env.DATABASE_NAME,user:process.env.DATABASE_USER,password:process.env.DATABASE_PASSWORD});
await client.connect();
try{
  await client.query('begin');
  const f=await seedFixture(client,40,'deployment-048');
  await client.query('commit');
  const diffs=await verifyTotals(client,f.batches);
  if(diffs.length) throw Error(JSON.stringify(diffs));
}finally{await client.end();}
JS
check 'select count(*) from member_target_installments' 40
check 'select count(*) from campaign_batch_members' 120
snapshot_sql="select md5(coalesce((select string_agg(to_jsonb(t)::text,',' order by id) from member_target_installments t),'')) || ':' || md5(coalesce((select string_agg(to_jsonb(l)::text,',' order by id) from campaign_batch_members l),'')) || ':' || md5(coalesce((select string_agg((to_jsonb(b)-'updated_at')::text,',' order by id) from campaign_batches b),''))"
snapshot="$(admin -Atc "$snapshot_sql")"
# Backup and real restore into another disposable DB, never the source.
docker exec "$CI_PG_CONTAINER" pg_dump -Fc -U postgres -d odontoart_pix_ops048 > "$tmp/pre048.dump"
test -s "$tmp/pre048.dump"
docker exec -i "$CI_PG_CONTAINER" pg_restore -l < "$tmp/pre048.dump" > operational-048/backup-inventory.log
docker exec "$CI_PG_CONTAINER" createdb -U postgres -T template0 odontoart_pix_ops048_restore
docker exec -i "$CI_PG_CONTAINER" pg_restore -e -1 -U postgres -d odontoart_pix_ops048_restore < "$tmp/pre048.dump"
restored="$(docker exec "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -At -U postgres -d odontoart_pix_ops048_restore -c "$snapshot_sql")"
[[ "$restored" == "$snapshot" ]]
echo '[048_BACKUP_RESTORE_VERIFIED] populated source matches disposable restore'
bash scripts/048-maintenance-sql.sh install > "$tmp/install.sql"
bash scripts/048-maintenance-sql.sh activate > "$tmp/activate.sql"
bash scripts/048-maintenance-sql.sh disable > "$tmp/disable.sql"
run_sql(){ admin -1 -f - < "$1"; }
expect_failure(){ local file="$1" marker="$2" label="$3"; if run_sql "$file" > "operational-048/$label.log" 2>&1; then echo "Unexpected success: $label"; exit 1; fi; grep -F "$marker" "operational-048/$label.log"; }
# Hold real worker advisory key on another session; reject without changes.
docker exec -e PGAPPNAME=ci048-maintenance-blocker "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d odontoart_pix_ops048 -c 'select pg_advisory_lock(17483621,20260821); select pg_sleep(60)' > "$tmp/worker-lock.log" 2>&1 &
blocker=$!
for i in $(seq 1 100); do
  [[ "$(admin -Atc "select count(*) from pg_locks where locktype='advisory' and classid=17483621 and objid=20260821 and objsubid=2 and granted")" == 1 ]] && break
  sleep .1
done
expect_failure "$tmp/install.sql" 'worker or deletion lock busy' worker-lock-rejected
admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and application_name='ci048-maintenance-blocker'"
wait "$blocker" || true
check 'select max(version) from schema_migrations' 47
# Real app connection must be refused even if idle/no active run.
docker exec -e PGAPPNAME=ci048-maintenance-app -e PGPASSWORD=ci-ops048-app "$CI_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U odontoart_pix_app -d odontoart_pix_ops048 -c 'select pg_sleep(60)' > "$tmp/app-session.log" 2>&1 &
app_pid=$!
for i in $(seq 1 100); do
  [[ "$(admin -Atc "select count(*) from pg_stat_activity where datname=current_database() and application_name='ci048-maintenance-app'")" == 1 ]] && break
  sleep .1
done
expect_failure "$tmp/install.sql" 'application sessions remain connected' app-session-rejected
admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and application_name='ci048-maintenance-app'"
wait "$app_pid" || true
# A stale official total blocks installation. Restore it before retry.
admin -c 'update campaign_batches set total_records=total_records+1'
expect_failure "$tmp/install.sql" 'pre-install/activation audit differs' audit-rejected
admin -c 'select public.recalculate_batch_totals_many(array(select id from campaign_batches order by id))'
[[ "$(admin -Atc "$snapshot_sql")" == "$snapshot" ]]
# Fail after all DDL and assertions but before the enclosing commit.
cp "$tmp/install.sql" "$tmp/injected-failure.sql"
printf '%s\n' 'select 1/0;' >> "$tmp/injected-failure.sql"
expect_failure "$tmp/injected-failure.sql" 'division by zero' transactional-rollback
check 'select max(version) from schema_migrations' 47
check "select to_regclass('public.grouped_incremental_totals_state') is null and to_regprocedure('public.flush_grouped_batch_totals_v2()') is null" t
[[ "$(admin -Atc "$snapshot_sql")" == "$snapshot" ]]
# Run the exact reviewed administrative stream, not npm runtime migration.
run_sql "$tmp/install.sql"
check 'select max(version) from schema_migrations' 48
expect_failure "$tmp/install.sql" 'expected intact schema 047' repeated-install-rejected
[[ "$(admin -Atc "$snapshot_sql")" == "$snapshot" ]]
check 'select enabled from public.grouped_incremental_totals_state' f
check 'select enabled from public.batch_totals_shadow_state' t
DATABASE_USER=odontoart_pix_app DATABASE_PASSWORD=ci-ops048-app npm run preflight:production
# Exercise old entry point with the new schema and 048 disabled.
admin <<'SQL'
begin;
select set_config('odontoart.grouped_batch_totals','on',true);
select public.flush_grouped_batch_totals_v1();
commit;
SQL
run_sql "$tmp/activate.sql"
check 'select enabled from public.grouped_incremental_totals_state' t
run_sql "$tmp/disable.sql"
[[ "$(admin -Atc "$snapshot_sql")" == "$snapshot" ]]
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
echo '[048_DEPLOYMENT_LIMIT] no image swap or real server; old-image rollback refused after commit; use compatible image with pilot disabled for functional rollback'
