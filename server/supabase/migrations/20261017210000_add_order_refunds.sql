-- Estorno pelo painel do admin: total (cancela o pedido) ou parcial (o pedido
-- continua). Cada estorno fica registrado com valor, motivo e quem fez;
-- orders.refunded_amount guarda a soma, que sai do faturamento.
alter table public.orders
  add column if not exists refunded_amount numeric(10,2) not null default 0
  check (refunded_amount >= 0);

create table if not exists public.order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  reason text not null default '',
  -- provedor do estorno ('stripe'); o id do estorno no provedor evita registrar o
  -- mesmo estorno duas vezes (painel do admin + webhook do Stripe).
  provider text not null,
  provider_refund_id text,
  actor uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists order_refunds_order_id_idx on public.order_refunds(order_id);
create unique index if not exists order_refunds_provider_refund_id_key
  on public.order_refunds(provider_refund_id) where provider_refund_id is not null;

-- Sem políticas: só o servidor (service role) lê e grava estornos.
alter table public.order_refunds enable row level security;

-- O admin pode cancelar também em "Em Preparo" e "Pronto" (o servidor confere
-- quem pode). O estoque só volta se o pedido sai da fila antes do preparo:
-- depois disso a comida já foi usada.
create or replace function public.set_order_status(p_order_id uuid, p_status text, p_actor uuid default null)
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
revoke execute on function public.set_order_status(uuid, text, uuid) from public, anon, authenticated;

-- Faturamento sem o que foi estornado em parte.
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
revoke execute on function public.dashboard_stats() from public, anon, authenticated;

create or replace function public.sales_report(p_days int)
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
revoke execute on function public.sales_report(int) from public, anon, authenticated;
