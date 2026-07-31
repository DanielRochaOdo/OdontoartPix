import { z } from "zod";
import { parseMemberFile } from "@/lib/imports";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashAssociatedCode } from "@/lib/hash";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { logIgnoredImportEvents } from "@/lib/event-logs";

export const runtime = "nodejs";

const FormSchema = z.object({
  name: z.string().trim().optional().default(""),
  batchName: z.string().trim().optional().default(""),
  description: z.string().optional().default("")
});
const OptionalIdSchema = z.string().uuid().optional();

type ImportedMember = {
  cpf: string;
  cpf_hash: string;
  name: string | null;
  external_user_code: string;
};

function buildLegacyMemberCode(associatedCode: string) {
  return `codigo:${associatedCode}`;
}

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const payload = FormSchema.safeParse({
    name: form.get("name") ?? "",
    batchName: form.get("batchName") ?? "",
    description: form.get("description") ?? ""
  });
  const campaignId = OptionalIdSchema.safeParse(form.get("campaignId"));
  const batchId = OptionalIdSchema.safeParse(form.get("batchId"));
  const file = form.get("file");

  if (!payload.success) {
    return fail("VALIDATION_ERROR", "Informe um nome valido para a campanha.", 400);
  }
  if (!(file instanceof File)) {
    return fail("VALIDATION_ERROR", "Arquivo obrigatorio.", 400);
  }

  if ((!campaignId.success || !campaignId.data) && !payload.data.name) {
    return fail("VALIDATION_ERROR", "Informe um nome valido para a campanha.", 400);
  }

  const { imports, issues, inspectedRows } = await parseMemberFile(file);
  if (imports.length === 0) {
    return fail(
      "VALIDATION_ERROR",
      "O arquivo nao possui nenhum CodigoAssociadoEmpresa valido para importacao.",
      400
    );
  }

  const supabase = createSupabaseAdminClient();
  let campaign: { id: string; name?: string } | null = null;
  let batch: { id: string; campaign_id?: string; name?: string } | null = null;
  let createdCampaign = false;
  let createdBatch = false;
  let failedOperation = "initialization";

  async function cleanupCreatedResources() {
    if (createdCampaign && campaign) {
      await supabase.from("campaigns").delete().eq("id", campaign.id);
      return;
    }
    if (createdBatch && batch) {
      await supabase.from("campaign_batches").delete().eq("id", batch.id);
    }
  }

  try {
    if (campaignId.success && campaignId.data) {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id,name")
        .eq("id", campaignId.data)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return fail("NOT_FOUND", "Campanha nao encontrada.", 404);
      campaign = data;
    } else {
      failedOperation = "campaign_batches.insert";
      const { data, error } = await supabase
        .from("campaigns")
        .insert({
          name: payload.data.name,
          description: payload.data.description.trim(),
          status: "aguardando",
          created_by: auth.profile.id
        })
        .select("id,name")
        .single();
      if (error || !data) throw error ?? new Error("Campanha nao criada.");
      campaign = data;
      createdCampaign = true;
    }

    if (!campaign) throw new Error("Campanha nao disponivel apos a criacao.");
    const campaignRecord = campaign;

    if (batchId.success && batchId.data) {
      const { data, error } = await supabase
        .from("campaign_batches")
        .select("id,campaign_id,name")
        .eq("id", batchId.data)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return fail("NOT_FOUND", "Lote nao encontrado.", 404);
      if (data.campaign_id !== campaignRecord.id) {
        return fail("CONFLICT", "O lote nao pertence a campanha informada.", 409);
      }
      batch = data;
    } else {
      const { data, error } = await supabase
        .from("campaign_batches")
        .insert({
          campaign_id: campaignRecord.id,
          name: payload.data.batchName || `${campaignRecord.name ?? payload.data.name} - Lote 1`,
          description: payload.data.description.trim(),
          status: "aguardando",
          total_records: 0,
          processed_records: 0,
          paid_records: 0,
          unpaid_records: 0,
          error_records: 0,
          total_pending_amount_cents: 0,
          created_by: auth.profile.id
        })
        .select("id,campaign_id,name")
        .single();
      if (error || !data) throw error ?? new Error("Lote nao criado.");
      batch = data;
      createdBatch = true;
    }

    if (!batch) throw new Error("Lote nao disponivel apos a criacao.");
    const batchRecord = batch;
    const inspectedRowsByLine = new Map(inspectedRows.map((row) => [row.line, row]));

    const uniqueMembers = new Map<string, ImportedMember>();
    for (const item of imports) {
      if (!uniqueMembers.has(item.associatedCode)) {
        uniqueMembers.set(item.associatedCode, {
          cpf: item.cpf ?? buildLegacyMemberCode(item.associatedCode),
          cpf_hash: hashAssociatedCode(item.associatedCode),
          name: item.name ?? null,
          external_user_code: item.associatedCode
        });
      }
    }

    const membersUpsert = [...uniqueMembers.values()];
    failedOperation = "members.lookup";
    const storedMembers: Array<{ id: string; external_user_code: string | null; cpf_hash: string | null }> = [];
    const associatedCodes = membersUpsert.map((item) => item.external_user_code);
    const lookupChunkSize = 200;

    for (let index = 0; index < associatedCodes.length; index += lookupChunkSize) {
      const { data: chunk, error: lookupError } = await supabase
        .from("members")
        .select("id,external_user_code,cpf_hash")
        .in("external_user_code", associatedCodes.slice(index, index + lookupChunkSize));
      if (lookupError) throw lookupError;
      storedMembers.push(...(chunk ?? []));
    }

    const existingByAssociatedCode = new Map(
      storedMembers
        .filter((item) => item.external_user_code)
        .map((item) => [String(item.external_user_code), item.id])
    );

    const missingMembers = membersUpsert.filter(
      (item) => !existingByAssociatedCode.has(item.external_user_code)
    );

    if (missingMembers.length > 0) {
      failedOperation = "members.insert";
      const { error: insertMembersError } = await supabase
        .from("members")
        .insert(missingMembers);
      if (insertMembersError) throw insertMembersError;

      for (let index = 0; index < associatedCodes.length; index += lookupChunkSize) {
        const { data: chunk, error: lookupError } = await supabase
          .from("members")
          .select("id,external_user_code")
          .in("external_user_code", associatedCodes.slice(index, index + lookupChunkSize));
        if (lookupError) throw lookupError;
        for (const item of chunk ?? []) {
          if (item.external_user_code) {
            existingByAssociatedCode.set(String(item.external_user_code), item.id);
          }
        }
      }
    }

    const duplicateInstallmentIssues = [...issues];
    const targetInstallmentIds = [...new Set(imports.map((item) => item.targetInstallmentId))];
    const existingCampaignByInstallmentId = new Map<string, string>();
    for (let index = 0; index < targetInstallmentIds.length; index += lookupChunkSize) {
      const { data: existingLinks, error: existingLinksError } = await supabase
        .from("campaign_batch_members")
        .select("target_installment_id,campaign:campaigns(name)")
        .in("target_installment_id", targetInstallmentIds.slice(index, index + lookupChunkSize))
        .is("deleted_at", null);
      if (existingLinksError) throw existingLinksError;
      for (const link of existingLinks ?? []) {
        const installmentId = String(link.target_installment_id ?? "").trim();
        if (!installmentId || existingCampaignByInstallmentId.has(installmentId)) continue;
        const campaignRelation = Array.isArray(link.campaign) ? link.campaign[0] : link.campaign;
        const blockingCampaignName = campaignRelation?.name
          ? String(campaignRelation.name)
          : "Campanha nao identificada";
        existingCampaignByInstallmentId.set(installmentId, blockingCampaignName);
      }
    }

    const rowsToImport = imports.filter((item) => {
      const blockingCampaignName = existingCampaignByInstallmentId.get(item.targetInstallmentId);
      if (blockingCampaignName) {
        duplicateInstallmentIssues.push({
          line: item.line,
          associatedCode: item.associatedCode,
          targetInstallmentId: item.targetInstallmentId,
          installmentAmountCents: item.installmentAmountCents,
          cpf: item.cpf,
          name: item.name,
          reason: `Parcela ja vinculada a campanha "${blockingCampaignName}".`
        });
        return false;
      }

      const memberId = existingByAssociatedCode.get(item.associatedCode);
      return Boolean(memberId);
    });

    const skippedDuplicateRecords = imports.length - rowsToImport.length;
    const linksPayload = rowsToImport.map((item) => {
      const memberId = existingByAssociatedCode.get(item.associatedCode);
      if (!memberId) throw new Error("Associado importado nao foi localizado.");
      return {
        campaign_id: campaignRecord.id,
        batch_id: batchRecord.id,
        member_id: memberId,
        target_installment_id: item.targetInstallmentId,
        installment_amount_cents: item.installmentAmountCents,
        processing_status: "pending",
        payment_status: null,
        total_pending_amount_cents: 0,
        installments_count: 0,
        processing_attempts: 0,
        last_error: null,
        deleted_at: null
      };
    });

    const eventIssues = duplicateInstallmentIssues.map((issue) => {
      const inspected = inspectedRowsByLine.get(issue.line);
      return {
        line: issue.line,
        associatedCode: issue.associatedCode ?? inspected?.associatedCode,
        targetInstallmentId: issue.targetInstallmentId ?? inspected?.targetInstallmentId,
        installmentAmountCents: issue.installmentAmountCents ?? inspected?.installmentAmountCents ?? null,
        cpf: issue.cpf ?? inspected?.cpf,
        name: issue.name ?? inspected?.name,
        reason: issue.reason
      };
    });

    await logIgnoredImportEvents({
      campaignId: campaignRecord.id,
      campaignName: campaignRecord.name ?? payload.data.name,
      batchId: batchRecord.id,
      batchName: batchRecord.name ?? payload.data.batchName ?? null,
      createdBy: auth.profile.id,
      issues: eventIssues
    });

    if (linksPayload.length === 0) {
      if (createdBatch) await supabase.from("campaign_batches").delete().eq("id", batchRecord.id);
      return ok(
        {
          campaignId: campaignRecord.id,
          batchId: null,
          summary: {
            total_lines: imports.length + issues.length,
            valid_records: imports.length,
            invalid_records: duplicateInstallmentIssues.length,
            duplicated_records: imports.length - membersUpsert.length,
            skipped_duplicate_records: skippedDuplicateRecords,
            imported_records: 0,
            issues: duplicateInstallmentIssues
          }
        },
        "Todas as parcelas informadas ja estao vinculadas a outras campanhas."
      );
    }

    failedOperation = "campaign_batch_members.upsert";
    const { error: linkError } = await supabase
      .from("campaign_batch_members")
      .upsert(linksPayload, { onConflict: "batch_id,member_id,target_installment_id" });
    if (linkError) throw linkError;

    failedOperation = "campaign_batches.update";
    const { error: batchUpdateError } = await supabase
      .from("campaign_batches")
      .update({
        status: "aguardando",
        total_records: linksPayload.length,
        processed_records: 0,
        paid_records: 0,
        unpaid_records: 0,
        error_records: 0,
        total_pending_amount_cents: 0
      })
      .eq("id", batchRecord.id);
    if (batchUpdateError) throw batchUpdateError;

    failedOperation = "campaigns.update";
    const { error: campaignUpdateError } = await supabase
      .from("campaigns")
      .update({ status: "aguardando" })
      .eq("id", campaignRecord.id);
    if (campaignUpdateError) throw campaignUpdateError;

    return ok(
      {
        campaignId: campaignRecord.id,
        batchId: batchRecord.id,
        summary: {
          total_lines: imports.length + issues.length,
          valid_records: imports.length,
          invalid_records: duplicateInstallmentIssues.length,
          duplicated_records: imports.length - membersUpsert.length,
          skipped_duplicate_records: skippedDuplicateRecords,
          imported_records: linksPayload.length,
          issues: duplicateInstallmentIssues
        },
        processing: {
          status: "aguardando",
          jobsCreated: 0
        }
      },
      "A base foi importada e esta aguardando o processamento."
    );
  } catch (error) {
    const databaseError = error as {
      code?: string;
      message?: string;
      details?: string | null;
      hint?: string | null;
    };
    await cleanupCreatedResources();
    console.error("[CAMPAIGN_IMPORT_FAILED]", {
      campaignId: campaign?.id ?? null,
      batchId: batch?.id ?? null,
      operation: failedOperation,
      code: databaseError.code ?? null,
      message:
        error instanceof Error
          ? error.message
          : databaseError.message ?? "Erro desconhecido",
      details: databaseError.details ?? null,
      hint: databaseError.hint ?? null,
      errorProperties:
        error instanceof Error
          ? Object.fromEntries(
              Object.getOwnPropertyNames(error).map((key) => [key, (error as unknown as Record<string, unknown>)[key]])
            )
          : null,
      serializedError: (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return null;
        }
      })()
    });

    const errorMessage =
      databaseError.message?.includes("members_external_user_code")
        ? "O banco ainda nao possui a estrutura nova para CodigoAssociadoEmpresa."
        : databaseError.message?.includes("null value in column")
          ? "O banco ainda esta com colunas obrigatorias do fluxo antigo. Aplique as migrations pendentes."
          : "Nao foi possivel concluir a importacao.";

    return fail("DATABASE_ERROR", errorMessage, 500);
  }
}
