-- Teste no banco (Supabase) dos privilégios das funções e do trigger de papel.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_PRIVILEGIOS_PASSOU.
do $$
declare
  abertas text; log text := '';
begin
  -- 1. nenhuma função SECURITY DEFINER do public aberta para anon/authenticated
  --    (exceto as três que as policies de RLS usam)
  select string_agg(distinct p.proname || ' (' || r || ')', ', ') into abertas
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(array['anon', 'authenticated']) r
  where n.nspname = 'public' and p.prosecdef
    and has_function_privilege(r, p.oid, 'execute')
    and not (r = 'authenticated' and p.proname in ('current_role', 'is_admin', 'is_staff'));
  if abertas is not null then raise exception 'FALHA funções abertas: %', abertas; end if;
  log := log || 'funções OK; ';

  -- 2. anon/authenticated sem escrita em nenhuma tabela do public
  select string_agg(distinct table_name || ' ' || privilege_type || ' (' || grantee || ')', ', ') into abertas
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if abertas is not null then raise exception 'FALHA escrita aberta: %', abertas; end if;
  log := log || 'tabelas OK; ';

  -- 3. trigger que impede trocar o próprio papel existe
  if not exists (select 1 from pg_trigger
                 where tgfoid = 'public.prevent_role_self_escalation'::regproc
                   and tgrelid = 'public.profiles'::regclass) then
    raise exception 'FALHA trigger prevent_role_self_escalation ausente'; end if;
  log := log || 'trigger de papel OK';

  raise exception 'TESTE_PRIVILEGIOS_PASSOU: %', log;
end;
$$;
