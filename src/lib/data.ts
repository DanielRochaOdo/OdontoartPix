import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataAccessError } from "@/lib/errors/data-access-error";

type MembersListItem = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  processing_status: string;
  payment_status: string | null;
  total_pending_amount_cents: number;
  installments_count: number;
  last_checked_at: string | null;
  processing_attempts: number;
  last_error: string | null;
  payment_description: string | null;
  member: {
    id: string;
    cpf: string | null;
    cpf_hash: string | null;
    name: string | null;
    external_user_code: string | null;
  } | {
    id: string;
    cpf: string | null;
    cpf_hash: string | null;
    name: string | null;
    external_user_code: string | null;
  }[] | null;
  batch: { id: string; name: string } | { id: string; name: string }[] | null;
  campaign: { id: string; name: string } | { id: string; name: string }[] | null;
};

type TargetReceiptRow = {
  campaign_batch_member_id: string;
  cod_parcela: string | null;
  situation: string | null;
  payment_description: string | null;
  paid_amount_cents: number | null;
  updated_at: string | null;
  created_at: string | null;
};

export async function getCampaigns() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id,name,status,description,created_at,updated_at,start_date,end_date")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar as campanhas.", "getCampaigns", error);
  }
  return data ?? [];
}

export async function getBatches() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select(
      "id,campaign_id,name,status,total_records,processed_records,paid_records,unpaid_records,error_records,created_at"
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar os lotes.", "getBatches", error);
  }
  return data ?? [];
}

export async function getCampaignById(id: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id,name,status,description,start_date,end_date,notes,created_at,updated_at,owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar a campanha.", "getCampaignById", error);
  }
  return data;
}

export async function getBatchesByCampaign(campaignId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select(
      "id,campaign_id,name,status,total_records,processed_records,paid_records,unpaid_records,error_records,total_pending_amount_cents,created_at,updated_at"
    )
    .eq("campaign_id", campaignId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os lotes da campanha.",
      "getBatchesByCampaign",
      error
    );
  }
  return data ?? [];
}

export async function getMemberPreviewByCampaign(campaignId: string, limit = 6) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batch_members")
    .select(
      "id,campaign_id,batch_id,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,cpf_hash,name,external_user_code),batch:campaign_batches(id,name)"
    )
    .eq("campaign_id", campaignId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar a previa dos associados.",
      "getMemberPreviewByCampaign",
      error
    );
  }
  return data ?? [];
}

export async function getBatchById(id: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select("id,campaign_id,name,description,status,created_at,updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar o lote.", "getBatchById", error);
  }
  return data;
}

export async function getMemberPreviewByBatch(batchId: string, limit = 20) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batch_members")
    .select(
      "id,campaign_id,batch_id,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,name,external_user_code)"
    )
    .eq("batch_id", batchId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os associados do lote.",
      "getMemberPreviewByBatch",
      error
    );
  }
  return data ?? [];
}

export async function getMembers(filters: {
  campaignIds?: string[];
  batchIds?: string[];
  status?: string;
} = {}) {
  const supabase = createSupabaseAdminClient();
  const pageSize = 1000;
  const rows: MembersListItem[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    let query = supabase
      .from("campaign_batch_members")
      .select(
      "id,campaign_id,batch_id,target_installment_id,due_date_text,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,cpf_hash,name,external_user_code),batch:campaign_batches(id,name),campaign:campaigns(id,name)"
      )
      .is("deleted_at", null);

    if (filters.campaignIds?.length) query = query.in("campaign_id", filters.campaignIds);
    if (filters.batchIds?.length) query = query.in("batch_id", filters.batchIds);
    if (filters.status && filters.status !== "all") query = query.eq("processing_status", filters.status);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      throw new DataAccessError("Nao foi possivel carregar os associados.", "getMembers", error);
    }

    const chunk = (data ?? []) as Omit<MembersListItem, "payment_description">[];
    const chunkIds = chunk.map((item) => item.id);
    const targetIdByMember = new Map(
      chunk.map((item) => [item.id, String(item.target_installment_id ?? "").trim()])
    );
    const targetReceiptByMember = new Map<string, TargetReceiptRow>();

    // Histórico completo pode ter centenas de parcelas por associado. Para a
    // listagem precisamos somente da target_installment_id; nunca carregamos o
    // histórico inteiro aqui. O detalhe do associado continua podendo fazê-lo.
    if (chunkIds.length > 0) {
      const lookupChunkSize = 100;
      for (let chunkStart = 0; chunkStart < chunkIds.length; chunkStart += lookupChunkSize) {
        const lookupIds = chunkIds.slice(chunkStart, chunkStart + lookupChunkSize);
        const targetCodes = Array.from(new Set(
          lookupIds.map((id) => targetIdByMember.get(id) ?? "").filter(Boolean)
        ));
        if (targetCodes.length === 0) continue;

        const { data: installmentRows, error: installmentError } = await supabase
          .from("member_installments")
          .select(
            "campaign_batch_member_id,cod_parcela,situation,payment_description,paid_amount_cents,updated_at,created_at"
          )
          .in("campaign_batch_member_id", lookupIds)
          .in("cod_parcela", targetCodes)
          .order("updated_at", { ascending: false })
          .order("created_at", { ascending: false });

        if (installmentError) {
          throw new DataAccessError(
            "Nao foi possivel carregar a parcela alvo dos associados.",
            "getMembers.targetPayment",
            installmentError
          );
        }

        for (const installment of (installmentRows ?? []) as TargetReceiptRow[]) {
          const expectedTarget = targetIdByMember.get(installment.campaign_batch_member_id) ?? "";
          if (String(installment.cod_parcela ?? "").trim() !== expectedTarget) continue;
          if (!targetReceiptByMember.has(installment.campaign_batch_member_id)) {
            targetReceiptByMember.set(installment.campaign_batch_member_id, installment);
          }
        }
      }
    }

    rows.push(
      ...chunk.map((item) => {
        const target = targetReceiptByMember.get(item.id);
        const paymentDescription =
          target?.payment_description?.trim() || target?.situation?.trim() || null;

        return {
          ...item,
          payment_description: paymentDescription
        };
      })
    );

    if (chunk.length < pageSize) break;
  }

  return rows;
}

