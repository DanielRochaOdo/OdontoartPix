import { parseMemberUpdateFile, type MemberUpdateIssue } from "@/lib/imports";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, failWithDetails, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("VALIDATION_ERROR", "Arquivo obrigatorio.", 400);

  const { updates, issues } = await parseMemberUpdateFile(file);
  const resultIssues: MemberUpdateIssue[] = [...issues];
  if (updates.length === 0) {
    return failWithDetails("VALIDATION_ERROR", "O arquivo nao possui dados validos para atualizacao.", { issues: resultIssues });
  }

  const supabase = createSupabaseAdminClient();
  const uniqueCodes = [...new Set(updates.map((item) => item.associatedCode))];
  const members: Array<{ id: string; external_user_code: string | null }> = [];
  for (let index = 0; index < uniqueCodes.length; index += 200) {
    const { data, error } = await supabase
      .from("members")
      .select("id,external_user_code")
      .in("external_user_code", uniqueCodes.slice(index, index + 200))
      .is("deleted_at", null);
    if (error) return fail("DATABASE_ERROR", "Nao foi possivel localizar os associados.", 500);
    members.push(...(data ?? []));
  }

  const memberByCode = new Map(members.map((member) => [String(member.external_user_code), member]));
  const memberIds = members.map((member) => member.id);
  const links: Array<{
    id: string;
    member_id: string;
    target_installment_id: string | null;
    due_date_text: string | null;
  }> = [];
  for (let index = 0; index < memberIds.length; index += 200) {
    const { data, error } = await supabase
      .from("campaign_batch_members")
      .select("id,member_id,target_installment_id,due_date_text")
      .in("member_id", memberIds.slice(index, index + 200))
      .is("deleted_at", null);
    if (error) return fail("DATABASE_ERROR", "Nao foi possivel localizar os vinculos dos associados.", 500);
    links.push(...(data ?? []));
  }

  const linksByMember = new Map<string, typeof links>();
  for (const link of links) {
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
      resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Associado nao encontrado." });
      continue;
    }

    if (update.name !== undefined || update.cpf !== undefined) {
      const memberPatch: Record<string, string> = {};
      if (update.name !== undefined) memberPatch.name = update.name;
      if (update.cpf !== undefined) memberPatch.cpf = update.cpf;
      memberPatch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("members").update(memberPatch).eq("id", member.id);
      if (error) {
        resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Nao foi possivel atualizar o cadastro do associado." });
        continue;
      }
      updatedMembers += 1;
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
      resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Associado nao possui vinculo para atualizar os dados da parcela." });
      continue;
    }

    const selectedLinks = memberLinks.filter(
      (link) => link.target_installment_id === update.targetInstallmentId
    );
    if (selectedLinks.length === 0) {
      resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Parcela nao encontrada para este associado." });
      continue;
    }

    for (const link of selectedLinks) {
      const linkPatch: Record<string, string | number> = {};
      const oldInstallmentId = link.target_installment_id;
      if (update.dueDate !== undefined) linkPatch.due_date_text = update.dueDate;
      if (update.installmentAmountCents !== undefined) linkPatch.installment_amount_cents = update.installmentAmountCents;

      if (Object.keys(linkPatch).length === 0) continue;
      linkPatch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("campaign_batch_members").update(linkPatch).eq("id", link.id);
      if (error) {
        resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Nao foi possivel atualizar o vinculo do associado." });
        continue;
      }
      updatedLinks += 1;

      const installmentPatch: Record<string, string | number> = {};
      if (update.dueDate !== undefined) installmentPatch.due_date_text = update.dueDate;
      if (Object.keys(installmentPatch).length > 0 && oldInstallmentId) {
        installmentPatch.updated_at = new Date().toISOString();
        const { data, error: installmentError } = await supabase
          .from("member_installments")
          .update(installmentPatch)
          .eq("campaign_batch_member_id", link.id)
          .eq("cod_parcela", oldInstallmentId)
          .select("id");
        if (installmentError) {
          resultIssues.push({ line: update.line, associatedCode: update.associatedCode, reason: "Vinculo atualizado, mas nao foi possivel atualizar a parcela persistida." });
        } else {
          updatedInstallments += data?.length ?? 0;
        }
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
}
