import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

type RelationMember = {
  id: string;
  cpf: string | null;
  cpf_hash?: string | null;
  name: string | null;
  external_user_code: string | null;
};

type RelationNamed = { id: string; name: string };

export type MembersListItem = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
  processing_status: string;
  payment_status: string | null;
  total_pending_amount_cents: number;
  installments_count: number;
  last_checked_at: string | null;
  processing_attempts: number;
  last_error: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  member: RelationMember | null;
  batch: RelationNamed | null;
  campaign: RelationNamed | null;
};

export type CampaignDataRow = {
  id: string;
  name: string;
  status: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  start_date: string | null;
  end_date: string | null;
};

export type BatchDataRow = {
  id: string;
  campaign_id: string;
  name: string;
  description?: string | null;
  status: string;
  total_records?: number;
  processed_records?: number;
  paid_records?: number;
  unpaid_records?: number;
  error_records?: number;
  total_pending_amount_cents?: number;
  created_at: string;
  updated_at?: string;
};

export type MemberPreviewRow = {
  id: string;
  campaign_id: string;
  batch_id: string;
  processing_status: string;
  payment_status: string | null;
  total_pending_amount_cents: number;
  installments_count: number;
  last_checked_at: string | null;
  processing_attempts: number;
  last_error: string | null;
  member: RelationMember | null;
  batch?: RelationNamed | null;
};

export type MemberDetailLink = {
  id: string;
  campaign_id: string;
  batch_id: string;
  member_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
  installment_amount_cents: number;
  processing_status: string;
  payment_status: string | null;
  total_pending_amount_cents: number;
  installments_count: number;
  last_checked_at: string | null;
  processing_attempts: number;
  last_error: string | null;
  member: RelationMember | null;
  batch: RelationNamed | null;
  campaign: RelationNamed | null;
};

export type MemberInstallmentRow = {
  id: string;
  cod_usuario: string | null;
  cod_parcela: string | null;
  due_date_text: string | null;
  installment_type: string | null;
  boleto_code: string | null;
  pix_code: string | null;
  card_payment_link: string | null;
  situation: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  paid_amount_cents: number | null;
  base_amount_cents: number;
  fine_amount_cents: number;
  interest_amount_cents: number;
  additional_amount_cents: number;
  discount_amount_cents: number;
  final_amount_cents: number;
  plan_type: string;
  observation: string | null;
  created_at: string | null;
};

export type MemberPlanTotalRow = {
  id: string;
  plan_type: string;
  installments_count: number;
  total_amount_cents: number;
};

function dataError(message: string, operation: string, error: unknown): never {
  throw new DataAccessError(message, operation, error);
}

export async function getCampaigns(): Promise<CampaignDataRow[]> {
  try {
    const result = await dbQuery<CampaignDataRow>(
      `select id, name, status, description,
              created_at::text, updated_at::text,
              start_date::text, end_date::text
         from campaigns
        where deleted_at is null
        order by created_at desc
        limit 50`
    );
    return result.rows;
  } catch (error) {
    return dataError("Nao foi possivel carregar as campanhas.", "getCampaigns", error);
  }
}

export async function getBatches(): Promise<BatchDataRow[]> {
  try {
    const result = await dbQuery<BatchDataRow>(
      `select id, campaign_id, name, status,
              total_records, processed_records, paid_records,
              unpaid_records, error_records, created_at::text
         from campaign_batches
        where deleted_at is null
        order by created_at desc
        limit 50`
    );
    return result.rows;
  } catch (error) {
    return dataError("Nao foi possivel carregar os lotes.", "getBatches", error);
  }
}

