-- Auditoria geral de 21/10/2026: A2, M1 e B2.
-- Pode rodar mais de uma vez.

-- A2: a lista de pedidos da equipe filtra por dia (order_day) e ordena por
-- created_at; sem índice, cada consulta lia a tabela inteira.
create index if not exists orders_order_day_idx on public.orders using btree (order_day);
create index if not exists orders_created_at_idx on public.orders using btree (created_at desc);

-- B2: valores que nunca podem acontecer. NOT VALID: vale para o que for
-- gravado daqui em diante, sem travar a migração por causa de linha antiga.
alter table public.orders drop constraint if exists orders_refunded_amount_le_total;
alter table public.orders add constraint orders_refunded_amount_le_total check (refunded_amount <= total) not valid;
alter table public.order_items drop constraint if exists order_items_qty_check;
alter table public.order_items add constraint order_items_qty_check check (qty > 0) not valid;
alter table public.order_items drop constraint if exists order_items_price_check;
alter table public.order_items add constraint order_items_price_check check (price >= 0) not valid;

-- M1: o painel do dia usa o mesmo critério do relatório de vendas (só pedido
-- pago no app ou "pagar na entrega", sem cancelado nem estornado) e filtra
-- pela coluna order_day, que tem índice.
create or replace function public.dashboard_stats()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with today_orders as (
    select *, total - refunded_amount as net
    from orders
    where order_day = (now() at time zone 'America/Sao_Paulo')::date
      and status <> 'Cancelado'
      and payment_status not in ('refunded', 'cancelled')
      and (payment_status = 'approved' or payment_method = 'entrega')
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

-- B2: dois cliques em "Encerrar o dia" geravam dois relatórios. A linha de
-- kiosk_settings fica travada até o fim, e create_order espera por ela.
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
  select day_closed into already_closed from public.kiosk_settings where id = 1 for update;
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

-- B2: o dia encerrado (ou o quiosque pausado) é conferido de novo dentro da
-- gravação do pedido, não só na API antes dela.
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
  if exists (select 1 from public.kiosk_settings where id = 1 and (day_closed or paused) for share) then
    raise exception 'kiosk_closed';
  end if;
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
