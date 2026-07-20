import { z } from "zod";
import { parseMemberFile } from "@/lib/imports";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashCpf } from "@/lib/hash";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const FormSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().default("")
});
const OptionalIdSchema = z.string().uuid().optional();

type ImportedMember = {
  cpf: string;
  cpf_hash: string;
  name: string | null;
  external_user_code: string | null;
};

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
    return fail("VALIDATION_ERROR", "Informe um nome válido para a campanha.", 400);
  }
  if (!(file instanceof File)) {
    return fail("VALIDATION_ERROR", "Arquivo obrigatório.", 400);
  }

  const { imports, issues } = await parseMemberFile(file);
  if (imports.length === 0) {
    return fail(
      "VALIDATION_ERROR",
      "O arquivo não possui nenhum CPF válido para importação.",
      400
    );
  }

  const supabase = createSupabaseAdminClient();
  let campaign: { id: string; name?: string } | null = null;
  let batch: { id: string; campaign_id?: string; name?: string } | null = null;
  let createdCampaign = false;
  let createdBatch = false;

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
      if (!data) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
      campaign = data;
    } else {
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
      if (error || !data) throw error ?? new Error("Campanha não criada.");
      campaign = data;
      createdCampaign = true;
    }

    if (batchId.success && batchId.data) {
      const { data, error } = await supabase
        .from("campaign_batches")
        .select("id,campaign_id,name")
        .eq("id", batchId.data)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return fail("NOT_FOUND", "Lote não encontrado.", 404);
      if (data.campaign_id !== campaign.id) {
        return fail("CONFLICT", "O lote não pertence à campanha informada.", 409);
      }
      batch = data;
    } else {
      const { data, error } = await supabase
        .from("campaign_batches")
        .insert({
          campaign_id: campaign.id,
          name: `${payload.data.name} - Lote 1`,
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
      if (error || !data) throw error ?? new Error("Lote não criado.");
      batch = data;
      createdBatch = true;
    }

    const uniqueMembers = new Map<string, ImportedMember>();
    for (const item of imports) {
      const cpfHash = hashCpf(item.cpf);
      if (!uniqueMembers.has(cpfHash)) {
        uniqueMembers.set(cpfHash, {
          cpf: item.cpf,
          cpf_hash: cpfHash,
          name: item.name ?? null,
          external_user_code: item.external_user_code ?? null
        });
      }
    }

    const membersUpsert = [...uniqueMembers.values()];
    const { error: memberError } = await supabase
      .from("members")
      .upsert(membersUpsert, { onConflict: "cpf_hash" });
    if (memberError) throw memberError;

    const { data: storedMembers, error: lookupError } = await supabase
      .from("members")
      .select("id,cpf_hash")
      .in(
        "cpf_hash",
        membersUpsert.map((item) => item.cpf_hash)
      );
    if (lookupError) throw lookupError;

    const memberIdByHash = new Map(
      (storedMembers ?? []).map((item) => [item.cpf_hash, item.id])
    );
    const linksPayload = membersUpsert.map((item) => {
      const memberId = memberIdByHash.get(item.cpf_hash);
      if (!memberId) throw new Error("Associado importado não foi localizado.");
      return {
        campaign_id: campaign.id,
        batch_id: batch.id,
        member_id: memberId,
        processing_status: "pending",
        payment_status: null,
        total_pending_amount_cents: 0,
        installments_count: 0,
        processing_attempts: 0,
        last_error: null
      };
    });

    const { error: linkError } = await supabase
      .from("campaign_batch_members")
      .upsert(linksPayload, { onConflict: "batch_id,member_id" });
    if (linkError) throw linkError;

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
      .eq("id", batch.id);
    if (batchUpdateError) throw batchUpdateError;

    await supabase
      .from("campaigns")
      .update({ status: "aguardando" })
      .eq("id", campaign.id);

    return ok(
      {
        campaignId: campaign.id,
        batchId: batch.id,
        summary: {
          total_lines: imports.length + issues.length,
          valid_records: imports.length,
          invalid_records: issues.length,
          duplicated_records: imports.length - linksPayload.length,
          imported_records: linksPayload.length,
          issues
        },
        processing: {
          status: "aguardando",
          jobsCreated: 0
        }
      },
      "A base foi importada e está aguardando o processamento."
    );
  } catch (error) {
    await cleanupCreatedResources();
    console.error("[CAMPAIGN_IMPORT_FAILED]", {
      campaignId: campaign?.id ?? null,
      batchId: batch?.id ?? null,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível concluir a importação.", 500);
  }
}
