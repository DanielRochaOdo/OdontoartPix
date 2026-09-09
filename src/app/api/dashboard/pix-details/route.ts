import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const IdsSchema = z.array(z.string().uuid()).max(100);

type PixDetailRow = {
  installmentCount: number;
  memberCount: number;
};

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const campaignIds = IdsSchema.safeParse(
    (params.get("campaignIds") ?? "").split(",").filter(Boolean)
  );
  const batchIds = IdsSchema.safeParse(
    (params.get("batchIds") ?? "").split(",").filter(Boolean)
  );

  if (!campaignIds.success || !batchIds.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos.", 400);
  }

  try {
    const result = await dbQuery<PixDetailRow>(
      `with scoped_targets as (
         select distinct cbm.target_installment_ref_id
           from campaign_batch_members cbm
           join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
           join campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
          where cbm.deleted_at is null
            and cbm.target_installment_ref_id is not null
            and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
            and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
       ), selected as (
         select
           canonical.member_id,
           canonical.paid_amount_cents,
           nullif(trim(canonical.payment_description), '') as payment_description
         from scoped_targets
         join member_target_installments canonical
           on canonical.id = scoped_targets.target_installment_ref_id
       )
       select
         count(*)::int as "installmentCount",
         count(distinct member_id)::int as "memberCount"
       from selected
       where paid_amount_cents is not null
         and payment_description is not null
         and upper(payment_description) <> 'ABERTO'
         and upper(trim(payment_description)) in (
           'PIX',
           'PIX - CLINICO',
           'PIX - ORTODONTIA',
           'PIX NEW ODONTO - P4X',
           'PIX NEW ODONTOLOGIA - P4X',
           'PIX ODONTOART - P4X',
           'PIX RECORRENTE ODONTOART - P4X'
         )`,
      [campaignIds.data, batchIds.data]
    );

    const row = result.rows[0];
    return ok({
      installmentCount: Number(row?.installmentCount ?? 0),
      memberCount: Number(row?.memberCount ?? 0)
    });
  } catch (error) {
    console.error("[DASHBOARD_PIX_DETAILS_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar os detalhes do Pix.", 500);
  }
}
