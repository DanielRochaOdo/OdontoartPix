#!/usr/bin/env bash
# Emits SQL only. Execute the entire stream with psql -X -v ON_ERROR_STOP=1 -1 -f -.
# No database connection, host changes or activation unless explicitly selected.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: $0 install|activate|disable" >&2; exit 2; }
mode="$1"
case "$mode" in install|activate|disable) ;; *) exit 2;; esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cat <<'SQL'
set local lock_timeout='5s';
set local statement_timeout='120s';
set local idle_in_transaction_session_timeout='120s';
set local search_path=pg_catalog,public,pg_temp;
do $gate$
begin
  if current_user='odontoart_pix_app' or current_user<>session_user
    or not exists(select 1 from pg_roles where rolname=current_user and rolsuper) then
    raise exception '048 maintenance requires the database administrator';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception '048 maintenance requires read committed';
  end if;
  if not pg_try_advisory_xact_lock(17483621,20260821) then
    raise exception '048 maintenance: worker or deletion lock busy';
  end if;
  if not pg_try_advisory_xact_lock(2026082401::bigint) then
    raise exception '048 maintenance: migration lock busy';
  end if;
  if exists(select 1 from pg_stat_activity where datname=current_database()
    and usename='odontoart_pix_app' and pid<>pg_backend_pid()) then
    raise exception '048 maintenance: application sessions remain connected';
  end if;
end;
$gate$;
lock table public.campaigns,public.campaign_batches,public.campaign_batch_members,
  public.member_target_installments,public.general_sync_runs,public.processing_jobs,
  public.schema_migrations,public.batch_totals_shadow_state
  in share row exclusive mode nowait;
do $gate$
begin
  if not pg_try_advisory_xact_lock(20261124047::bigint) then
    raise exception '048 maintenance: shadow lock busy';
  end if;
  if exists(select 1 from public.general_sync_runs where status in ('queued','running','paused','cancelling'))
    or exists(select 1 from public.processing_jobs where status in ('queued','running','paused','deferred')) then
    raise exception '048 maintenance: active or queued processing remains';
  end if;
  if not coalesce((select enabled from public.batch_totals_shadow_state where singleton),false) then
    raise exception '048 maintenance: shadow must be enabled';
  end if;
  if exists(select 1 from public.grouped_batch_totals_pending)
    or exists(select 1 from public.batch_totals_shadow_dirty)
    or exists(select 1 from public.batch_totals_shadow_transactions) then
    raise exception '048 maintenance: pending totals work';
  end if;
end;
$gate$;
SQL
# Install/activate require clean totals. Disable deliberately allows repair by
# the existing administrative function, but the postcondition still audits.
if [[ "$mode" != disable ]]; then
cat <<'SQL'
do $audit$
begin
  if exists(select 1 from public.batch_totals_shadow_audit_v1 where official_differs or shadow_differs or orphan_batch)
    or exists(select 1 from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution) then
    raise exception '048 maintenance: pre-install/activation audit differs';
  end if;
end;
$audit$;
SQL
fi
if [[ "$mode" == install ]]; then
cat <<'SQL'
do $version$
begin
  if (select max(version) from public.schema_migrations) is distinct from 47
    or to_regclass('public.grouped_incremental_totals_state') is not null
    or to_regclass('public.grouped_incremental_totals_pending') is not null
    or to_regprocedure('public.flush_grouped_batch_totals_v2()') is not null then
    raise exception '048 install: expected intact schema 047';
  end if;
end;
$version$;
SQL
cat "$root/db/migrations/048_grouped_incremental_batch_totals_pilot.sql"
printf "\nselect set_config('odontoart.maintenance048.expected','off',true);\n"
else
cat <<'SQL'
do $version$
begin
  if (select max(version) from public.schema_migrations) is distinct from 48 then
    raise exception '048 maintenance: expected installed schema 048';
  end if;
  if exists(select 1 from public.grouped_incremental_totals_pending) then
    raise exception '048 maintenance: pending incremental work';
  end if;
end;
$version$;
SQL
if [[ "$mode" == activate ]]; then
  printf "select public.set_grouped_incremental_totals_v1(true);\nselect set_config('odontoart.maintenance048.expected','on',true);\n"
else
  printf "select public.set_grouped_incremental_totals_v1(false);\nselect set_config('odontoart.maintenance048.expected','off',true);\n"
fi
fi
cat <<'SQL'
do $post$
declare
  obj text;
  priv text;
begin
  if (select max(version) from public.schema_migrations) is distinct from 48
    or (select enabled from public.grouped_incremental_totals_state where singleton)
      is distinct from (current_setting('odontoart.maintenance048.expected')='on')
    or not coalesce((select enabled from public.batch_totals_shadow_state where singleton),false)
    or exists(select 1 from public.grouped_incremental_totals_pending)
    or exists(select 1 from public.grouped_batch_totals_pending)
    or exists(select 1 from public.batch_totals_shadow_dirty)
    or exists(select 1 from public.batch_totals_shadow_transactions) then
    raise exception '048 maintenance: state or pending work mismatch';
  end if;
  foreach obj in array array['public.grouped_incremental_totals_state','public.grouped_incremental_totals_pending'] loop
    foreach priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('odontoart_pix_app',obj,priv) then
        raise exception '048 maintenance: app has % on %',priv,obj;
      end if;
    end loop;
  end loop;
  if has_function_privilege('odontoart_pix_app','public.set_grouped_incremental_totals_v1(boolean)','EXECUTE')
    or has_function_privilege('odontoart_pix_app','public.project_grouped_incremental_totals_v1()','EXECUTE')
    or has_function_privilege('odontoart_pix_app','public.guard_grouped_incremental_shadow_state_v1()','EXECUTE')
    or not has_function_privilege('odontoart_pix_app','public.try_grouped_incremental_totals_v1()','EXECUTE')
    or not has_function_privilege('odontoart_pix_app','public.flush_grouped_batch_totals_v2()','EXECUTE')
    or not has_function_privilege('odontoart_pix_app','pg_catalog.pg_try_advisory_xact_lock(integer,integer)','EXECUTE') then
    raise exception '048 maintenance: unexpected runtime function grants';
  end if;
  if exists(select 1 from public.batch_totals_shadow_audit_v1 where official_differs or shadow_differs or orphan_batch)
    or exists(select 1 from public.batch_totals_shadow_link_audit_v1 where differs or orphan_contribution or missing_contribution) then
    raise exception '048 maintenance: postcondition audit differs';
  end if;
end;
$post$;
select '[048_MAINTENANCE_VERIFIED]' as result,
  (select enabled from public.grouped_incremental_totals_state where singleton) as pilot_enabled,
  (select enabled from public.batch_totals_shadow_state where singleton) as shadow_enabled;
SQL
