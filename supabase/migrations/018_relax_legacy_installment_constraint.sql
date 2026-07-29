-- The current normalized contract stores the installment identifier in
-- cod_parcela. Keep the legacy column for compatibility, but do not require
-- it on inserts from the current processing RPC.
alter table if exists public.member_installments
  alter column external_installment_code drop not null;
