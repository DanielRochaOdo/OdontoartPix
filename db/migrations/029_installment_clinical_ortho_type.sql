-- Classificacao operacional/comercial ligada a obrigacao financeira canonica.
-- O valor e unico por associado + parcela e pode ser Clinico ou Orto.
-- Registros historicos permanecem sem classificacao ate serem informados em uma nova importacao.

alter table member_target_installments
  add column if not exists installment_type text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'member_target_installments_type_check'
       and conrelid = 'member_target_installments'::regclass
  ) then
    alter table member_target_installments
      add constraint member_target_installments_type_check
      check (installment_type is null or installment_type in ('clinico', 'orto'));
  end if;
end;
$$;

create index if not exists member_target_installments_type_idx
  on member_target_installments(installment_type)
  where installment_type is not null;

comment on column member_target_installments.installment_type is
  'Classificacao canonica da parcela: clinico ou orto. Nulo apenas para dados historicos ainda nao classificados.';

insert into schema_migrations(version, name)
values (29, 'installment_clinical_ortho_type')
on conflict (version) do nothing;
