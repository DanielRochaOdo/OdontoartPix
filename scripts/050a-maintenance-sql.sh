#!/usr/bin/env bash
# Generate transactional DBA SQL. Does not connect to a database.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: $0 activate|disable" >&2; exit 2; }
case "$1" in activate|disable) ;; *) exit 2;; esac
mode="$1"
cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='120s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $gate$
BEGIN
  IF current_user='odontoart_pix_app' OR current_user<>session_user
     OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION '050-A: administrador obrigatorio';
  END IF;
  IF current_setting('server_version_num')::int/10000<>17
     OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION '050-A: PostgreSQL 17 e READ COMMITTED obrigatorios';
  END IF;
  IF NOT pg_try_advisory_xact_lock(17483621,20260821) THEN
    RAISE EXCEPTION '050-A: worker/delecao ativo';
  END IF;
  IF NOT pg_try_advisory_xact_lock(2026082401::bigint) THEN
    RAISE EXCEPTION '050-A: migracao ativa';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND usename='odontoart_pix_app' AND pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION '050-A: conexoes da aplicacao abertas';
  END IF;
END;
$gate$;
LOCK TABLE public.campaigns,public.campaign_batches,public.campaign_batch_members,
  public.member_target_installments,public.general_sync_runs,public.processing_jobs,
  public.schema_migrations,public.batch_totals_shadow_state,
  public.grouped_incremental_totals_state IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $gate$
BEGIN
  IF NOT pg_try_advisory_xact_lock(20261124047::bigint) THEN
    RAISE EXCEPTION '050-A: shadow ocupado';
  END IF;
  IF (SELECT max(version) FROM public.schema_migrations) IS DISTINCT FROM 48 THEN
    RAISE EXCEPTION '050-A: schema 48 obrigatorio';
  END IF;
  IF EXISTS(SELECT 1 FROM public.general_sync_runs WHERE status IN ('queued','running','paused','cancelling'))
     OR EXISTS(SELECT 1 FROM public.processing_jobs WHERE status IN ('queued','running','paused','deferred'))
     OR EXISTS(SELECT 1 FROM public.campaign_batch_members WHERE processing_status='processing') THEN
    RAISE EXCEPTION '050-A: processamento ativo ou pendente';
  END IF;
  IF NOT coalesce((SELECT enabled FROM public.batch_totals_shadow_state WHERE singleton),false)
     OR NOT coalesce((SELECT enabled FROM public.grouped_incremental_totals_state WHERE singleton),false)
     OR EXISTS(SELECT 1 FROM public.grouped_batch_totals_pending)
     OR EXISTS(SELECT 1 FROM public.grouped_incremental_totals_pending)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_dirty)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_transactions) THEN
    RAISE EXCEPTION '050-A: estado ou pendencias de totalizacao';
  END IF;
  IF EXISTS(SELECT 1 FROM public.batch_totals_shadow_audit_v1 WHERE official_differs OR shadow_differs OR orphan_batch)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_link_audit_v1 WHERE differs OR orphan_contribution OR missing_contribution) THEN
    RAISE EXCEPTION '050-A: auditoria financeira inicial divergente';
  END IF;
END;
$gate$;
SQL
# Emit via heredoc: SQL single quotes are literal, not shell quoting.
primary_pred="processing_status in ('pending','queued','aguardando')"
retry_pred="processing_status in ('retrying','error')"
index_sql() {
  local name="$1" table="$2" pred="$3"
  cat <<SQL
CREATE INDEX $name ON $table (batch_id,(coalesce(next_retry_at,next_check_at,updated_at,created_at)),created_at,id)
WHERE deleted_at IS NULL AND (payment_status IS NULL OR payment_status NOT IN ('paid','agreed','excluded'))
AND processing_attempts < max_attempts AND $pred;
SQL
}
if [[ "$mode" == activate ]]; then
cat <<'SQL'
DO $absent$
BEGIN
  IF to_regclass('public.campaign_batch_members_claim_primary_order_050a_idx') IS NOT NULL
     OR to_regclass('public.campaign_batch_members_claim_retry_order_050a_idx') IS NOT NULL THEN
    RAISE EXCEPTION '050-A: objeto preexistente; inspecionar antes de continuar';
  END IF;
