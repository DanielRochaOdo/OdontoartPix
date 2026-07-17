import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataAccessError } from "@/lib/errors/data-access-error";

export async function getCampaigns() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id,name,status,description,created_at,updated_at, start_date, end_date")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new DataAccessError("Não foi possível carregar as campanhas.", "getCampaigns", error);
  return data ?? [];
}

export async function getBatches() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select("id,campaign_id,name,status,total_records,processed_records,paid_records,unpaid_records,error_records,created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new DataAccessError("Não foi possível carregar os lotes.", "getBatches", error);
  return data ?? [];
}

export async function getCampaignById(id: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id,name,status,description,start_date,end_date,notes,created_at,updated_at,owner_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new DataAccessError("Não foi possível carregar a campanha.", "getCampaignById", error);
  return data;
}

export async function getBatchesByCampaign(campaignId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select("id,campaign_id,name,status,total_records,processed_records,paid_records,unpaid_records,error_records,total_pending_amount_cents,created_at,updated_at")
    .eq("campaign_id", campaignId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("Não foi possível carregar os lotes da campanha.", "getBatchesByCampaign", error);
  return data ?? [];
}

export async function getMembersByCampaign(campaignId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batch_members")
    .select("id,campaign_id,batch_id,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,cpf_hash,name,external_user_code),batch:campaign_batches(id,name)")
    .eq("campaign_id", campaignId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("Não foi possível carregar os associados da campanha.", "getMembersByCampaign", error);
  return data ?? [];
}

export async function getMembers() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batch_members")
    .select("id,campaign_id,batch_id,processing_status,payment_status,total_pending_amount_cents,installments_count,last_checked_at,processing_attempts,last_error,member:members(id,cpf,cpf_hash,name,external_user_code)")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new DataAccessError("Não foi possível carregar os associados.", "getMembers", error);
  return data ?? [];
}