export async function getMemberDetail(campaignBatchMemberId: string) {
  const supabase = createSupabaseAdminClient();
  const { data: link, error: linkError } = await supabase
    .from("campaign_batch_members")
    .select(
      "id,campaign_id,batch_id,member_id,target_installment_id,due_date_text,installment_amount_cents,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,name,external_user_code),batch:campaign_batches(id,name),campaign:campaigns(id,name)"
    )
    .eq("id", campaignBatchMemberId)
    .is("deleted_at", null)
    .maybeSingle();

  if (linkError) {
    throw new DataAccessError(
      "Nao foi possivel carregar o associado.",
      "getMemberDetail.link",
      linkError
    );
  }
  if (!link) return null;

  const { data: relatedLinks, error: relatedLinksError } = await supabase
    .from("campaign_batch_members")
    .select("id,target_installment_id,due_date_text,installment_amount_cents,processing_status,payment_status")
    .eq("member_id", link.member_id)
    .is("deleted_at", null);

  if (relatedLinksError) {
    throw new DataAccessError(
      "Nao foi possivel localizar os vinculos do associado.",
      "getMemberDetail.relatedLinks",
      relatedLinksError
    );
  }

  const relatedLinkIds = Array.from(
    new Set([campaignBatchMemberId, ...(relatedLinks ?? []).map((item) => item.id)])
  );

  const [installmentsResult, totalsResult] = await Promise.all([
    supabase
      .from("member_installments")
      .select(
        "id,cod_usuario,cod_parcela,due_date_text,installment_type,boleto_code,pix_code,card_payment_link,situation,payment_description,paid_amount_cents,base_amount_cents,fine_amount_cents,interest_amount_cents,additional_amount_cents,discount_amount_cents,final_amount_cents,plan_type,observation,created_at"
      )
      .in("campaign_batch_member_id", relatedLinkIds)
      .order("due_date_text", { ascending: true })
      .order("created_at", { ascending: false }),
    supabase
      .from("member_plan_totals")
      .select("id,plan_type,installments_count,total_amount_cents")
      .eq("campaign_batch_member_id", campaignBatchMemberId)
      .order("plan_type", { ascending: true }),
  ]);

  if (installmentsResult.error) {
    throw new DataAccessError(
      "Nao foi possivel carregar as parcelas.",
      "getMemberDetail.installments",
      installmentsResult.error
    );
  }
  if (totalsResult.error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os totais por plano.",
      "getMemberDetail.planTotals",
      totalsResult.error
    );
  }

  const persistedInstallments = installmentsResult.data ?? [];
  const persistedCodes = new Set(
    persistedInstallments
      .map((installment) => String(installment.cod_parcela ?? "").trim())
      .filter(Boolean)
  );
  const targetInstallmentsWithoutDetails = (relatedLinks ?? [])
    .filter((item) => {
      const code = String(item.target_installment_id ?? "").trim();
      return code && !persistedCodes.has(code);
    })
    .map((item) => ({
      id: `target-${item.id}`,
      cod_usuario: null,
      cod_parcela: item.target_installment_id,
      due_date_text: item.due_date_text,
      installment_type: null,
      boleto_code: null,
      pix_code: null,
      card_payment_link: null,
      situation:
        item.payment_status === "unpaid"
          ? "open"
          : item.payment_status ?? item.processing_status,
      payment_description: null,
      paid_amount_cents: null,
      base_amount_cents: item.installment_amount_cents ?? 0,
      fine_amount_cents: 0,
      interest_amount_cents: 0,
      additional_amount_cents: 0,
      discount_amount_cents: 0,
      final_amount_cents: item.installment_amount_cents ?? 0,
      plan_type: "Não informado",
      observation: "Parcela de destino cadastrada para o associado.",
      created_at: null
    }));

  const installments = [...persistedInstallments, ...targetInstallmentsWithoutDetails].sort(
    (left, right) =>
      String(left.due_date_text ?? "9999-99-99").localeCompare(
        String(right.due_date_text ?? "9999-99-99")
      )
  );

  return {
    link,
    installments,
    planTotals: totalsResult.data ?? []
  };
}