export async function getCampaignById(id: string) {
  try {
    const result = await dbQuery<{
      id: string;
      name: string;
      status: string;
      description: string | null;
      start_date: string | null;
      end_date: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      owner_id: string | null;
    }>(
      `select id, name, status, description,
              start_date::text, end_date::text, notes,
              created_at::text, updated_at::text, owner_id
         from campaigns
        where id = $1 and deleted_at is null
        limit 1`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    return dataError("Nao foi possivel carregar a campanha.", "getCampaignById", error);
  }
}

export async function getBatchesByCampaign(campaignId: string): Promise<BatchDataRow[]> {
  try {
    const result = await dbQuery<BatchDataRow>(
      `select id, campaign_id, name, status,
              total_records, processed_records, paid_records,
              unpaid_records, error_records,
              total_pending_amount_cents::float8 as total_pending_amount_cents,
              created_at::text, updated_at::text
         from campaign_batches
        where campaign_id = $1 and deleted_at is null
        order by created_at asc`,
      [campaignId]
    );
    return result.rows;
  } catch (error) {
    return dataError(
      "Nao foi possivel carregar os lotes da campanha.",
      "getBatchesByCampaign",
      error
    );
  }
}

export async function getMemberPreviewByCampaign(
  campaignId: string,
  limit = 6
): Promise<MemberPreviewRow[]> {
  try {
    const result = await dbQuery<{
      id: string;
      campaign_id: string;
      batch_id: string;
      processing_status: string;
      payment_status: string | null;
      total_pending_amount_cents: number;
      installments_count: number;
      last_checked_at: string | null;
      processing_attempts: number;
      last_error: string | null;
      member_id: string;
      member_cpf: string | null;
      member_cpf_hash: string | null;
      member_name: string | null;
      external_user_code: string | null;
      batch_name: string;
    }>(
      `select cbm.id, cbm.campaign_id, cbm.batch_id,
              cbm.processing_status, cbm.payment_status,
              cbm.total_pending_amount_cents::float8 as total_pending_amount_cents,
              cbm.installments_count, cbm.last_checked_at::text,
              cbm.processing_attempts, cbm.last_error,
              m.id as member_id, m.cpf as member_cpf, m.cpf_hash as member_cpf_hash,
              m.name as member_name, m.external_user_code,
              b.name as batch_name
         from campaign_batch_members cbm
         join members m on m.id = cbm.member_id and m.deleted_at is null
         join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
        where cbm.campaign_id = $1 and cbm.deleted_at is null
        order by cbm.created_at desc
        limit $2`,
      [campaignId, Math.max(1, Math.min(limit, 1000))]
    );

    return result.rows.map((row) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      batch_id: row.batch_id,
      processing_status: row.processing_status,
      payment_status: row.payment_status,
      total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
      installments_count: Number(row.installments_count ?? 0),
      last_checked_at: row.last_checked_at,
      processing_attempts: Number(row.processing_attempts ?? 0),
      last_error: row.last_error,
      member: {
        id: row.member_id,
        cpf: row.member_cpf,
        cpf_hash: row.member_cpf_hash,
        name: row.member_name,
        external_user_code: row.external_user_code
      },
      batch: { id: row.batch_id, name: row.batch_name }
    }));
  } catch (error) {
    return dataError(
      "Nao foi possivel carregar a previa dos associados.",
      "getMemberPreviewByCampaign",
      error
    );
  }
}

export async function getBatchById(id: string) {
  try {
    const result = await dbQuery<{
      id: string;
      campaign_id: string;
      name: string;
      description: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      `select id, campaign_id, name, description, status,
              created_at::text, updated_at::text
         from campaign_batches
        where id = $1 and deleted_at is null
        limit 1`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    return dataError("Nao foi possivel carregar o lote.", "getBatchById", error);
  }
}

export async function getMemberPreviewByBatch(
  batchId: string,
  limit = 20
): Promise<MemberPreviewRow[]> {
  try {
    const result = await dbQuery<{
      id: string;
      campaign_id: string;
      batch_id: string;
      processing_status: string;
      payment_status: string | null;
      total_pending_amount_cents: number;
      installments_count: number;
      last_checked_at: string | null;
      processing_attempts: number;
      last_error: string | null;
      member_id: string;
      member_cpf: string | null;
      member_name: string | null;
      external_user_code: string | null;
    }>(
      `select cbm.id, cbm.campaign_id, cbm.batch_id,
              cbm.processing_status, cbm.payment_status,
              cbm.total_pending_amount_cents::float8 as total_pending_amount_cents,
              cbm.installments_count, cbm.last_checked_at::text,
              cbm.processing_attempts, cbm.last_error,
              m.id as member_id, m.cpf as member_cpf,
              m.name as member_name, m.external_user_code
         from campaign_batch_members cbm
         join members m on m.id = cbm.member_id and m.deleted_at is null
        where cbm.batch_id = $1 and cbm.deleted_at is null
        order by cbm.created_at asc
        limit $2`,
      [batchId, Math.max(1, Math.min(limit, 1000))]
    );

    return result.rows.map((row) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      batch_id: row.batch_id,
      processing_status: row.processing_status,
      payment_status: row.payment_status,
      total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
      installments_count: Number(row.installments_count ?? 0),
      last_checked_at: row.last_checked_at,
      processing_attempts: Number(row.processing_attempts ?? 0),
      last_error: row.last_error,
      member: {
        id: row.member_id,
        cpf: row.member_cpf,
        name: row.member_name,
        external_user_code: row.external_user_code
      }
    }));
  } catch (error) {
    return dataError(
      "Nao foi possivel carregar os associados do lote.",
      "getMemberPreviewByBatch",
      error
    );
  }
}

