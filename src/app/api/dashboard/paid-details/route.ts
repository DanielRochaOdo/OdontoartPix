import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const IdsSchema = z.array(z.string().uuid()).max(100);

type PaidDetailRow = {
  id: string;
  updated_at: string;
  member_name: string | null;
  cpf: string | null;
  associated_code: string | null;
  campaign_name: string | null;
  batch_name: string | null;
  invoice_code: string | null;
  invoice_amount_cents: string | number;
  paid_amount_cents: string | number;
  payment_description: string | null;
};

type CountRow = { total: number };

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const campaignIds = IdsSchema.safeParse((params.get("campaignIds") ?? "").split(",").filter(Boolean));
  const batchIds = IdsSchema.safeParse((params.get("batchIds") ?? "").split(",").filter(Boolean));
  const startedAt = params.get("startedAt");
  const since = params.get("since");
  const requestedLimit = Number(params.get("limit") ?? 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 100;

  if (!campaignIds.success || !batchIds.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos.", 400);
  }

  const values: unknown[] = [];
  const where: string[] = [
    "cbm.deleted_at is null",
    "target.id is not null",
    "target.paid_amount_cents is not null",
    "nullif(trim(target.payment_description), '') is not null",
    "upper(trim(target.payment_description)) <> 'ABERTO'"
  ];

  if (campaignIds.data.length > 0) {
    values.push(campaignIds.data);
    where.push(`cbm.campaign_id = any($${values.length}::uuid[])`);
  }
  if (batchIds.data.length > 0) {
    values.push(batchIds.data);
    where.push(`cbm.batch_id = any($${values.length}::uuid[])`);
  }
  if (startedAt) {
    values.push(startedAt);
    where.push(`coalesce(cbm.last_checked_at, cbm.updated_at) >= $${values.length}::timestamptz`);
  }
  if (since) {
    values.push(since);
    where.push(`(cbm.last_checked_at > $${values.length}::timestamptz or cbm.updated_at > $${values.length}::timestamptz)`);
  }

  values.push(limit);
  const limitParam = `$${values.length}`;

  try {
    const result = await dbQuery<PaidDetailRow>(
      `select
         cbm.id,
         coalesce(cbm.last_checked_at, cbm.updated_at)::text as updated_at,
         m.name as member_name,
         m.cpf,
         m.external_user_code as associated_code,
         c.name as campaign_name,
         b.name as batch_name,
         coalesce(target.cod_parcela, cbm.target_installment_id) as invoice_code,
         coalesce(target.base_amount_cents, cbm.installment_amount_cents, 0)::bigint::text as invoice_amount_cents,
         coalesce(target.paid_amount_cents, 0)::bigint::text as paid_amount_cents,
         nullif(trim(target.payment_description), '') as payment_description
       from campaign_batch_members cbm
       join members m on m.id = cbm.member_id
       join campaigns c on c.id = cbm.campaign_id
       join campaign_batches b on b.id = cbm.batch_id
       left join lateral (
         select mi.id,
                mi.cod_parcela,
                mi.base_amount_cents,
                mi.paid_amount_cents,
                mi.payment_description
           from member_installments mi
          where mi.campaign_batch_member_id = cbm.id
            and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
          order by mi.updated_at desc, mi.created_at desc, mi.id desc
          limit 1
       ) target on true
       where ${where.join("\n         and ")}
       order by cbm.last_checked_at desc nulls last, cbm.updated_at desc, cbm.id
       limit ${limitParam}`,
      values
    );

    const details = result.rows.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      memberName: row.member_name,
      cpf: row.cpf,
      associatedCode: row.associated_code,
      campaignName: row.campaign_name,
      batchName: row.batch_name,
      invoiceCode: row.invoice_code,
      invoiceAmountCents: Number(row.invoice_amount_cents ?? 0),
      paidAmountCents: Number(row.paid_amount_cents ?? 0),
      paymentDescription: row.payment_description
    }));

    let baselineValue: number | null = null;
    if (startedAt) {
      const baselineValues: unknown[] = [startedAt];
      const baselineWhere = [
        "cbm.deleted_at is null",
        "cbm.updated_at < $1::timestamptz",
        `exists (
          select 1
            from member_installments mi
           where mi.campaign_batch_member_id = cbm.id
             and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
             and mi.paid_amount_cents is not null
             and nullif(trim(mi.payment_description), '') is not null
             and upper(trim(mi.payment_description)) <> 'ABERTO'
        )`
      ];

      if (campaignIds.data.length > 0) {
        baselineValues.push(campaignIds.data);
        baselineWhere.push(`cbm.campaign_id = any($${baselineValues.length}::uuid[])`);
      }
      if (batchIds.data.length > 0) {
        baselineValues.push(batchIds.data);
        baselineWhere.push(`cbm.batch_id = any($${baselineValues.length}::uuid[])`);
      }

      const baseline = await dbQuery<CountRow>(
        `select count(*)::int as total
           from campaign_batch_members cbm
          where ${baselineWhere.join("\n            and ")}`,
        baselineValues
      );
      baselineValue = baseline.rows[0]?.total ?? 0;
    }

    return ok({ items: details, baselineValue });
  } catch (error) {
    console.error("[DASHBOARD_PAID_DETAILS_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar os pagamentos recentes.", 500);
  }
}
