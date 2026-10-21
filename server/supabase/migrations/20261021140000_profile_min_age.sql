-- Aplicado em produção em 21/10/2026.
-- Idade mínima de 18 anos também no banco (auditoria M-01): o cardápio tem
-- bebida alcoólica e um cadastro feito direto no Supabase Auth (chave pública)
-- não passa pela validação da API. O trigger barra perfil com data de
-- nascimento de menor, venha ela do cadastro (metadata) ou de uma edição.
-- Perfil sem data (login pelo Google) continua permitido: ele só faz pedido
-- depois de completar o cadastro pela API, que também confere a idade.
create or replace function public.enforce_profile_min_age()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if new.birth_date is not null
     and new.birth_date > ((now() at time zone 'America/Sao_Paulo')::date - interval '18 years') then
    raise exception 'underage' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_profile_min_age() from public, anon, authenticated;

drop trigger if exists profiles_min_age on public.profiles;
create trigger profiles_min_age
  before insert or update of birth_date on public.profiles
  for each row execute function public.enforce_profile_min_age();