export async function getMembers(filters: {
  campaignIds?: string[];
  batchIds?: string[];
  status?: string;
} = {}): Promise<MembersListItem[]> {
  const campaignIds = (filters.campaignIds ?? []).filter(Boolean);
  const batchIds = (filters.batchIds ?? []).filter(Boolean);
  const status = filters.status && filters.status !== "all" ? filters.status : null;

  try {
    const result = await dbQuery<{
      id: string;
      campaign_id: string;
      batch_id: string;
      target_installment_id: string | null;
      due_date_text: string | null;
      processing_status: string;
      payment_status: string | null;
      total_pending_amount_cents: number;
      installments_count: number;
      last_checked_at: string | null;
      processing_attempts: number;
      last_error: string | null;
      member_id: string;
      cpf: string | null;
      cpf_hash: string | null;
      member_name: string | null;
      external_user_code: string | null;
      batch_name: string;
      campaign_name: string;
      payment_description: string | null;
      payment_date_text: string | null;
    }>(
      `select cbm.id, cbm.campaign_id, cbm.batch_id,
              cbm.target_installment_id, cbm.due_date_text,
              cbm.processing_status, cbm.payment_status,
              cbm.total_pending_amount_cents::float8 as total_pending_amount_cents,
              cbm.installments_count, cbm.last_checked_at::text,
              cbm.processing_attempts, cbm.last_error,
              m.id as member_id, m.cpf, m.cpf_hash, m.name as member_name,
              m.external_user_code,
              b.name as batch_name, c.name as campaign_name,
              target.payment_description,
              target.payment_date_text
         from campaign_batch_members cbm
         join members m on m.id = cbm.member_id and m.deleted_at is null
         join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
         join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
         left join lateral (
           select mi.payment_description, mi.payment_date_text
             from member_installments mi
            where mi.campaign_batch_member_id = cbm.id
              and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
            order by mi.updated_at desc, mi.created_at desc, mi.id desc
            limit 1
         ) target on true
        where cbm.deleted_at is null
          and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
          and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
          and ($3::text is null or cbm.processing_status = $3)
        order by cbm.created_at desc, cbm.id asc`,
      [campaignIds, batchIds, status]
    );

    return result.rows.map((row) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      batch_id: row.batch_id,
      target_installment_id: row.target_installment_id,
      due_date_text: row.due_date_text,
      processing_status: row.processing_status,
      payment_status: row.payment_status,
      total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
      installments_count: Number(row.installments_count ?? 0),
      last_checked_at: row.last_checked_at,
      processing_attempts: Number(row.processing_attempts ?? 0),
      last_error: row.last_error,
      payment_description: row.payment_description?.trim() || null,
      payment_date_text: row.payment_date_text?.trim() || null,
      member: {
        id: row.member_id,
        cpf: row.cpf,
        cpf_hash: row.cpf_hash,
        name: row.member_name,
        external_user_code: row.external_user_code
      },
      batch: { id: row.batch_id, name: row.batch_name },
      campaign: { id: row.campaign_id, name: row.campaign_name }
    }));
  } catch (error) {
    return dataError("Nao foi possivel carregar os associados.", "getMembers", error);
  }
}

