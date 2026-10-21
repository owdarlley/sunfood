-- Schema public do Sunfood: retrato do banco de produção em 21/10/2026
-- (auditoria A-05). Serve para recriar o banco do zero (staging, desastre) e
-- para revisar policies e funções pelo código. As migrações em migrations/
-- continuam sendo o histórico das mudanças; este arquivo é o resultado delas
-- somado ao que foi criado direto pelo painel antes de existirem migrações.
--
-- Recriar: num projeto Supabase novo, rode este arquivo inteiro no SQL Editor.
-- Depois de cada migração nova, atualize este retrato junto.

-- ---------------------------------------------------------------------------
-- Funções usadas por constraints e policies (precisam existir antes das tabelas)
-- ---------------------------------------------------------------------------

create or replace function public.is_valid_cpf(cpf text)
 returns boolean
 language plpgsql
 immutable
 set search_path to ''
as $function$
declare
  len int;
  i int;
  total int;
  digit int;
begin
  if cpf is null or cpf !~ '^[0-9]{11}$' or cpf ~ '^(.)\1{10}$' then
    return false;
  end if;
  foreach len in array array[9, 10] loop
    total := 0;
    for i in 1..len loop
      total := total + substr(cpf, i, 1)::int * (len + 2 - i);
    end loop;
    digit := (total * 10 % 11) % 10;
    if digit <> substr(cpf, len + 1, 1)::int then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid not null,
  email text not null,
  name text not null default ''::text,
  role text not null default 'cliente'::text,
  created_at timestamp with time zone not null default now(),
  phone text,
  birth_date date,
  terms_accepted_at timestamp with time zone,
  cpf text,
  avatar_path text,
  avatar_preset text,
  notify_ready boolean not null default true,
  sound_on boolean not null default true,
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade,
  constraint profiles_avatar_path_valid check (((avatar_path is null) or (avatar_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$'::text))),
  constraint profiles_avatar_preset_valid check (((avatar_preset is null) or (avatar_preset = any (array['sol'::text, 'onda'::text, 'coco'::text, 'abacaxi'::text, 'peixe'::text, 'concha'::text, 'palmeira'::text, 'picole'::text])))),
  constraint profiles_cpf_valid check (((cpf is null) or public.is_valid_cpf(cpf))),
  constraint profiles_role_check check ((role = any (array['cliente'::text, 'admin'::text, 'cozinha'::text, 'garcom'::text])))
);

create table public.categories (
  name text not null,
  "position" integer not null default 0,
  color text not null default 'areia'::text,
  created_at timestamp with time zone not null default now(),
  constraint categories_pkey primary key (name),
  constraint categories_color_check check ((color = any (array['mar'::text, 'sol'::text, 'coral'::text, 'uva'::text, 'verde'::text, 'areia'::text]))),
  constraint categories_name_check check (((name = btrim(name)) and ((char_length(name) >= 2) and (char_length(name) <= 40))))
);

create table public.products (
  id uuid not null default gen_random_uuid(),
  name text not null,
  description text not null default ''::text,
  price numeric(10,2) not null,
  category text,
  mark text not null default 'coco'::text,
  sold_out boolean not null default false,
  created_at timestamp with time zone not null default now(),
  long_description text not null default ''::text,
  portion text not null default ''::text,
  prep_time text not null default ''::text,
  kcal text not null default ''::text,
  rating text not null default ''::text,
  review_count text not null default ''::text,
  ingredients text not null default ''::text,
  tags jsonb not null default '[]'::jsonb,
  updated_at timestamp with time zone not null default now(),
  stock_qty integer,
  image_url text,
  archived_at timestamp with time zone,
  constraint products_pkey primary key (id),
  constraint products_category_fkey foreign key (category) references public.categories(name) on update cascade on delete set null,
  constraint products_category_active_check check (((category is not null) or (archived_at is not null))),
  constraint products_price_check check ((price > (0)::numeric)),
  constraint products_stock_qty_check check (((stock_qty is null) or (stock_qty >= 0)))
);

create table public.kiosk_settings (
  id integer not null default 1,
  paused boolean not null default false,
  day_closed boolean not null default false,
  cancel_window_minutes integer not null default 0,
  min_order_cents integer not null default 1000,
  location_name text not null default 'Quiosque Sunfood · Praia do Forte'::text,
  location_address text not null default 'Av. Beira-Mar, s/n, em frente ao posto 4'::text,
  location_hours text not null default 'Aberto todos os dias, 9h às 18h.'::text,
  table_count integer not null default 12,
  min_order_enabled boolean not null default true,
  constraint kiosk_settings_pkey primary key (id),
  constraint kiosk_settings_cancel_window_minutes_check check (((cancel_window_minutes >= 0) and (cancel_window_minutes <= 120))),
  constraint kiosk_settings_location_address_check check (((char_length(btrim(location_address)) >= 1) and (char_length(btrim(location_address)) <= 200))),
  constraint kiosk_settings_location_hours_check check ((char_length(location_hours) <= 120)),
  constraint kiosk_settings_location_name_check check (((char_length(btrim(location_name)) >= 1) and (char_length(btrim(location_name)) <= 80))),
  constraint kiosk_settings_min_order_cents_check check ((min_order_cents >= 0)),
  constraint kiosk_settings_singleton check ((id = 1)),
  constraint kiosk_settings_table_count_check check (((table_count >= 1) and (table_count <= 500)))
);

create table public.kiosk_tables (
  id uuid not null default gen_random_uuid(),
  number integer not null,
  active boolean not null default true,
  seats integer not null default 4,
  constraint kiosk_tables_number_key unique (number),
  constraint kiosk_tables_pkey primary key (id)
);

create table public.orders (
  id uuid not null default gen_random_uuid(),
  customer_id uuid,
  table_number integer not null,
  status text not null default 'Na Fila'::text,
  subtotal numeric(10,2) not null,
  fee numeric(10,2) not null,
  total numeric(10,2) not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  note text not null default ''::text,
  payment_provider text,
  payment_id text,
  payment_status text not null default 'pending'::text,
  payment_method text not null default 'pix'::text,
  received_with text,
  received_at timestamp with time zone,
  waiter_id uuid,
  delivered_by uuid,
  delivered_at timestamp with time zone,
  order_day date not null,
  daily_number integer not null,
  refunded_amount numeric(10,2) not null default 0,
  received_by uuid,
  constraint orders_pkey primary key (id),
  constraint orders_customer_id_fkey foreign key (customer_id) references public.profiles(id) on delete set null,
  constraint orders_delivered_by_fkey foreign key (delivered_by) references public.profiles(id) on delete set null,
  constraint orders_received_by_fkey foreign key (received_by) references public.profiles(id) on delete set null,
  constraint orders_table_number_fkey foreign key (table_number) references public.kiosk_tables(number),
  constraint orders_waiter_id_fkey foreign key (waiter_id) references public.profiles(id) on delete set null,
  constraint orders_payment_method_check check ((payment_method = any (array['pix'::text, 'cartao'::text, 'entrega'::text]))),
  constraint orders_payment_status_check check ((payment_status = any (array['pending'::text, 'approved'::text, 'rejected'::text, 'refunded'::text, 'cancelled'::text]))),
  constraint orders_received_with_check check (((received_with is null) or (received_with = any (array['dinheiro'::text, 'cartao'::text, 'pix'::text])))),
  constraint orders_refunded_amount_check check ((refunded_amount >= (0)::numeric)),
  constraint orders_status_check check ((status = any (array['Na Fila'::text, 'Em Preparo'::text, 'Pronto'::text, 'Entregue'::text, 'Cancelado'::text])))
);

create table public.order_items (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  product_id uuid,
  name text not null,
  price numeric(10,2) not null,
  qty integer not null,
  note text not null default ''::text,
  constraint order_items_pkey primary key (id),
  constraint order_items_order_id_fkey foreign key (order_id) references public.orders(id) on delete cascade,
  constraint order_items_product_id_fkey foreign key (product_id) references public.products(id)
);

create table public.order_status_log (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  status text not null,
  changed_at timestamp with time zone not null default now(),
  constraint order_status_log_pkey primary key (id),
  constraint order_status_log_order_id_fkey foreign key (order_id) references public.orders(id) on delete cascade
);

create table public.order_refunds (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  amount numeric(10,2) not null,
  reason text not null default ''::text,
  provider text not null,
  provider_refund_id text,
  actor uuid,
  created_at timestamp with time zone not null default now(),
  items jsonb not null default '[]'::jsonb,
  constraint order_refunds_pkey primary key (id),
  constraint order_refunds_actor_fkey foreign key (actor) references public.profiles(id) on delete set null,
  constraint order_refunds_order_id_fkey foreign key (order_id) references public.orders(id) on delete cascade,
  constraint order_refunds_amount_check check ((amount > (0)::numeric))
);

create table public.day_reports (
  id uuid not null default gen_random_uuid(),
  closed_at timestamp with time zone not null default now(),
  total_revenue numeric not null,
  total_orders integer not null,
  avg_ticket numeric not null,
  top_products jsonb not null default '[]'::jsonb,
  constraint day_reports_pkey primary key (id)
);

create table public.contact_messages (
  id uuid not null default gen_random_uuid(),
  protocol text not null,
  name text not null,
  contact text not null,
  reason text not null,
  message text not null,
  status text not null default 'novo'::text,
  created_at timestamp with time zone not null default now(),
  reply text,
  reply_channel text,
  replied_at timestamp with time zone,
  constraint contact_messages_protocol_key unique (protocol),
  constraint contact_messages_pkey primary key (id),
  constraint contact_messages_contact_check check (((char_length(contact) >= 5) and (char_length(contact) <= 160))),
  constraint contact_messages_message_check check (((char_length(message) >= 10) and (char_length(message) <= 2000))),
  constraint contact_messages_name_check check (((char_length(name) >= 2) and (char_length(name) <= 120))),
  constraint contact_messages_reply_channel_check check (((reply_channel is null) or (reply_channel = any (array['email'::text, 'whatsapp'::text])))),
  constraint contact_messages_reply_check check (((reply is null) or ((char_length(reply) >= 2) and (char_length(reply) <= 4000)))),
  constraint contact_messages_status_check check ((status = any (array['novo'::text, 'respondido'::text])))
);

-- Contador do limite de tentativas, compartilhado entre as instâncias da API
-- (auditoria M-03). Só o servidor usa, pelas funções rate_limit_*.
create table public.rate_limits (
  key text primary key,
  hits integer not null,
  reset_at timestamptz not null
);

insert into public.kiosk_settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------

create index contact_messages_created_at_idx on public.contact_messages using btree (created_at desc);
create index order_items_order_id_idx on public.order_items using btree (order_id);
create index order_items_product_id_idx on public.order_items using btree (product_id);
create index order_refunds_order_id_idx on public.order_refunds using btree (order_id);
create index order_status_log_order_id_idx on public.order_status_log using btree (order_id);
create index orders_customer_id_idx on public.orders using btree (customer_id);
create index orders_delivered_by_idx on public.orders using btree (delivered_by) where (delivered_by is not null);
create index orders_status_idx on public.orders using btree (status);
create index orders_table_number_idx on public.orders using btree (table_number);
create index orders_waiter_id_idx on public.orders using btree (waiter_id) where (waiter_id is not null);
create index products_category_idx on public.products using btree (category);
create unique index categories_name_lower_key on public.categories using btree (lower(name));
create unique index order_refunds_provider_refund_id_key on public.order_refunds using btree (provider_refund_id) where (provider_refund_id is not null);
create unique index orders_day_number_key on public.orders using btree (order_day, daily_number);
create unique index profiles_cpf_key on public.profiles using btree (cpf) where (cpf is not null);

-- ---------------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------------

create or replace function public."current_role"()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select role from public.profiles where id = auth.uid();
$function$;

create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(public.current_role() = 'admin', false);
$function$;

create or replace function public.is_staff()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(public.current_role() in ('admin', 'cozinha'), false);
$function$;

-- Cria o perfil quando a conta nasce no Supabase Auth (cadastro ou Google).
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, name, phone, cpf, birth_date, terms_accepted_at)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'name', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'phone',
    nullif(new.raw_user_meta_data->>'cpf', ''),
    nullif(new.raw_user_meta_data->>'birth_date', '')::date,
    nullif(new.raw_user_meta_data->>'terms_accepted_at', '')::timestamptz
  );
  return new;
