import { z } from "zod";
import { parseMemberFile } from "@/lib/imports";
import { hashAssociatedCode } from "@/lib/hash";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { logIgnoredImportEvents } from "@/lib/event-logs";
import { clientQuery, withTransaction } from "@/lib/db/transaction";

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

type CampaignRow = {
  id: string;
  name: string;
};

type BatchRow = {
  id: string;
  campaign_id: string;
  name: string;
};

type MemberRow = {
  id: string;
  external_user_code: string | null;
};

type ImportHttpCode = "NOT_FOUND" | "CONFLICT";

class ImportHttpError extends Error {
  constructor(
    readonly code: ImportHttpCode,
    message: string,
    readonly status: 404 | 409
  ) {
    super(message);
  }
}

function buildLegacyMemberCode(associatedCode: string) {
  return `codigo:${associatedCode}`;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
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

  try {
    const result = await withTransaction(async (client) => {
      let campaign: CampaignRow;
      let batch: BatchRow;
      let createdCampaign = false;
      let createdBatch = false;

      if (campaignId.success && campaignId.data) {
        const campaignResult = await clientQuery<CampaignRow>(
          client,
          `select id, name
             from campaigns
            where id = $1
              and deleted_at is null
            limit 1`,
          [campaignId.data]
        );
        if (!campaignResult.rows[0]) {
          throw new ImportHttpError("NOT_FOUND", "Campanha nao encontrada.", 404);
        }
        campaign = campaignResult.rows[0];
      } else {
        const campaignResult = await clientQuery<CampaignRow>(
          client,
          `insert into campaigns(name, description, status, created_by)
           values ($1, $2, 'aguardando', $3)
           returning id, name`,
          [payload.data.name, payload.data.description.trim(), auth.profile.id]
        );
        campaign = campaignResult.rows[0];
        createdCampaign = true;
      }

      if (batchId.success && batchId.data) {
        const batchResult = await clientQuery<BatchRow>(
          client,
          `select id, campaign_id, name
             from campaign_batches
            where id = $1
              and deleted_at is null
            limit 1`,
          [batchId.data]
        );
        if (!batchResult.rows[0]) {
          throw new ImportHttpError("NOT_FOUND", "Lote nao encontrado.", 404);
        }
        if (batchResult.rows[0].campaign_id !== campaign.id) {
          throw new ImportHttpError("CONFLICT", "O lote nao pertence a campanha informada.", 409);
        }
        batch = batchResult.rows[0];
      } else {
        const batchResult = await clientQuery<BatchRow>(
          client,
          `insert into campaign_batches(
             campaign_id, name, description, status,
             total_records, processed_records, paid_records, unpaid_records,
             error_records, total_pending_amount_cents, total_amount_cents, created_by
           )
           values ($1, $2, $3, 'aguardando', 0, 0, 0, 0, 0, 0, 0, $4)
           returning id, campaign_id, name`,
          [
            campaign.id,
            payload.data.batchName || `${campaign.name} - Lote 1`,
            payload.data.description.trim(),
            auth.profile.id
          ]
        );
        batch = batchResult.rows[0];
        createdBatch = true;
      }

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
      const associatedCodes = membersUpsert.map((item) => item.external_user_code);
      const existingByAssociatedCode = new Map<string, string>();

      for (const codeChunk of chunks(associatedCodes, 500)) {
        const stored = await clientQuery<MemberRow>(
          client,
          `select id, external_user_code
             from members
            where external_user_code = any($1::text[])
              and deleted_at is null`,
          [codeChunk]
        );
        for (const member of stored.rows) {
          if (member.external_user_code) {
            existingByAssociatedCode.set(member.external_user_code, member.id);
          }
        }
      }

      const missingMembers = membersUpsert.filter(
        (item) => !existingByAssociatedCode.has(item.external_user_code)
      );

      for (const memberChunk of chunks(missingMembers, 500)) {
        if (memberChunk.length === 0) continue;
        await clientQuery(
          client,
          `insert into members(cpf, cpf_hash, name, external_user_code)
           select *
             from unnest($1::text[], $2::text[], $3::text[], $4::text[])
                  as incoming(cpf, cpf_hash, name, external_user_code)
           on conflict do nothing`,
          [
            memberChunk.map((item) => item.cpf),
            memberChunk.map((item) => item.cpf_hash),
            memberChunk.map((item) => item.name),
            memberChunk.map((item) => item.external_user_code)
          ]
        );
      }

      for (const codeChunk of chunks(associatedCodes, 500)) {
        const stored = await clientQuery<MemberRow>(
          client,
          `select id, external_user_code
             from members
            where external_user_code = any($1::text[])
              and deleted_at is null`,
          [codeChunk]
        );
        for (const member of stored.rows) {
          if (member.external_user_code) {
            existingByAssociatedCode.set(member.external_user_code, member.id);
          }
        }
      }

      const duplicateInstallmentIssues = [...issues];
      const targetInstallmentIds = [...new Set(imports.map((item) => item.targetInstallmentId))];
      const existingCampaignByInstallmentId = new Map<string, string>();

      for (const installmentChunk of chunks(targetInstallmentIds, 500)) {
        const existing = await clientQuery<{ target_installment_id: string | null; campaign_name: string }>(
          client,
          `select cbm.target_installment_id, c.name as campaign_name
             from campaign_batch_members cbm
             join campaigns c on c.id = cbm.campaign_id
            where cbm.target_installment_id = any($1::text[])
              and cbm.deleted_at is null
              and c.deleted_at is null`,
          [installmentChunk]
        );
        for (const link of existing.rows) {
          const installmentId = String(link.target_installment_id ?? "").trim();
          if (installmentId && !existingCampaignByInstallmentId.has(installmentId)) {
            existingCampaignByInstallmentId.set(installmentId, link.campaign_name);
          }
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
        return existingByAssociatedCode.has(item.associatedCode);
      });

      const uniqueLinks = new Map<string, (typeof rowsToImport)[number]>();
      for (const item of rowsToImport) {
        const memberId = existingByAssociatedCode.get(item.associatedCode);
        if (!memberId) continue;
        uniqueLinks.set(`${batch.id}:${memberId}:${item.targetInstallmentId}`, item);
      }

      const linksPayload = [...uniqueLinks.values()].map((item) => {
        const memberId = existingByAssociatedCode.get(item.associatedCode);
        if (!memberId) throw new Error("Associado importado nao foi localizado.");
        return {
          memberId,
          targetInstallmentId: item.targetInstallmentId,
          installmentAmountCents: item.installmentAmountCents,
          dueDateText: item.dueDate ?? null
        };
      });

      const skippedDuplicateRecords = imports.length - rowsToImport.length;
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

      if (linksPayload.length === 0) {
        if (createdBatch) {
          await clientQuery(client, "delete from campaign_batches where id = $1", [batch.id]);
        }
        if (createdCampaign) {
          await clientQuery(client, "delete from campaigns where id = $1", [campaign.id]);
        }

        return {
          response: {
            campaignId: createdCampaign ? null : campaign.id,
            batchId: null,
            summary: {
              total_lines: imports.length + issues.length,
              valid_records: imports.length,
              invalid_records: duplicateInstallmentIssues.length,
              duplicated_records: imports.length - membersUpsert.length,
              skipped_duplicate_records: skippedDuplicateRecords,
              imported_records: 0,
              issues: eventIssues
            },
            processing: { status: "aguardando", jobsCreated: 0 }
          },
          message: "Todas as parcelas informadas ja estao vinculadas a outras campanhas.",
          logContext: {
            campaignId: campaign.id,
            campaignName: campaign.name,
            batchId: batch.id,
            batchName: batch.name,
            issues: eventIssues
          }
        };
      }

      for (const linkChunk of chunks(linksPayload, 500)) {
        await clientQuery(
          client,
          `insert into campaign_batch_members(
             campaign_id, batch_id, member_id, target_installment_id,
             installment_amount_cents, due_date_text, processing_status,
             payment_status, total_pending_amount_cents, installments_count,
             processing_attempts, last_error, deleted_at
           )
           select $1::uuid, $2::uuid,
                  incoming.member_id, incoming.target_installment_id,
                  incoming.installment_amount_cents, incoming.due_date_text,
                  'pending', null, 0, 0, 0, null, null
             from unnest($3::uuid[], $4::text[], $5::bigint[], $6::text[])
                  as incoming(member_id, target_installment_id, installment_amount_cents, due_date_text)
           on conflict (batch_id, member_id, target_installment_id)
           do update set
             installment_amount_cents = excluded.installment_amount_cents,
             due_date_text = excluded.due_date_text,
             processing_status = 'pending',
             payment_status = null,
             total_pending_amount_cents = 0,
             installments_count = 0,
             processing_attempts = 0,
             last_error = null,
             deleted_at = null,
             updated_at = now()`,
          [
            campaign.id,
            batch.id,
            linkChunk.map((item) => item.memberId),
            linkChunk.map((item) => item.targetInstallmentId),
            linkChunk.map((item) => item.installmentAmountCents),
            linkChunk.map((item) => item.dueDateText)
          ]
        );
      }

      const totalAmountCents = linksPayload.reduce(
        (sum, item) => sum + Number(item.installmentAmountCents || 0),
        0
      );

      await clientQuery(
        client,
        `update campaign_batches
            set status = 'aguardando',
                total_records = $2,
                processed_records = 0,
                paid_records = 0,
                unpaid_records = 0,
                error_records = 0,
                total_pending_amount_cents = 0,
                total_amount_cents = $3,
                updated_at = now()
          where id = $1`,
        [batch.id, linksPayload.length, totalAmountCents]
      );

      await clientQuery(
        client,
        `update campaigns
            set status = 'aguardando', updated_at = now()
          where id = $1`,
        [campaign.id]
      );

      return {
        response: {
          campaignId: campaign.id,
          batchId: batch.id,
          summary: {
            total_lines: imports.length + issues.length,
            valid_records: imports.length,
            invalid_records: duplicateInstallmentIssues.length,
            duplicated_records: imports.length - membersUpsert.length,
            skipped_duplicate_records: skippedDuplicateRecords,
            imported_records: linksPayload.length,
            issues: eventIssues
          },
          processing: { status: "aguardando", jobsCreated: 0 }
        },
        message: "A base foi importada e esta aguardando o processamento.",
        logContext: {
          campaignId: campaign.id,
          campaignName: campaign.name,
          batchId: batch.id,
          batchName: batch.name,
          issues: eventIssues
        }
      };
    });

    await logIgnoredImportEvents({
      campaignId: result.logContext.campaignId,
      campaignName: result.logContext.campaignName,
      batchId: result.logContext.batchId,
      batchName: result.logContext.batchName,
      createdBy: auth.profile.id,
      issues: result.logContext.issues
    });

    return ok(result.response, result.message);
  } catch (error) {
    if (error instanceof ImportHttpError) {
      return fail(error.code, error.message, error.status);
    }

    const databaseError = error as {
      code?: string;
      message?: string;
      detail?: string | null;
      constraint?: string | null;
    };

    console.error("[CAMPAIGN_IMPORT_FAILED]", {
      code: databaseError.code ?? null,
      message: error instanceof Error ? error.message : databaseError.message ?? "Erro desconhecido",
      detail: databaseError.detail ?? null,
      constraint: databaseError.constraint ?? null
    });

    return fail("DATABASE_ERROR", "Nao foi possivel concluir a importacao.", 500);
  }
}
