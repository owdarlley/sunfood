-- Aplicado em produção em 21/10/2026.
-- Limite de tentativas compartilhado (auditoria M-03). Na Vercel cada
-- instância da função tinha o próprio contador em memória, então o limite de
-- login/cadastro valia por instância e sumia a cada cold start. Agora o
-- contador fica aqui e vale para todas as instâncias. Só o servidor (service
-- role) chama; a tabela não tem policy, então anon/authenticated não leem.
create table if not exists public.rate_limits (
  key text primary key,
  hits integer not null,
  reset_at timestamptz not null
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- Conta uma tentativa para a chave e devolve o total na janela atual. Janela
-- vencida recomeça do 1. De vez em quando apaga chaves vencidas há um dia.
create or replace function public.rate_limit_hit(p_key text, p_window_ms integer)
 returns table(hits integer, reset_at timestamptz)
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if random() < 0.01 then
    delete from public.rate_limits r where r.reset_at < now() - interval '1 day';
  end if;
  return query
  insert into public.rate_limits as r (key, hits, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update set
    hits = case when r.reset_at <= now() then 1 else r.hits + 1 end,
    reset_at = case when r.reset_at <= now() then excluded.reset_at else r.reset_at end
  returning r.hits, r.reset_at;
end;
$function$;

-- Desfaz uma tentativa (o express-rate-limit chama em skipFailedRequests e afins).
create or replace function public.rate_limit_undo(p_key text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  update public.rate_limits set hits = greatest(hits - 1, 0) where key = p_key;
$function$;

create or replace function public.rate_limit_reset(p_key text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  delete from public.rate_limits where key = p_key;
$function$;

revoke all on function public.rate_limit_hit(text, integer) from public, anon, authenticated;
revoke all on function public.rate_limit_undo(text) from public, anon, authenticated;
revoke all on function public.rate_limit_reset(text) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer) to service_role;
grant execute on function public.rate_limit_undo(text) to service_role;
grant execute on function public.rate_limit_reset(text) to service_role;
