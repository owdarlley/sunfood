-- Categorias do cardápio editáveis pelo admin (antes eram fixas: Bebidas,
-- Lanches, Pratos e Sobremesas, presas num CHECK da tabela products).
-- O nome é a chave: products.category continua guardando o nome, então quem
-- já lê o cardápio não muda nada. Renomear propaga pros produtos (on update
-- cascade).
create table if not exists public.categories (
  name text primary key,
  position integer not null default 0,
  color text not null default 'areia',
  created_at timestamptz not null default now(),
  constraint categories_name_check check (name = btrim(name) and char_length(name) between 2 and 40),
  constraint categories_color_check check (color in ('mar', 'sol', 'coral', 'uva', 'verde', 'areia'))
);

-- "pratos" e "Pratos" seriam a mesma categoria pra quem lê o cardápio.
create unique index if not exists categories_name_lower_key on public.categories (lower(name));

-- Só a API (service role) lê e grava; sem policy, ninguém acessa direto.
alter table public.categories enable row level security;

insert into public.categories (name, position, color) values
  ('Bebidas', 1, 'mar'), ('Lanches', 2, 'sol'), ('Pratos', 3, 'coral'), ('Sobremesas', 4, 'uva')
on conflict do nothing;

-- Qualquer outra categoria que já esteja em uso vira uma categoria de verdade.
insert into public.categories (name, position)
select distinct category, 100 from public.products where category is not null
on conflict do nothing;

alter table public.products drop constraint if exists products_category_check;

-- Excluir uma categoria só é possível sem itens ativos nela: os arquivados
-- (que já saíram do cardápio) ficam sem categoria, o que o CHECK abaixo só
-- permite pra arquivados. Item ativo numa categoria excluída = erro.
alter table public.products alter column category drop not null;
alter table public.products drop constraint if exists products_category_active_check;
alter table public.products add constraint products_category_active_check
  check (category is not null or archived_at is not null);

alter table public.products drop constraint if exists products_category_fkey;
alter table public.products add constraint products_category_fkey
  foreign key (category) references public.categories (name) on update cascade on delete set null;
create index if not exists products_category_idx on public.products (category);

-- Nova ordem das categorias de uma vez (a lista inteira, na ordem da tela).
create or replace function public.reorder_categories(p_names text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from categories) <> coalesce(array_length(p_names, 1), 0)
     or exists (select 1 from categories c where not c.name = any (p_names)) then
    raise exception 'category_list_mismatch';
  end if;
  update categories c set position = o.pos
    from unnest(p_names) with ordinality as o(name, pos)
   where c.name = o.name;
end;
$$;

revoke all on function public.reorder_categories(text[]) from public, anon, authenticated;
grant execute on function public.reorder_categories(text[]) to service_role;
