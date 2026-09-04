import { randomUUID } from "node:crypto";
import { getCurrentProfile } from "@/lib/auth";
import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

type GeneralSyncScopeType = "all" | "filtered";

export type GeneralSyncScopeInput = {
  campaignIds?: string[];
  batchIds?: string[];
};

type ScopeBatch = {
  batchId: string;
  campaignId: string;
  batchName: string;
  campaignName: string | null;
  createdAt: string;
  recordCount: number;
  position: number;
};

export type GeneralSyncScopeResolution = {
  scopeType: GeneralSyncScopeType;
  filters: {
    campaignIds: string[];
    batchIds: string[];
  };
  campaignCount: number;
  batchCount: number;
  recordCount: number;
  activeProcessingCount: number;
  batches: ScopeBatch[];
  oldestBatch: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  newestBatch: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  emptyReason: string | null;
};

export type GeneralSyncPreview = Omit<GeneralSyncScopeResolution, "filters" | "batches"> & {
  confirmationToken: string;
};

const ACTIVE_BATCH_JOB_STATUSES = ["queued", "running", "paused"];
const GENERAL_SYNC_TERMINAL_PAYMENT_STATUSES = ["paid", "agreed", "excluded"];

function uniqueIds(values?: string[]) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

async function getValidatedCampaignIds(campaignIds: string[]) {
  if (campaignIds.length === 0) return [];

  try {
    const result = await dbQuery<{ id: string }>(
      `select id
         from campaigns
        where deleted_at is null
          and id = any($1::uuid[])`,
      [campaignIds]
    );

    const foundIds = new Set(result.rows.map((item) => item.id));
    const invalidIds = campaignIds.filter((id) => !foundIds.has(id));
    if (invalidIds.length > 0) {
      throw new Error("Campanhas invalidas ou indisponiveis no escopo informado.");
    }

    return campaignIds;
  } catch (error) {
    if (error instanceof Error && error.message === "Campanhas invalidas ou indisponiveis no escopo informado.") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel validar as campanhas.",
      "generalSyncPreview.validateCampaigns",
      error
    );
  }
}

async function getValidatedBatchIds(batchIds: string[]) {
  if (batchIds.length === 0) return [];

  try {
    const result = await dbQuery<{ id: string }>(
      `select id
         from campaign_batches
        where deleted_at is null
          and id = any($1::uuid[])`,
      [batchIds]
    );

    const foundIds = new Set(result.rows.map((item) => item.id));
    const invalidIds = batchIds.filter((id) => !foundIds.has(id));
    if (invalidIds.length > 0) {
      throw new Error("Lotes invalidos ou indisponiveis no escopo informado.");
    }

    return batchIds;
  } catch (error) {
    if (error instanceof Error && error.message === "Lotes invalidos ou indisponiveis no escopo informado.") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel validar os lotes.",
      "generalSyncPreview.validateBatches",
      error
    );
  }
}

async function loadScopedBatches(filters: { campaignIds: string[]; batchIds: string[] }) {
  try {
    const batchesResult = await dbQuery<{
      id: string;
      campaign_id: string;
      name: string;
      created_at: Date;
    }>(
      `select id, campaign_id, name, created_at
         from campaign_batches
        where deleted_at is null
          and (cardinality($1::uuid[]) = 0 or id = any($1::uuid[]))
          and (cardinality($2::uuid[]) = 0 or campaign_id = any($2::uuid[]))
        order by created_at asc, id asc`,
      [filters.batchIds, filters.campaignIds]
    );

    if (batchesResult.rows.length === 0) return [];

    const campaignIds = [...new Set(batchesResult.rows.map((batch) => batch.campaign_id))];
    const campaignsResult = await dbQuery<{ id: string; name: string }>(
      `select id, name
         from campaigns
        where deleted_at is null
          and id = any($1::uuid[])`,
      [campaignIds]
    );

    const campaignNameById = new Map(campaignsResult.rows.map((campaign) => [campaign.id, campaign.name]));
    const batchIds = batchesResult.rows.map((batch) => batch.id);
    const countsResult = await dbQuery<{ batch_id: string; record_count: number }>(
      `select batch_id, count(*)::int as record_count
         from campaign_batch_members
        where deleted_at is null
          and (payment_status is null or payment_status <> all($2::text[]))
          and batch_id = any($1::uuid[])
        group by batch_id`,
      [batchIds, GENERAL_SYNC_TERMINAL_PAYMENT_STATUSES]
    );

    const recordCountByBatchId = new Map(
      countsResult.rows.map((row) => [row.batch_id, Number(row.record_count)])
    );

    return batchesResult.rows.map((batch, index): ScopeBatch => ({
      batchId: batch.id,
      campaignId: batch.campaign_id,
      batchName: batch.name,
      campaignName: campaignNameById.get(batch.campaign_id) ?? null,
      createdAt: batch.created_at.toISOString(),
      recordCount: recordCountByBatchId.get(batch.id) ?? 0,
      position: index + 1
    }));
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os lotes do escopo.",
      "generalSyncPreview.loadBatches",
      error
    );
  }
}