end;
$function$;

create or replace function public.prevent_role_self_escalation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    new.role := old.role;
  end if;
  return new;
end;
$function$;

create or replace function public.touch_order_updated_at()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.set_order_daily_number()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.order_day := (coalesce(new.created_at, now()) at time zone 'America/Sao_Paulo')::date;
  perform pg_advisory_xact_lock(hashtext('orders_daily_number'), new.order_day - date '2000-01-01');
  select coalesce(max(daily_number), 0) + 1 into new.daily_number
  from public.orders
  where order_day = new.order_day;
  return new;
end;
$function$;

create or replace function public.delete_own_account()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$function$;

create or replace function public.create_order(payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  new_order public.orders;
  item jsonb;
  item_qty int;
  prod_id uuid;
  current_stock int;
begin
  insert into public.orders (customer_id, waiter_id, table_number, subtotal, fee, total, note, status, payment_status, payment_method)
  values (
    nullif(payload->>'customerId', '')::uuid,
    nullif(payload->>'waiterId', '')::uuid,
    (payload->>'tableNumber')::int,
    (payload->>'subtotal')::numeric,
    (payload->>'fee')::numeric,
    (payload->>'total')::numeric,
    coalesce(payload->>'note', ''),
    'Na Fila',
    'pending',
    coalesce(payload->>'paymentMethod', 'pix')
  )
  returning * into new_order;
  for item in select * from jsonb_array_elements(payload->'items')
  loop
    item_qty := (item->>'qty')::int;
    prod_id := (item->>'productId')::uuid;
    select stock_qty into current_stock from public.products where id = prod_id for update;
    if current_stock is not null then
      if current_stock < item_qty then
        raise exception 'out_of_stock:%', item->>'name';
      end if;
      update public.products set stock_qty = stock_qty - item_qty where id = prod_id;
    end if;
    insert into public.order_items (order_id, product_id, name, price, qty, note)
    values (
      new_order.id,
      prod_id,
      item->>'name',
      (item->>'price')::numeric,
      item_qty,
      coalesce(item->>'note','')
    );
  end loop;
  insert into public.order_status_log (order_id, status) values (new_order.id, 'Na Fila');
  return jsonb_build_object('id', new_order.id);
end;
$function$;

create or replace function public.set_order_status(p_order_id uuid, p_status text, p_actor uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  current_status text;
  updated public.orders;
begin
  select status into current_status from public.orders where id = p_order_id for update;
  if current_status is null then
    raise exception 'order_not_found';
  end if;
  if not (
    (current_status = 'Na Fila' and p_status in ('Em Preparo', 'Cancelado')) or
    (current_status = 'Em Preparo' and p_status in ('Pronto', 'Cancelado')) or
    (current_status = 'Pronto' and p_status in ('Entregue', 'Cancelado'))
  ) then
    raise exception 'invalid_transition: % -> %', current_status, p_status;
  end if;
  if p_status = 'Cancelado' and current_status = 'Na Fila' then
    update public.products p
    set stock_qty = p.stock_qty + oi.qty
    from (
      select product_id, sum(qty)::int as qty
      from public.order_items
      where order_id = p_order_id
      group by product_id
    ) oi
    where oi.product_id = p.id
      and p.stock_qty is not null;
  end if;
  update public.orders
  set status = p_status,
      delivered_by = case when p_status = 'Entregue' then p_actor else delivered_by end,
      delivered_at = case when p_status = 'Entregue' then now() else delivered_at end
  where id = p_order_id
  returning * into updated;
  insert into public.order_status_log (order_id, status) values (p_order_id, p_status);
  return to_jsonb(updated);
end;
$function$;

create or replace function public.delete_or_archive_product(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  img text;
begin
  delete from products where id = p_id and archived_at is null returning image_url into img;
  if not found then raise exception 'product_not_found'; end if;
  return jsonb_build_object('action', 'deleted', 'imageUrl', img);
exception when foreign_key_violation then
  update products set archived_at = now(), sold_out = false
   where id = p_id and archived_at is null
  returning image_url into img;
  if not found then raise exception 'product_not_found'; end if;
  return jsonb_build_object('action', 'archived', 'imageUrl', img);
end;
$function$;

create or replace function public.reorder_categories(p_names text[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if (select count(*) from categories) <> coalesce(array_length(p_names, 1), 0)
     or exists (select 1 from categories c where not c.name = any (p_names)) then
    raise exception 'category_list_mismatch';
  end if;
  update categories c set position = o.pos
    from unnest(p_names) with ordinality as o(name, pos)
   where c.name = o.name;
end;
$function$;

create or replace function public.set_table_count(p_count integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'invalid_table_count';
  end if;
  update kiosk_settings set table_count = p_count where id = 1;
  insert into kiosk_tables (number)
  select n from generate_series(1, p_count) n
  on conflict (number) do nothing;
  delete from kiosk_tables t
   where t.number > p_count
     and not exists (select 1 from orders o where o.table_number = t.number);
  return p_count;
end;
$function$;

create or replace function public.dashboard_stats()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with today_orders as (
    select *, case when payment_status = 'refunded' then 0 else total - refunded_amount end as net
    from orders
    where (created_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
      and status <> 'Cancelado'
  ),
  agg as (select coalesce(sum(net),0) as revenue, count(*) as orders_count from today_orders),
  top as (
    select oi.name, sum(oi.qty) as qty from order_items oi join today_orders o on o.id = oi.order_id
    group by oi.name order by sum(oi.qty) desc limit 5
  ),
  hourly as (
    select extract(hour from created_at at time zone 'America/Sao_Paulo')::int as hour, coalesce(sum(net),0) as revenue
    from today_orders group by 1
  )
  select jsonb_build_object(
    'revenueToday', (select revenue from agg),
    'ordersToday', (select orders_count from agg),
    'avgTicket', case when (select orders_count from agg) > 0 then round((select revenue from agg) / (select orders_count from agg), 2) else 0 end,
    'topProducts', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty)) from top), '[]'::jsonb),
    'salesByHour', (select jsonb_agg(jsonb_build_object('hour', h, 'revenue', coalesce(hourly.revenue,0)) order by h) from generate_series(0,23) as h left join hourly on hourly.hour = h)
  );
$function$;

create or replace function public.close_day()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  stats jsonb;
  report public.day_reports;
  already_closed boolean;
begin
  select day_closed into already_closed from public.kiosk_settings where id = 1;
  if already_closed then
    raise exception 'day_already_closed';
  end if;

  stats := public.dashboard_stats();

  insert into public.day_reports (total_revenue, total_orders, avg_ticket, top_products)
  values (
    (stats->>'revenueToday')::numeric,
    (stats->>'ordersToday')::integer,
    (stats->>'avgTicket')::numeric,
    stats->'topProducts'
  )
  returning * into report;

  update public.kiosk_settings set day_closed = true where id = 1;

  return jsonb_build_object(
    'id', report.id,
    'closedAt', report.closed_at,
    'totalRevenue', report.total_revenue,
    'totalOrders', report.total_orders,
    'avgTicket', report.avg_ticket,
    'topProducts', report.top_products
  );
end;
$function$;

create or replace function public.ops_metrics()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  result jsonb;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  with logs as (
    select osl.order_id, osl.status, osl.changed_at from order_status_log osl join orders o on o.id = osl.order_id
    where (o.created_at at time zone 'America/Sao_Paulo')::date = today
  ),
  per_order as (
    select order_id,
      max(changed_at) filter (where status = 'Na Fila') as na_fila_at,
      max(changed_at) filter (where status = 'Em Preparo') as em_preparo_at,
      max(changed_at) filter (where status = 'Pronto') as pronto_at
    from logs group by order_id
  ),
  durations as (
    select extract(epoch from (em_preparo_at - na_fila_at)) as queue_seconds, extract(epoch from (pronto_at - em_preparo_at)) as prep_seconds from per_order
  ),
  open_orders as (select id, updated_at from orders where status in ('Na Fila','Em Preparo'))
  select jsonb_build_object(
    'avgQueueSeconds', (select round(avg(queue_seconds)) from durations where queue_seconds is not null),
    'avgPrepSeconds', (select round(avg(prep_seconds)) from durations where prep_seconds is not null),
    'ordersInQueueOrPrep', (select count(*) from open_orders),
    'lateOrders', (select count(*) from open_orders where extract(epoch from (now() - updated_at)) > 600),
    'cancelledToday', (select count(*) from orders where (created_at at time zone 'America/Sao_Paulo')::date = today and status = 'Cancelado'),
    'soldOutProducts', coalesce((select jsonb_agg(name) from products where sold_out), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

create or replace function public.sales_report(p_days integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  result jsonb;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  first_day date;
begin
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'invalid_period';
  end if;
  first_day := today - (p_days - 1);

  with sales as (
    select o.*, (o.created_at at time zone 'America/Sao_Paulo') as local_at, o.total - o.refunded_amount as net
    from orders o
    where (o.created_at at time zone 'America/Sao_Paulo')::date between first_day and today
      and o.status <> 'Cancelado'
      and o.payment_status not in ('refunded', 'cancelled')
      and (o.payment_status = 'approved' or o.payment_method = 'entrega')
  ),
  agg as (
    select coalesce(sum(net), 0) as revenue, count(*) as orders_count from sales
  ),
  items as (
    select oi.name, sum(oi.qty) as qty, sum(oi.qty * oi.price) as revenue
    from order_items oi
    join sales s on s.id = oi.order_id
    group by oi.name
  ),
  hourly as (
    select extract(hour from local_at)::int as hour, count(*) as orders_count, sum(net) as revenue
    from sales
    group by 1
  ),
  daily as (
    select local_at::date as day, count(*) as orders_count, sum(net) as revenue
    from sales
    group by 1
  )
  select jsonb_build_object(
    'days', p_days,
    'from', first_day,
    'to', today,
    'revenue', (select revenue from agg),
    'orders', (select orders_count from agg),
    'avgTicket', case when (select orders_count from agg) > 0
      then round((select revenue from agg) / (select orders_count from agg), 2) else 0 end,
    'itemsSold', coalesce((select sum(qty) from items), 0),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'revenue', revenue) order by qty desc, revenue desc, name)
      from (select * from items order by qty desc, revenue desc, name limit 10) t
    ), '[]'::jsonb),
    'byHour', (
      select jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(hourly.orders_count, 0), 'revenue', coalesce(hourly.revenue, 0)) order by h)
      from generate_series(0, 23) as h
      left join hourly on hourly.hour = h
    ),
    'byDay', (
      select jsonb_agg(jsonb_build_object('date', d::date, 'orders', coalesce(daily.orders_count, 0), 'revenue', coalesce(daily.revenue, 0)) order by d)
      from generate_series(first_day, today, interval '1 day') as d
      left join daily on daily.day = d::date
    )
  ) into result;
  return result;