export async function getMemberDetail(campaignBatchMemberId: string): Promise<{
  link: MemberDetailLink;
  installments: MemberInstallmentRow[];
  planTotals: MemberPlanTotalRow[];
} | null> {
  try {
    const linkResult = await dbQuery<{
      id: string;
      campaign_id: string;
      batch_id: string;
      member_id: string;
      target_installment_id: string | null;
      due_date_text: string | null;
      installment_amount_cents: number;
      processing_status: string;
      payment_status: string | null;
      total_pending_amount_cents: number;
      installments_count: number;
      last_checked_at: string | null;
      processing_attempts: number;
      last_error: string | null;
      member_cpf: string | null;
      member_name: string | null;
      external_user_code: string | null;
      batch_name: string;
      campaign_name: string;
    }>(
      `select cbm.id, cbm.campaign_id, cbm.batch_id, cbm.member_id,
              cbm.target_installment_id, cbm.due_date_text,
              cbm.installment_amount_cents::float8 as installment_amount_cents,
              cbm.processing_status, cbm.payment_status,
              cbm.total_pending_amount_cents::float8 as total_pending_amount_cents,
              cbm.installments_count, cbm.last_checked_at::text,
              cbm.processing_attempts, cbm.last_error,
              m.cpf as member_cpf, m.name as member_name, m.external_user_code,
              b.name as batch_name, c.name as campaign_name
         from campaign_batch_members cbm
         join members m on m.id = cbm.member_id and m.deleted_at is null
         join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
         join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
        where cbm.id = $1 and cbm.deleted_at is null
        limit 1`,
      [campaignBatchMemberId]
    );

    const row = linkResult.rows[0];
    if (!row) return null;

    const relatedResult = await dbQuery<{
      id: string;
      target_installment_id: string | null;
      due_date_text: string | null;
      installment_amount_cents: number;
      processing_status: string;
      payment_status: string | null;
    }>(
      `select id, target_installment_id, due_date_text,
              installment_amount_cents::float8 as installment_amount_cents,
              processing_status, payment_status
         from campaign_batch_members
        where member_id = $1 and deleted_at is null`,
      [row.member_id]
    );

    const relatedIds = [...new Set([campaignBatchMemberId, ...relatedResult.rows.map((item) => item.id)])];

    const [installmentsResult, totalsResult] = await Promise.all([
      dbQuery<MemberInstallmentRow>(
        `select id, cod_usuario, cod_parcela, due_date_text, installment_type,
                boleto_code, pix_code, card_payment_link, situation,
                payment_description, payment_date_text,
                paid_amount_cents::float8 as paid_amount_cents,
                base_amount_cents::float8 as base_amount_cents,
                fine_amount_cents::float8 as fine_amount_cents,
                interest_amount_cents::float8 as interest_amount_cents,
                additional_amount_cents::float8 as additional_amount_cents,
                discount_amount_cents::float8 as discount_amount_cents,
                final_amount_cents::float8 as final_amount_cents,
                coalesce(plan_type, 'Não informado') as plan_type,
                observation, created_at::text
           from member_installments
          where campaign_batch_member_id = any($1::uuid[])
          order by due_date_text asc nulls last, created_at desc`,
        [relatedIds]
      ),
      dbQuery<MemberPlanTotalRow>(
        `select id, plan_type, installments_count,
                total_amount_cents::float8 as total_amount_cents
           from member_plan_totals
          where campaign_batch_member_id = $1
          order by plan_type asc`,
        [campaignBatchMemberId]
      )
    ]);

    const persistedCodes = new Set(
      installmentsResult.rows.map((installment) => String(installment.cod_parcela ?? "").trim()).filter(Boolean)
    );

    const synthetic: MemberInstallmentRow[] = relatedResult.rows
      .filter((item) => {
        const code = String(item.target_installment_id ?? "").trim();
        return Boolean(code) && !persistedCodes.has(code);
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
        situation: item.payment_status === "unpaid"
          ? "open"
          : item.payment_status ?? item.processing_status,
        payment_description: null,
        payment_date_text: null,
        paid_amount_cents: null,
        base_amount_cents: Number(item.installment_amount_cents ?? 0),
        fine_amount_cents: 0,
        interest_amount_cents: 0,
        additional_amount_cents: 0,
        discount_amount_cents: 0,
        final_amount_cents: Number(item.installment_amount_cents ?? 0),
        plan_type: "Não informado",
        observation: "Parcela de destino cadastrada para o associado.",
        created_at: null
      }));

    const installments = [...installmentsResult.rows, ...synthetic].sort((left, right) =>
      String(left.due_date_text ?? "9999-99-99").localeCompare(String(right.due_date_text ?? "9999-99-99"))
    );

    return {
      link: {
        id: row.id,
        campaign_id: row.campaign_id,
        batch_id: row.batch_id,
        member_id: row.member_id,
        target_installment_id: row.target_installment_id,
        due_date_text: row.due_date_text,
        installment_amount_cents: Number(row.installment_amount_cents ?? 0),
        processing_status: row.processing_status,
        payment_status: row.payment_status,
        total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
        installments_count: Number(row.installments_count ?? 0),
        last_checked_at: row.last_checked_at,
        processing_attempts: Number(row.processing_attempts ?? 0),
        last_error: row.last_error,
        member: {
          id: row.member_id,
          cpf: row.member_cpf,
          name: row.member_name,
          external_user_code: row.external_user_code
        },
        batch: { id: row.batch_id, name: row.batch_name },
        campaign: { id: row.campaign_id, name: row.campaign_name }
      },
      installments,
      planTotals: totalsResult.rows
    };
  } catch (error) {
    return dataError("Nao foi possivel carregar o associado.", "getMemberDetail", error);
  }
}
