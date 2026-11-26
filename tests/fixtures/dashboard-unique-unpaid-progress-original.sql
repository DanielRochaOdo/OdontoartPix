with selected_targets as materialized (
       select distinct cbm.target_installment_ref_id as target_id
         from campaign_batch_members cbm
         join campaign_batches cb on cb.id = cbm.batch_id
         join campaigns c on c.id = cb.campaign_id
        where cbm.deleted_at is null
          and cb.deleted_at is null
          and c.deleted_at is null
          and cbm.target_installment_ref_id is not null
          and (cardinality($2::uuid[]) = 0 or c.id = any($2::uuid[]))
          and (cardinality($3::uuid[]) = 0 or cb.id = any($3::uuid[]))
     ), unpaid_targets as (
       select canonical.id
         from selected_targets selected
         join member_target_installments canonical on canonical.id = selected.target_id
        where canonical.payment_status = 'unpaid'
     )
     select count(*)::int as total,
            count(*) filter (
              where exists (
                select 1
                  from general_sync_run_installments checked
                 where checked.run_id = $1::uuid
                   and checked.target_installment_ref_id = unpaid_targets.id
              )
            )::int as processed
       from unpaid_targets
