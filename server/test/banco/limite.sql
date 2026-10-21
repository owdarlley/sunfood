-- Teste no banco (Supabase) do contador compartilhado do limite de tentativas.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_LIMITE_PASSOU.
do $$
declare
  h int; r timestamptz; r1 timestamptz;
begin
  select hits, reset_at into h, r1 from rate_limit_hit('login:1.2.3.4', 60000);
  if h <> 1 or r1 <= now() then raise exception 'FALHA primeira tentativa %', h; end if;
  select hits, reset_at into h, r from rate_limit_hit('login:1.2.3.4', 60000);
  if h <> 2 or r <> r1 then raise exception 'FALHA segunda tentativa % %', h, r; end if;
  select hits into h from rate_limit_hit('login:5.6.7.8', 60000);
  if h <> 1 then raise exception 'FALHA chaves misturadas'; end if;

  perform rate_limit_undo('login:1.2.3.4');
  if (select hits from rate_limits where key = 'login:1.2.3.4') <> 1 then raise exception 'FALHA undo'; end if;

  -- janela vencida recomeça do 1
  update rate_limits set reset_at = now() - interval '1 second' where key = 'login:1.2.3.4';
  select hits, reset_at into h, r from rate_limit_hit('login:1.2.3.4', 60000);
  if h <> 1 or r <= now() then raise exception 'FALHA janela vencida %', h; end if;

  perform rate_limit_reset('login:1.2.3.4');
  if exists (select 1 from rate_limits where key = 'login:1.2.3.4') then raise exception 'FALHA reset'; end if;

  -- só o servidor: anon/authenticated não chamam nem leem
  if has_function_privilege('anon', 'public.rate_limit_hit(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer)', 'execute')
     or has_table_privilege('authenticated', 'public.rate_limits', 'select') then
    raise exception 'FALHA aberto para o público'; end if;

  raise exception 'TESTE_LIMITE_PASSOU: contagem OK; undo OK; janela OK; reset OK; fechado OK';
end;
$$;