async function countActiveProcessingForScope(batchIds: string[]) {
  if (batchIds.length === 0) return 0;

  try {
    const result = await dbQuery<{ count: number }>(
      `select count(*)::int as count
         from processing_jobs
        where batch_id = any($1::uuid[])
          and status = any($2::text[])`,
      [batchIds, ACTIVE_BATCH_JOB_STATUSES]
    );

    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel contar os processamentos ativos no escopo.",
      "generalSyncPreview.countActiveProcessing",
      error
    );
  }
}

export async function resolveGeneralSyncScope(
  input: GeneralSyncScopeInput
): Promise<GeneralSyncScopeResolution> {
  const campaignIds = uniqueIds(input.campaignIds);
  const batchIds = uniqueIds(input.batchIds);

  await getValidatedCampaignIds(campaignIds);
  await getValidatedBatchIds(batchIds);

  const scopeType: GeneralSyncScopeType =
    campaignIds.length === 0 && batchIds.length === 0 ? "all" : "filtered";
  const batches = await loadScopedBatches({ campaignIds, batchIds });
  const campaignCount = new Set(batches.map((batch) => batch.campaignId)).size;
  const batchCount = batches.length;
  const recordCount = batches.reduce((total, batch) => total + batch.recordCount, 0);
  const activeProcessingCount = await countActiveProcessingForScope(batches.map((batch) => batch.batchId));

  return {
    scopeType,
    filters: { campaignIds, batchIds },
    campaignCount,
    batchCount,
    recordCount,
    activeProcessingCount,
    batches,
    oldestBatch: batches.length
      ? {
          id: batches[0].batchId,
          name: batches[0].batchName,
          createdAt: batches[0].createdAt
        }
      : null,
    newestBatch: batches.length
      ? {
          id: batches[batches.length - 1].batchId,
          name: batches[batches.length - 1].batchName,
          createdAt: batches[batches.length - 1].createdAt
        }
      : null,
    emptyReason:
      batches.length === 0
        ? "Nenhum registro elegivel foi encontrado para o escopo selecionado."
        : null
  };
}

async function logPreviewEvent(scope: GeneralSyncScopeResolution) {
  const profile = await getCurrentProfile();
  if (!profile?.id) return;

  try {
    await dbQuery(
      `insert into event_logs (
         event_type,
         category,
         severity,
         reason,
         details,
         created_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        "dashboard_general_sync_previewed",
        "processing",
        "info",
        scope.emptyReason,
        JSON.stringify({
          runId: "preview",
          scopeType: scope.scopeType,
          campaignIds: scope.filters.campaignIds,
          batchIds: scope.filters.batchIds,
          campaignCount: scope.campaignCount,
          batchCount: scope.batchCount,
          recordCount: scope.recordCount,
          activeProcessingCount: scope.activeProcessingCount
        }),
        profile.id
      ]
    );
  } catch (error) {
    console.error("[GENERAL_SYNC_EVENT_LOG_FAILED]", {
      eventType: "dashboard_general_sync_previewed",
      runId: "preview",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
  }
}

export async function getGeneralSyncPreview(input: GeneralSyncScopeInput): Promise<GeneralSyncPreview> {
  const scope = await resolveGeneralSyncScope(input);
  await logPreviewEvent(scope);

  return {
    scopeType: scope.scopeType,
    campaignCount: scope.campaignCount,
    batchCount: scope.batchCount,
    recordCount: scope.recordCount,
    activeProcessingCount: scope.activeProcessingCount,
    oldestBatch: scope.oldestBatch,
    newestBatch: scope.newestBatch,
    emptyReason: scope.emptyReason,
    confirmationToken: randomUUID()
  };
}
