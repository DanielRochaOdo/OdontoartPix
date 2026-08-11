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

    const chunk = (data ?? []) as MembersListItem[];
    rows.push(...chunk);

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

  const [installmentsResult, totalsResult, logsResult] = await Promise.all([
    supabase
      .from("member_installments")
      .select(
        "id,cod_usuario,cod_parcela,due_date_text,installment_type,boleto_code,pix_code,card_payment_link,situation,base_amount_cents,fine_amount_cents,interest_amount_cents,additional_amount_cents,discount_amount_cents,final_amount_cents,plan_type,observation,created_at"
      )
      .eq("campaign_batch_member_id", campaignBatchMemberId)
      .order("due_date_text", { ascending: true }),
    supabase
      .from("member_plan_totals")
      .select("id,plan_type,installments_count,total_amount_cents")
      .eq("campaign_batch_member_id", campaignBatchMemberId)
      .order("plan_type", { ascending: true }),
    supabase
      .from("consultation_logs")
      .select(
        "id,request_status,http_status,duration_ms,attempt_number,error_code,error_message,consulted_at"
      )
      .eq("campaign_batch_member_id", campaignBatchMemberId)
      .order("consulted_at", { ascending: false })
      .limit(20)
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
  if (logsResult.error) {
    throw new DataAccessError(
      "Nao foi possivel carregar o historico de consultas.",
      "getMemberDetail.logs",
      logsResult.error
    );
  }

  return {
    link,
    installments: installmentsResult.data ?? [],
    planTotals: totalsResult.data ?? [],
    logs: logsResult.data ?? []
  };
}