END;
$absent$;
SQL
index_sql campaign_batch_members_claim_primary_order_050a_idx public.campaign_batch_members "$primary_pred"
index_sql campaign_batch_members_claim_retry_order_050a_idx public.campaign_batch_members "$retry_pred"
fi
# Independent literal reference DDL: do not reuse index_sql here.
# A generator/quoting bug must fail the signature guard, not validate itself.
cat <<'SQL'
CREATE TEMP TABLE bench050a_signature (LIKE public.campaign_batch_members) ON COMMIT DROP;
CREATE INDEX ref050a_primary ON pg_temp.bench050a_signature
  (batch_id,(coalesce(next_retry_at,next_check_at,updated_at,created_at)),created_at,id)
  WHERE deleted_at IS NULL
    AND (payment_status IS NULL OR payment_status NOT IN ('paid','agreed','excluded'))
    AND processing_attempts < max_attempts
    AND processing_status IN ('pending','queued','aguardando');
CREATE INDEX ref050a_retry ON pg_temp.bench050a_signature
  (batch_id,(coalesce(next_retry_at,next_check_at,updated_at,created_at)),created_at,id)
  WHERE deleted_at IS NULL
    AND (payment_status IS NULL OR payment_status NOT IN ('paid','agreed','excluded'))
    AND processing_attempts < max_attempts
    AND processing_status IN ('retrying','error');
DO $signature$
DECLARE
  pair record;
  actual oid;
  ref oid;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('campaign_batch_members_claim_primary_order_050a_idx','ref050a_primary'),
    ('campaign_batch_members_claim_retry_order_050a_idx','ref050a_retry')
  ) p(actual_name,ref_name) LOOP
    actual:=to_regclass('public.'||pair.actual_name);
    ref:=to_regclass('pg_temp.'||pair.ref_name);
    IF actual IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_index a JOIN pg_index r ON r.indexrelid=ref
      JOIN pg_class ac ON ac.oid=a.indexrelid
      JOIN pg_class rc ON rc.oid=r.indexrelid
      WHERE a.indexrelid=actual AND a.indrelid='public.campaign_batch_members'::regclass
        AND ac.relkind='i' AND ac.relam=rc.relam AND a.indisvalid AND a.indisready AND a.indislive
        AND NOT a.indisunique AND NOT a.indisprimary AND NOT a.indisexclusion
        AND NOT a.indisclustered AND NOT a.indisreplident
        AND a.indnkeyatts=r.indnkeyatts AND a.indnatts=r.indnatts
        AND a.indclass=r.indclass AND a.indcollation=r.indcollation AND a.indoption=r.indoption
        AND pg_get_expr(a.indpred,a.indrelid)=pg_get_expr(r.indpred,r.indrelid)
        AND NOT EXISTS(SELECT 1 FROM generate_series(1,a.indnatts::int) n
          WHERE pg_get_indexdef(actual,n,true) IS DISTINCT FROM pg_get_indexdef(ref,n,true))
        AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=actual)
    ) THEN
      RAISE EXCEPTION '050-A: assinatura invalida ou ausente: %',pair.actual_name;
    END IF;
  END LOOP;
END;
$signature$;
SQL
if [[ "$mode" == disable ]]; then
cat <<'SQL'
DROP INDEX public.campaign_batch_members_claim_primary_order_050a_idx;
DROP INDEX public.campaign_batch_members_claim_retry_order_050a_idx;
SQL
fi
cat <<'SQL'
DO $post$
BEGIN
  IF EXISTS(SELECT 1 FROM public.batch_totals_shadow_audit_v1 WHERE official_differs OR shadow_differs OR orphan_batch)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_link_audit_v1 WHERE differs OR orphan_contribution OR missing_contribution)
     OR EXISTS(SELECT 1 FROM public.grouped_batch_totals_pending)
     OR EXISTS(SELECT 1 FROM public.grouped_incremental_totals_pending)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_dirty)
     OR EXISTS(SELECT 1 FROM public.batch_totals_shadow_transactions)
     OR (SELECT max(version) FROM public.schema_migrations) IS DISTINCT FROM 48
     OR NOT coalesce((SELECT enabled FROM public.batch_totals_shadow_state WHERE singleton),false)
     OR NOT coalesce((SELECT enabled FROM public.grouped_incremental_totals_state WHERE singleton),false) THEN
    RAISE EXCEPTION '050-A: pos-condicao divergente';
  END IF;
END;
$post$;
COMMIT;
SQL
printf "SELECT '[050A_%s_OK]' AS resultado;\n" "$(tr '[:lower:]' '[:upper:]' <<< "$mode")"
