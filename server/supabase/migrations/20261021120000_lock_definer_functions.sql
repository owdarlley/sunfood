-- Aplicado em produção em 21/10/2026. Na verificação, nenhuma função de
-- escrita estava aberta (já tinham sido fechadas pelo painel); faltava isto
-- no repositório e o padrão para as próximas.
-- Fecha as funções SECURITY DEFINER do schema public para quem fala direto com
-- o Supabase (/rest/v1/rpc) usando a chave pública ou o token de um usuário.
-- Só a API (service role) chama create_order, close_day, ops_metrics e as
-- demais. Ficam de fora current_role, is_admin e is_staff, que as policies de
-- RLS usam com o papel authenticated.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname not in ('current_role', 'is_admin', 'is_staff')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Funções e sequências criadas daqui em diante também nascem fechadas
-- (o padrão do Supabase dava EXECUTE e USAGE para anon e authenticated).
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, update on sequences from anon, authenticated;

-- O trigger de prevent_role_self_escalation existia em produção, criado pelo
-- painel; fica aqui para o banco poder ser recriado a partir do repositório.
drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();