end;
$function$;

create or replace function public.waiter_metrics(p_waiter uuid, p_days integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  first_day date;
  result jsonb;
begin
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'invalid_period';
  end if;
  first_day := today - (p_days - 1);
  with delivered as (
    select o.id, o.total, o.delivered_at,
      (select max(l.changed_at) from order_status_log l where l.order_id = o.id and l.status = 'Pronto') as ready_at
    from orders o
    where o.delivered_by = p_waiter
      and (o.delivered_at at time zone 'America/Sao_Paulo')::date between first_day and today
  ),
  launched as (
    select o.id, o.total, o.created_at
    from orders o
    where o.waiter_id = p_waiter
      and o.status <> 'Cancelado'
      and (o.created_at at time zone 'America/Sao_Paulo')::date between first_day and today
  ),
  received as (
    select o.total
    from orders o
    where (o.delivered_by = p_waiter or o.waiter_id = p_waiter)
      and o.payment_method = 'entrega'
      and o.received_with is not null
      and o.status <> 'Cancelado'
      and (o.received_at at time zone 'America/Sao_Paulo')::date between first_day and today
  )
  select jsonb_build_object(
    'days', p_days,
    'from', first_day,
    'to', today,
    'delivered', (select count(*) from delivered),
    'avgDeliverMin', coalesce((
      select round(avg(extract(epoch from (delivered_at - ready_at)) / 60)::numeric, 1)
      from delivered where ready_at is not null and delivered_at >= ready_at
    ), 0),
    'launched', (select count(*) from launched),
    'launchedTotal', coalesce((select sum(total) from launched), 0),
    'received', coalesce((select sum(total) from received), 0),
    'byDay', (
      select jsonb_agg(jsonb_build_object(
        'date', d::date,
        'delivered', (select count(*) from delivered where (delivered_at at time zone 'America/Sao_Paulo')::date = d::date),
        'launched', (select count(*) from launched where (created_at at time zone 'America/Sao_Paulo')::date = d::date)
      ) order by d)
      from generate_series(first_day, today, interval '1 day') as d
    )
  ) into result;
  return result;
end;
$function$;

-- Idade mínima de 18 anos no perfil (auditoria M-01).
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

-- Limite de tentativas compartilhado (auditoria M-03).
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

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
create trigger orders_daily_number before insert on public.orders for each row execute function public.set_order_daily_number();
create trigger orders_touch_updated_at before update on public.orders for each row execute function public.touch_order_updated_at();
create trigger products_touch_updated_at before update on public.products for each row execute function public.touch_order_updated_at();
create trigger profiles_min_age before insert or update of birth_date on public.profiles for each row execute function public.enforce_profile_min_age();
create trigger profiles_prevent_role_escalation before update on public.profiles for each row execute function public.prevent_role_self_escalation();

-- ---------------------------------------------------------------------------
-- RLS e policies. Todas as tabelas têm RLS; anon e authenticated só leem
-- (a escrita é revogada abaixo), então as policies "write"/"update own" não
-- têm efeito e ficam aqui só por fidelidade ao banco de produção.
-- ---------------------------------------------------------------------------

alter table public.categories enable row level security;
alter table public.contact_messages enable row level security;
alter table public.day_reports enable row level security;
alter table public.kiosk_settings enable row level security;
alter table public.kiosk_tables enable row level security;
alter table public.order_items enable row level security;
alter table public.order_refunds enable row level security;
alter table public.order_status_log enable row level security;
alter table public.orders enable row level security;
alter table public.products enable row level security;
alter table public.profiles enable row level security;
alter table public.rate_limits enable row level security;

create policy "day_reports: admin reads" on public.day_reports as permissive for select to public using (public.is_admin());
create policy "kiosk_settings: readable by everyone" on public.kiosk_settings as permissive for select to public using (true);
create policy "kiosk_settings: staff can write" on public.kiosk_settings as permissive for all to public using (public.is_staff()) with check (public.is_staff());
create policy "kiosk_tables: readable by everyone" on public.kiosk_tables as permissive for select to public using (true);
create policy "kiosk_tables: staff can write" on public.kiosk_tables as permissive for all to public using (public.is_staff()) with check (public.is_staff());
create policy "order_items: visible if parent order is" on public.order_items as permissive for select to public
  using ((exists (select 1 from public.orders o where ((o.id = order_items.order_id) and ((o.customer_id = auth.uid()) or public.is_staff())))));
create policy "order_status_log: staff reads" on public.order_status_log as permissive for select to public using (public.is_staff());
create policy "orders: customer reads own, staff reads all" on public.orders as permissive for select to public using (((customer_id = auth.uid()) or public.is_staff()));
create policy "products: readable by everyone" on public.products as permissive for select to public using (true);
create policy "products: staff can write" on public.products as permissive for all to public using (public.is_staff()) with check (public.is_staff());
create policy "profiles: read own" on public.profiles as permissive for select to public using ((auth.uid() = id));
create policy "profiles: update own" on public.profiles as permissive for update to public using ((auth.uid() = id));

-- ---------------------------------------------------------------------------
-- Privilégios: o app só escreve pela API (service role).
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon, authenticated;
revoke usage, update on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, update on sequences from anon, authenticated;

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

revoke execute on function public."current_role"() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public."current_role"() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_staff() to authenticated;
revoke all on public.rate_limits from public, anon, authenticated;
