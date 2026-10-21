-- Aplicado em produção em 21/10/2026.
-- Categorias sem janela de corrida (auditoria B-09). A API calculava a posição
-- da nova categoria lendo a maior e somando 1, e conferia "não é a última"
-- antes de apagar; dois admins ao mesmo tempo podiam repetir a posição ou
-- apagar as duas últimas. Agora o banco faz as duas coisas sob uma trava.
create or replace function public.categories_guard()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  perform pg_advisory_xact_lock(hashtext('public.categories'));
  if tg_op = 'INSERT' then
    -- posição 0 = "no fim da lista"
    if new.position = 0 then
      select coalesce(max(c.position), 0) + 1 into new.position from public.categories c;
    end if;
    return new;
  end if;
  if (select count(*) from public.categories) <= 1 then
    raise exception 'last_category' using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;

revoke all on function public.categories_guard() from public, anon, authenticated;

drop trigger if exists categories_guard on public.categories;
create trigger categories_guard
  before insert or delete on public.categories
  for each row execute function public.categories_guard();

-- Reordenar usa a mesma trava: a lista conferida não muda no meio.
create or replace function public.reorder_categories(p_names text[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform pg_advisory_xact_lock(hashtext('public.categories'));
  if (select count(*) from categories) <> coalesce(array_length(p_names, 1), 0)
     or exists (select 1 from categories c where not c.name = any (p_names)) then
    raise exception 'category_list_mismatch';
  end if;
  update categories c set position = o.pos
    from unnest(p_names) with ordinality as o(name, pos)
   where c.name = o.name;
end;
$function$;
