do $$
begin
  if to_regprocedure('extensions.digest(text,text)') is null then
    raise exception using
      errcode = '42883',
      message = 'extensions.digest(text,text) nao foi localizado';
  end if;
end;
$$;

alter function public.persist_processing_wave_v1(
  uuid,
  uuid,
  uuid,
  uuid,
  jsonb
)
set search_path = public, extensions, pg_temp;
