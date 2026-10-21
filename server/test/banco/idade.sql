-- Teste no banco (Supabase) da idade mínima de 18 anos no perfil.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_IDADE_PASSOU.
do $$
declare
  ok boolean; a uuid; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select id into a from profiles where role = 'cliente' order by created_at limit 1;

  ok := false;
  begin update profiles set birth_date = hoje - interval '17 years' where id = a;
  exception when check_violation then ok := sqlerrm = 'underage'; end;
  if not ok then raise exception 'FALHA perfil aceitou menor de 18'; end if;

  update profiles set birth_date = hoje - interval '18 years' where id = a;
  update profiles set birth_date = null where id = a;

  -- cadastro direto no Auth com data de menor no metadata também é barrado
  ok := false;
  begin
    insert into auth.users (id, email, raw_user_meta_data)
    values (gen_random_uuid(), 'menor@teste.com', jsonb_build_object('birth_date', (hoje - interval '15 years')::date));
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA cadastro de menor pelo Auth aceito'; end if;

  raise exception 'TESTE_IDADE_PASSOU: menor recusado OK; 18 anos aceito OK; cadastro direto barrado OK';
end;
$$;
