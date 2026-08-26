import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDbPool } from "@/lib/db/pool";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

describeDatabase("paid pending database invariant", () => {
  it("preserva o saldo residual de pagamento explicito parcial", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const pool = getDbPool();

    const campaign = await pool.query<{ id: string }>(
      `insert into campaigns(name, status)
       values ($1, 'rascunho')
       returning id`,
      [`Paid pending ${suffix}`]
    );
    const campaignId = campaign.rows[0]!.id;

    const batch = await pool.query<{ id: string }>(
      `insert into campaign_batches(campaign_id, name, status)
       values ($1::uuid, $2, 'aguardando')
       returning id`,
      [campaignId, `Lote ${suffix}`]
    );
    const batchId = batch.rows[0]!.id;

    const member = await pool.query<{ id: string }>(
      `insert into members(cpf, cpf_hash, name, external_user_code)
       values ($1, $2, $3, $4)
       returning id`,
      [
        suffix.slice(0, 11),
        `hash-${suffix}`,
        `Associado ${suffix.slice(0, 6)}`,
        suffix.slice(0, 9)
      ]
    );
    const memberId = member.rows[0]!.id;

    try {
      const inserted = await pool.query<{
        id: string;
        total_pending_amount_cents: string;
      }>(
        `insert into campaign_batch_members(
           campaign_id,
           batch_id,
           member_id,
           target_installment_id,
           processing_status,
           payment_status,
           payment_status_source,
           installment_amount_cents,
           payment_amount_cents,
           total_pending_amount_cents
         ) values (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           '6591350',
           'completed',
           'paid',
           'erp_explicit',
           28800,
           20850,
           0
         )
         returning id, total_pending_amount_cents::text`,
        [campaignId, batchId, memberId]
      );

      const linkId = inserted.rows[0]!.id;
      expect(Number(inserted.rows[0]!.total_pending_amount_cents)).toBe(7950);

      const forcedZero = await pool.query<{ total_pending_amount_cents: string }>(
        `update campaign_batch_members
            set total_pending_amount_cents = 0,
                updated_at = now()
          where id = $1::uuid
          returning total_pending_amount_cents::text`,
        [linkId]
      );
      expect(Number(forcedZero.rows[0]!.total_pending_amount_cents)).toBe(7950);

      const fullyPaid = await pool.query<{ total_pending_amount_cents: string }>(
        `update campaign_batch_members
            set payment_amount_cents = 28800,
                total_pending_amount_cents = 999,
                updated_at = now()
          where id = $1::uuid
          returning total_pending_amount_cents::text`,
        [linkId]
      );
      expect(Number(fullyPaid.rows[0]!.total_pending_amount_cents)).toBe(0);
    } finally {
      await pool.query(`delete from campaigns where id = $1::uuid`, [campaignId]);
      await pool.query(`delete from members where id = $1::uuid`, [memberId]);
    }
  });

  it("nao reinterpreta pagamentos que nao vieram da verdade explicita do ERP", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const pool = getDbPool();

    const campaign = await pool.query<{ id: string }>(
      `insert into campaigns(name, status)
       values ($1, 'rascunho')
       returning id`,
      [`Administrative payment ${suffix}`]
    );
    const campaignId = campaign.rows[0]!.id;

    const batch = await pool.query<{ id: string }>(
      `insert into campaign_batches(campaign_id, name, status)
       values ($1::uuid, $2, 'aguardando')
       returning id`,
      [campaignId, `Lote ${suffix}`]
    );
    const batchId = batch.rows[0]!.id;

    const member = await pool.query<{ id: string }>(
      `insert into members(cpf, cpf_hash, name, external_user_code)
       values ($1, $2, $3, $4)
       returning id`,
      [
        suffix.slice(0, 11),
        `hash-${suffix}`,
        `Associado ${suffix.slice(0, 6)}`,
        suffix.slice(0, 9)
      ]
    );
    const memberId = member.rows[0]!.id;

    try {
      const inserted = await pool.query<{ total_pending_amount_cents: string }>(
        `insert into campaign_batch_members(
           campaign_id,
           batch_id,
           member_id,
           processing_status,
           payment_status,
           payment_status_source,
           installment_amount_cents,
           payment_amount_cents,
           total_pending_amount_cents
         ) values (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'completed',
           'paid',
           'administrative',
           28800,
           0,
           0
         )
         returning total_pending_amount_cents::text`,
        [campaignId, batchId, memberId]
      );

      expect(Number(inserted.rows[0]!.total_pending_amount_cents)).toBe(0);
    } finally {
      await pool.query(`delete from campaigns where id = $1::uuid`, [campaignId]);
      await pool.query(`delete from members where id = $1::uuid`, [memberId]);
    }
  });
});
