import { z } from "zod";
import { parseMemberFile } from "@/lib/imports";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { consultMonthlyByCpf } from "@/lib/mensalidades-api";
import { hashCpf } from "@/lib/hash";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const FormSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default("")
});
const OptionalIdSchema = z.string().uuid().optional();

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const payload = FormSchema.safeParse({
    name: form.get("name"),
    description: form.get("description")
  });
  const campaignId = OptionalIdSchema.safeParse(form.get("campaignId"));
  const batchId = OptionalIdSchema.safeParse(form.get("batchId"));
  const file = form.get("file");

  if (!payload.success) {
    return fail("VALIDATION_ERROR", "Payload inválido.", 400);
  }

  if (!(file instanceof File)) {
    return fail("VALIDATION_ERROR", "Arquivo obrigatório.", 400);
  }

  const { imports, issues } = await parseMemberFile(file);
  const supabase = createSupabaseAdminClient();

  let campaign = null;
  let batch = null;

  if (campaignId.success && campaignId.data) {
    const { data, error } = await supabase.from("campaigns").select("id,name").eq("id", campaignId.data).maybeSingle();
    if (error || !data) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    campaign = data;
  } else {
    const { data, error } = await supabase
      .from("campaigns")
      .insert({
        name: payload.data.name.trim(),
        description: payload.data.description.trim(),
        status: "aguardando",
        created_by: auth.profile.id
      })
      .select("id")
      .single();

    if (error || !data) {
      return fail("DATABASE_ERROR", "Falha ao criar campanha.", 500);
    }
    campaign = data;
  }

  if (batchId.success && batchId.data) {
    const { data, error } = await supabase
      .from("campaign_batches")
      .select("id,campaign_id,name")
      .eq("id", batchId.data)
      .maybeSingle();
    if (error || !data) return fail("NOT_FOUND", "Lote não encontrado.", 404);
    if (data.campaign_id !== campaign.id) return fail("CONFLICT", "O lote não pertence à campanha informada.", 409);
    batch = data;
  } else {
    const { data, error } = await supabase
      .from("campaign_batches")
      .insert({
        campaign_id: campaign.id,
        name: `${payload.data.name.trim()} - Lote 1`,
        description: payload.data.description.trim(),
        status: "aguardando",
        total_records: imports.length,
        created_by: auth.profile.id
      })
      .select("id")
      .single();

    if (error || !data) {
      return fail("DATABASE_ERROR", "Falha ao criar lote.", 500);
    }
    batch = data;
  }

  const uniqueMembers = new Map<string, { cpf: string; cpf_hash: string; name: string | null; external_user_code: string | null }>();
  for (const item of imports) {
    const cpf_hash = hashCpf(item.cpf);
    if (!uniqueMembers.has(cpf_hash)) {
      uniqueMembers.set(cpf_hash, {
        cpf: item.cpf,
        cpf_hash,
        name: item.name ?? null,
        external_user_code: item.external_user_code ?? null
      });
    }
  }

  const membersUpsert = [...uniqueMembers.values()];
  const { error: memberError } = await supabase.from("members").upsert(membersUpsert, { onConflict: "cpf_hash" });
  if (memberError) return fail("DATABASE_ERROR", "Falha ao salvar associados.", 500);

  const { data: insertedMembers, error: lookupError } = await supabase
    .from("members")
    .select("id,cpf_hash")
    .in("cpf_hash", membersUpsert.map((item) => item.cpf_hash));

  if (lookupError) return fail("DATABASE_ERROR", "Falha ao localizar associados.", 500);

  const memberIdByHash = new Map((insertedMembers ?? []).map((item) => [item.cpf_hash, item.id]));
  const linksPayload = imports
    .map((item) => ({
      campaign_id: campaign.id,
      batch_id: batch.id,
      member_id: memberIdByHash.get(hashCpf(item.cpf)),
      processing_status: "pending"
    }))
    .filter((item) => Boolean(item.member_id));

  const { error: linkError } = await supabase.from("campaign_batch_members").upsert(linksPayload, { onConflict: "batch_id,member_id" });
  if (linkError) return fail("DATABASE_ERROR", "Falha ao vincular associados ao lote.", 500);

  const results = await Promise.allSettled(
    imports.map(async (item) => {
      const response = await consultMonthlyByCpf(item.cpf);
      return { cpf: item.cpf, ...response };
    })
  );

  const processed = results.filter((item) => item.status === "fulfilled").length;
  const errored = results.length - processed;
  const paid = results.filter((item) => item.status === "fulfilled" && item.value.analysis.paymentStatus === "paid").length;
  const unpaid = results.filter((item) => item.status === "fulfilled" && item.value.analysis.paymentStatus === "unpaid").length;

  await supabase
    .from("campaign_batches")
    .update({
      status: "concluído",
      processed_records: processed,
      paid_records: paid,
      unpaid_records: unpaid,
      error_records: errored
    })
    .eq("id", batch.id);

  return ok(
    {
      campaignId: campaign.id,
      batchId: batch.id,
      summary: {
        total_lines: imports.length + issues.length,
        valid_records: imports.length,
        invalid_records: issues.length,
        duplicated_or_invalid: issues.length,
        imported_records: imports.length,
        issues
      },
      results: results.map((item) => (item.status === "fulfilled" ? item.value : { error: "Falha na consulta." }))
    },
    "Importação concluída."
  );
}
