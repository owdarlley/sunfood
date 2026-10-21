-- Teste no banco (Supabase) das categorias editáveis. Roda tudo e no fim dá
-- erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica renomeado ou apagado.
-- Passou = a mensagem de erro começa com TESTE_CATEGORIAS_PASSOU.
do $t$
declare n int; pid uuid;
begin
  select count(*) into n from categories; if n < 4 then raise exception 'FALHA seed %', n; end if;
  update categories set name = 'Petiscos' where name = 'Lanches';
  if exists (select 1 from products where category = 'Lanches') then raise exception 'FALHA cascade'; end if;
  if not exists (select 1 from products where category = 'Petiscos') then raise exception 'FALHA cascade2'; end if;
  begin delete from categories where name = 'Petiscos'; raise exception 'FALHA delete em uso';
  exception when check_violation then null; end;
  begin insert into categories(name) values ('bebidas'); raise exception 'FALHA dup';
  exception when unique_violation then null; end;
  begin insert into products(name, price, category) values ('X', 1, 'Nada'); raise exception 'FALHA fk';
  exception when foreign_key_violation then null; end;
  insert into categories(name, position, color) values ('Porções', 9, 'verde');
  insert into products(name, price, category, archived_at) values ('Velho', 1, 'Porções', now()) returning id into pid;
  delete from categories where name = 'Porções';
  if (select category from products where id = pid) is not null then raise exception 'FALHA set null'; end if;
  perform reorder_categories(array(select name from categories order by name desc));
  if (select name from categories order by position limit 1) <> (select max(name) from categories) then raise exception 'FALHA ordem'; end if;
  begin perform reorder_categories(array['Bebidas']); raise exception 'FALHA mismatch';
  exception when others then if sqlerrm not like '%category_list_mismatch%' then raise; end if; end;
  -- posição 0 = fim da lista, calculada pelo banco
  insert into categories(name) values ('Drinks') returning position into n;
  if n <> (select max(position) from categories) or (select count(*) from categories where position = n) <> 1 then
    raise exception 'FALHA posição automática %', n; end if;
  -- a última categoria não sai
  update products set archived_at = now() where archived_at is null;
  delete from categories where name <> 'Bebidas';
  begin delete from categories where name = 'Bebidas'; raise exception 'FALHA apagou a última';
  exception when check_violation then if sqlerrm <> 'last_category' then raise; end if; end;
  raise exception 'TESTE_CATEGORIAS_PASSOU';
end $t$;
