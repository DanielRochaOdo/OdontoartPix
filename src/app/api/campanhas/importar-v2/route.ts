import { z } from "zod";
import { parseMemberFile } from "@/lib/imports";
import { hashAssociatedCode } from "@/lib/hash";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { clientQuery, withTransaction } from "@/lib/db/transaction";

export const runtime = "nodejs";

const FormSchema = z.object({
  name: z.string().trim().optional().default(""),
  batchName: z.string().trim().optional().default(""),
  description: z.string().optional().default("")
});
const OptionalIdSchema = z.string().uuid().optional();

type CampaignRow = { id: string; name: string };
type BatchRow = { id: string; campaign_id: string; name: string };
type MemberRow = { id: string; external_user_code: string | null };
type ImportedMember = {
  cpf: string;
  cpf_hash: string;
  name: string | null;
  external_user_code: string;
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

function duplicateBatchMessage(name: string) {
  return `Ja existe um lote "${name}" nesta campanha. Selecione o lote existente ou informe outro nome.`;
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
  if (form.get("campaignId") && !campaignId.success) {
    return fail("VALIDATION_ERROR", "Campanha invalida.", 400);
  }
  if (form.get("batchId") && !batchId.success) {
    return fail("VALIDATION_ERROR", "Lote invalido.", 400);
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
        const selected = await clientQuery<CampaignRow>(
          client,
          `select id, name
             from campaigns
            where id = $1 and deleted_at is null
            limit 1`,
          [campaignId.data]
        );
        if (!selected.rows[0]) {
          throw new ImportHttpError("NOT_FOUND", "Campanha nao encontrada.", 404);
        }
        campaign = selected.rows[0];
      } else {
        const inserted = await clientQuery<CampaignRow>(
          client,
          `insert into campaigns(name, description, status, created_by)
           values ($1, $2, 'aguardando', $3)
           returning id, name`,
          [payload.data.name, payload.data.description.trim(), auth.profile.id]
        );
        campaign = inserted.rows[0];
        createdCampaign = true;
      }

      if (batchId.success && batchId.data) {
        const selected = await clientQuery<BatchRow>(
          client,
          `select id, campaign_id, name
             from campaign_batches
            where id = $1 and deleted_at is null
            limit 1`,
          [batchId.data]
        );
        if (!selected.rows[0]) {
          throw new ImportHttpError("NOT_FOUND", "Lote nao encontrado.", 404);
        }
        if (selected.rows[0].campaign_id !== campaign.id) {
          throw new ImportHttpError("CONFLICT", "O lote nao pertence a campanha informada.", 409);
        }
        batch = selected.rows[0];
      } else {
        const requestedBatchName = payload.data.batchName || `${campaign.name} - Lote 1`;

        await clientQuery(
          client,
          `select pg_advisory_xact_lock(20260903, hashtext($1))`,
          [campaign.id]
        );

        const duplicate = await clientQuery<{ id: string }>(
          client,
          `select id
             from campaign_batches
            where campaign_id = $1::uuid
              and deleted_at is null
              and lower(btrim(name)) = lower(btrim($2))
            limit 1`,
          [campaign.id, requestedBatchName]
        );
        if (duplicate.rows[0]) {
          throw new ImportHttpError("CONFLICT", duplicateBatchMessage(requestedBatchName), 409);
        }

        const inserted = await clientQuery<BatchRow>(
          client,
          `insert into campaign_batches(
             campaign_id, name, description, status,
             total_records, processed_records, paid_records, unpaid_records,
             error_records, total_pending_amount_cents, total_amount_cents, created_by
           ) values ($1, $2, $3, 'aguardando', 0, 0, 0, 0, 0, 0, 0, $4)
           returning id, campaign_id, name`,
          [
            campaign.id,
            requestedBatchName,
            payload.data.description.trim(),
            auth.profile.id
          ]
        );
        batch = inserted.rows[0];
        createdBatch = true;
      }

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

      const members = [...uniqueMembers.values()];
      const associatedCodes = members.map((item) => item.external_user_code);
      const memberIdByCode = new Map<string, string>();

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
          if (member.external_user_code) memberIdByCode.set(member.external_user_code, member.id);
        }
      }

      const missing = members.filter((item) => !memberIdByCode.has(item.external_user_code));
      for (const memberChunk of chunks(missing, 500)) {
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
          if (member.external_user_code) memberIdByCode.set(member.external_user_code, member.id);
        }
      }

      const uniqueLinks = new Map<string, (typeof imports)[number]>();
      for (const item of imports) {
        const memberId = memberIdByCode.get(item.associatedCode);
        if (!memberId) continue;
        const installmentCode = item.targetInstallmentId.trim();
        uniqueLinks.set(`${memberId}:${installmentCode}`, {
          ...item,
          targetInstallmentId: installmentCode
        });
      }

      const links = [...uniqueLinks.values()].map((item) => {
        const memberId = memberIdByCode.get(item.associatedCode);
        if (!memberId) throw new Error("Associado importado nao foi localizado.");
        return {
          memberId,
          associatedCode: item.associatedCode,
          targetInstallmentId: item.targetInstallmentId,
          installmentAmountCents: item.installmentAmountCents,
          dueDateText: item.dueDate ?? null,
          sourceLine: item.line
        };
      });

      let importedRecords = 0;
      const duplicateInBatchKeys = new Set<string>();

      for (const linkChunk of chunks(links, 500)) {
        const inserted = await clientQuery<{ id: string; member_id: string; target_installment_id: string | null }>(
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
           do nothing
           returning id, member_id, target_installment_id`,
          [
            campaign.id,
            batch.id,
            linkChunk.map((item) => item.memberId),
            linkChunk.map((item) => item.targetInstallmentId),
            linkChunk.map((item) => item.installmentAmountCents),
            linkChunk.map((item) => item.dueDateText)
          ]
        );

        importedRecords += inserted.rows.length;
        const insertedKeys = new Set(
          inserted.rows.map((row) => `${row.member_id}:${String(row.target_installment_id ?? "").trim()}`)
        );
        for (const item of linkChunk) {
          const key = `${item.memberId}:${item.targetInstallmentId}`;
          if (!insertedKeys.has(key)) duplicateInBatchKeys.add(key);
        }
      }

      const inspectedRowsByLine = new Map(inspectedRows.map((row) => [row.line, row]));
      const importIssues = [...issues];
      for (const item of links) {
        if (!duplicateInBatchKeys.has(`${item.memberId}:${item.targetInstallmentId}`)) continue;
        const inspected = inspectedRowsByLine.get(item.sourceLine);
        importIssues.push({
          line: item.sourceLine,
          associatedCode: item.associatedCode,
          targetInstallmentId: item.targetInstallmentId,
          installmentAmountCents: item.installmentAmountCents,
          cpf: inspected?.cpf,
          name: inspected?.name,
          reason: `Parcela ja existente no lote "${batch.name}".`
        });
      }

      if (importedRecords === 0 && createdBatch) {
        await clientQuery(client, "delete from campaign_batches where id = $1", [batch.id]);
        if (createdCampaign) {
          await clientQuery(client, "delete from campaigns where id = $1", [campaign.id]);
        }
      } else if (importedRecords > 0) {
        await clientQuery(client, `select public.recalculate_batch_totals($1::uuid)`, [batch.id]);
        await clientQuery(
          client,
          `update campaigns set status = 'aguardando', updated_at = now() where id = $1`,
          [campaign.id]
        );
      }

      const eventIssues = importIssues.map((issue) => {
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

      return {
        response: {
          campaignId: importedRecords === 0 && createdCampaign ? null : campaign.id,
          batchId: importedRecords === 0 && createdBatch ? null : batch.id,
          summary: {
            total_lines: imports.length + issues.length,
            valid_records: imports.length,
            invalid_records: importIssues.length,
            duplicated_records: Math.max(0, imports.length - uniqueLinks.size),
            skipped_duplicate_records: duplicateInBatchKeys.size,
            imported_records: importedRecords,
            issues: eventIssues
          },
          processing: { status: "aguardando", jobsCreated: 0 }
        },
        message: importedRecords > 0
          ? "A base foi importada e esta aguardando o processamento. Parcelas ja existentes em outras campanhas foram apenas vinculadas ao lote selecionado."
          : "Todas as parcelas informadas ja existem neste lote."
      };
    });

    return ok(result.response, result.message);
  } catch (error) {
    if (error instanceof ImportHttpError) {
      return fail(error.code, error.message, error.status);
    }

    const databaseError = error as { code?: string; constraint?: string; message?: string };
    if (
      databaseError.code === "23505" &&
      (databaseError.constraint === "campaign_batches_active_name_guard" ||
        databaseError.message?.includes("Ja existe um lote"))
    ) {
      return fail(
        "CONFLICT",
        databaseError.message ?? "Ja existe um lote com este nome nesta campanha.",
        409
      );
    }

    console.error("[CAMPAIGN_IMPORT_V2_FAILED]", error);
    return fail("INTERNAL_ERROR", "Nao foi possivel importar a base.", 500);
  }
}
