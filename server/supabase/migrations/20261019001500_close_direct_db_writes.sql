-- Fecha a escrita direta pela API REST do Supabase (/rest/v1).
-- O app só fala com o banco pela API do Sunfood (service role).
-- Aplicado em produção em 19/10/2026.

revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon, authenticated;
revoke usage, update on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- Papel só muda pela service role (API) ou pelo painel.
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    new.role := old.role;
  end if;
  return new;
end;
$$;

revoke execute on function public.current_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.current_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_staff() to authenticated;
revoke execute on function public.delete_own_account() from public, anon, authenticated;

-- Ainda não aplicado em produção (sem efeito depois dos revokes acima):
-- drop policy if exists "profiles: update own" on public.profiles;
-- drop policy if exists "products: staff can write" on public.products;
-- drop policy if exists "kiosk_settings: staff can write" on public.kiosk_settings;
-- drop policy if exists "kiosk_tables: staff can write" on public.kiosk_tables;
-- drop extension if exists pg_net;
