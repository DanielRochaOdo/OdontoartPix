import { randomUUID } from "node:crypto";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";
import {
  getGeneralSyncRun,
  type GeneralSyncRunDetail
} from "@/lib/general-sync-read";
import {
  resolveGeneralSyncScope,
  type GeneralSyncScopeInput
} from "@/lib/general-sync-preview";

type LocalGeneralSyncStartReason =
  | "GENERAL_SYNC_ALREADY_ACTIVE"
  | "REQUEST_ALREADY_CREATED";

export type LocalGeneralSyncStartResult =
  | {
      created: true;
      run: GeneralSyncRunDetail;
    }
  | {
      created: false;
      reason: LocalGeneralSyncStartReason;
      run: GeneralSyncRunDetail;
    };

const ACTIVE_RUN_STATUSES = ["queued", "running", "paused", "cancelling"];
const GENERAL_SYNC_LOCK_NAMESPACE = "odontoartpix";
const GENERAL_SYNC_LOCK_KEY = "general-sync-single-active";

type RunIdRow = { id: string };

async function findRunByRequestKey(
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
  requestKey: string
) {
  const result = await clientQuery<RunIdRow>(
    client,
    `select id
       from general_sync_runs
      where request_key = $1
      limit 1`,
    [requestKey]
  );

  return result.rows[0]?.id ?? null;
}

async function findActiveRunId(
  client: Parameters<Parameters<typeof withTransaction>[0]>[0]
) {
  const result = await clientQuery<RunIdRow>(
    client,
    `select id
       from general_sync_runs
      where status = any($1::text[])
      order by created_at desc
      limit 1`,
    [ACTIVE_RUN_STATUSES]
  );

  return result.rows[0]?.id ?? null;
}

export async function createLocalGeneralSyncRun(
  input: GeneralSyncScopeInput & {
    requestedBy: string;
    confirmationToken?: string | null;
  }
): Promise<LocalGeneralSyncStartResult> {
  const scope = await resolveGeneralSyncScope(input);
  if (scope.emptyReason) {
    throw new Error(scope.emptyReason);
  }

  const requestKey = input.confirmationToken?.trim() || randomUUID();

  try {
    const result = await withTransaction(async (client) => {
      await clientQuery(
        client,
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [GENERAL_SYNC_LOCK_NAMESPACE, GENERAL_SYNC_LOCK_KEY]
      );

      const existingRunId = await findRunByRequestKey(client, requestKey);
      if (existingRunId) {
        return {
          created: false as const,
          reason: "REQUEST_ALREADY_CREATED" as const,
          runId: existingRunId
        };
      }

      const activeRunId = await findActiveRunId(client);
      if (activeRunId) {
        return {
          created: false as const,
          reason: "GENERAL_SYNC_ALREADY_ACTIVE" as const,
          runId: activeRunId
        };
      }

      const insertedRun = await clientQuery<RunIdRow>(
        client,
        `insert into general_sync_runs (
           request_key,
           requested_by,
           scope_type,
           filters,
           status,
           trigger_source,
           sync_mode,
           campaign_count,
           batch_count,
           record_count
         ) values (
           $1,
           $2::uuid,
           $3,
           $4::jsonb,
           'queued',
           'manual',
           'full_sync',
           $5,
           $6,
           $7
         )
         returning id`,
        [
          requestKey,
          input.requestedBy,
          scope.scopeType,
          JSON.stringify(scope.filters),
          scope.campaignCount,
          scope.batchCount,
          scope.recordCount
        ]
      );

      const runId = insertedRun.rows[0]?.id;
      if (!runId) {
        throw new Error("A sincronizacao geral local nao retornou um identificador.");
      }

      const batchPayload = scope.batches.map((batch) => ({
        batch_id: batch.batchId,
        campaign_id: batch.campaignId,
        batch_name: batch.batchName,
        campaign_name: batch.campaignName,
        position: batch.position,
        record_count: batch.recordCount
      }));

      await clientQuery(
        client,
        `insert into general_sync_run_batches (
           run_id,
           batch_id,
           campaign_id,
           batch_name,
           campaign_name,
           position,
           record_count,
           status
         )
         select
           $1::uuid,
           item.batch_id,
           item.campaign_id,
           item.batch_name,
           item.campaign_name,
           item.position,
           greatest(coalesce(item.record_count, 0), 0),
           case
             when greatest(coalesce(item.record_count, 0), 0) = 0 then 'completed'
             else 'pending'
           end
         from jsonb_to_recordset($2::jsonb) as item(
           batch_id uuid,
           campaign_id uuid,
           batch_name text,
           campaign_name text,
           position integer,
           record_count integer
         )`,
        [runId, JSON.stringify(batchPayload)]
      );

      await clientQuery(
        client,
        `insert into event_logs (
           event_type,
           category,
           severity,
           details,
           created_by
         ) values (
           $1,
           $2,
           $3,
           $4::jsonb,
           $5::uuid
         )`,
        [
          "dashboard_general_sync_started",
          "processing",
          "info",
          JSON.stringify({
            runId,
            scopeType: scope.scopeType,
            campaignIds: scope.filters.campaignIds,
            batchIds: scope.filters.batchIds,
            campaignCount: scope.campaignCount,
            batchCount: scope.batchCount,
            recordCount: scope.recordCount
          }),
          input.requestedBy
        ]
      );

      return {
        created: true as const,
        runId
      };
    });

    const run = await getGeneralSyncRun(result.runId);

    if (result.created) {
      return { created: true, run };
    }

    return {
      created: false,
      reason: result.reason,
      run
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === "Campanhas invalidas ou indisponiveis no escopo informado." ||
        error.message === "Lotes invalidos ou indisponiveis no escopo informado." ||
        error.message === "Nenhum registro elegivel foi encontrado para o escopo selecionado."
      )
    ) {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel criar a sincronizacao geral local.",
      "generalSyncStart.create",
      error
    );
  }
}
