import { parseMemberUpdateFile, type MemberUpdateIssue } from "@/lib/imports";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { hashCpf } from "@/lib/hash";
import { fail, failWithDetails, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

type MemberRow = { id: string; external_user_code: string | null };
type LinkRow = {
  id: string;
  member_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
};

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("VALIDATION_ERROR", "Arquivo obrigatorio.", 400);

  const { updates, issues } = await parseMemberUpdateFile(file);
  const resultIssues: MemberUpdateIssue[] = [...issues];
  if (updates.length === 0) {
    return failWithDetails(
      "VALIDATION_ERROR",
      "O arquivo nao possui dados validos para atualizacao.",
      { issues: resultIssues }
    );
  }

  try {
    const uniqueCodes = [...new Set(updates.map((item) => item.associatedCode))];
    const membersResult = uniqueCodes.length > 0
      ? await dbQuery<MemberRow>(
          `select id, external_user_code
             from members
            where deleted_at is null
              and external_user_code = any($1::text[])`,
          [uniqueCodes]
        )
      : { rows: [] as MemberRow[] };

    const members = membersResult.rows;
    const memberByCode = new Map(members.map((member) => [String(member.external_user_code), member]));
    const memberIds = members.map((member) => member.id);
    const linksResult = memberIds.length > 0
      ? await dbQuery<LinkRow>(
          `select id, member_id, target_installment_id, due_date_text
             from campaign_batch_members
            where deleted_at is null
              and member_id = any($1::uuid[])`,
          [memberIds]
        )
      : { rows: [] as LinkRow[] };

    const linksByMember = new Map<string, LinkRow[]>();
    for (const link of linksResult.rows) {
      const current = linksByMember.get(link.member_id) ?? [];
      current.push(link);
      linksByMember.set(link.member_id, current);
    }

    let updatedRows = 0;
    let updatedMembers = 0;
    let updatedLinks = 0;
    let updatedInstallments = 0;

    for (const update of updates) {
      const member = memberByCode.get(update.associatedCode);
      if (!member) {
        resultIssues.push({
          line: update.line,
          associatedCode: update.associatedCode,
          reason: "Associado nao encontrado."
        });
        continue;
      }

      if (update.name !== undefined || update.cpf !== undefined) {
        try {
          await dbQuery(
            `update members
                set name = case when $2::text is null then name else $2 end,
                    cpf = case when $3::text is null then cpf else $3 end,
                    cpf_hash = case when $3::text is null then cpf_hash else $4 end,
                    updated_at = now()
              where id = $1::uuid`,
            [
              member.id,
              update.name ?? null,
              update.cpf ?? null,
              update.cpf !== undefined ? hashCpf(update.cpf) : null
            ]
          );
          updatedMembers += 1;
        } catch {
          resultIssues.push({
            line: update.line,
            associatedCode: update.associatedCode,
            reason: "Nao foi possivel atualizar o cadastro do associado."
          });
          continue;
        }
      }

      const hasLinkUpdate =
        update.dueDate !== undefined ||
        update.installmentAmountCents !== undefined ||
        update.targetInstallmentId !== undefined;

      if (!hasLinkUpdate) {
        updatedRows += 1;
        continue;
      }

      const memberLinks = linksByMember.get(member.id) ?? [];
      if (memberLinks.length === 0) {
        resultIssues.push({
          line: update.line,
          associatedCode: update.associatedCode,
          reason: "Associado nao possui vinculo para atualizar os dados da parcela."
        });
        continue;
      }

      const selectedLinks = memberLinks.filter(
        (link) => link.target_installment_id === update.targetInstallmentId
      );
      if (selectedLinks.length === 0) {
        resultIssues.push({
          line: update.line,
          associatedCode: update.associatedCode,
          reason: "Parcela nao encontrada para este associado."
        });
        continue;
      }

      for (const link of selectedLinks) {
        try {
          const result = await dbQuery<{ id: string }>(
            `update campaign_batch_members
                set due_date_text = case when $2::text is null then due_date_text else $2 end,
                    installment_amount_cents = case when $3::bigint is null then installment_amount_cents else $3 end,
                    updated_at = now()
              where id = $1::uuid
            returning id`,
            [link.id, update.dueDate ?? null, update.installmentAmountCents ?? null]
          );
          if (!result.rows[0]) continue;
          updatedLinks += 1;

          if (update.dueDate !== undefined && link.target_installment_id) {
            const installment = await dbQuery<{ id: string }>(
              `update member_installments
                  set due_date_text = $3, updated_at = now()
                where campaign_batch_member_id = $1::uuid
                  and cod_parcela = $2
              returning id`,
              [link.id, link.target_installment_id, update.dueDate]
            );
            updatedInstallments += installment.rows.length;
          }
        } catch {
          resultIssues.push({
            line: update.line,
            associatedCode: update.associatedCode,
            reason: "Nao foi possivel atualizar o vinculo do associado."
          });
        }
      }

      updatedRows += 1;
    }

    return ok({
      summary: {
        received_records: updates.length,
        updated_records: updatedRows,
        updated_members: updatedMembers,
        updated_links: updatedLinks,
        updated_installments: updatedInstallments,
        invalid_records: resultIssues.length,
        issues: resultIssues
      }
    }, "Atualizacao concluida diretamente no banco.");
  } catch (error) {
    console.error("[MEMBER_BULK_UPDATE_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel atualizar os associados.", 500);
  }
}
