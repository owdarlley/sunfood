-- Teste no banco (Supabase) do número curto do pedido (#001, #002...).
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_NUMERO_PEDIDO_PASSOU.
do $$
declare
  cust uuid; tbl int; prod record; a uuid; b uuid; na int; nb int; nc int; dia date;
  log text := '';
begin
  select id into cust from profiles where role = 'cliente' limit 1;
  select number into tbl from kiosk_tables where active order by number limit 1;
  select id, name, price into prod from products where not sold_out and archived_at is null order by name limit 1;
  update products set stock_qty = null where id = prod.id;  -- sem limite de estoque no teste (desfeito no fim)

  -- 1. pedidos seguidos ganham números seguidos no dia
  a := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'note', 'TESTE-NUMERO',
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1)))))->>'id';
  b := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'note', 'TESTE-NUMERO',
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1)))))->>'id';
  select daily_number, order_day into na, dia from orders where id = a;
  select daily_number into nb from orders where id = b;
  if na is null or nb <> na + 1 then raise exception 'FALHA números seguidos: % e %', na, nb; end if;
  log := log || 'números seguidos OK (#' || lpad(na::text, 3, '0') || ', #' || lpad(nb::text, 3, '0') || '); ';

  -- 2. o dia é o de São Paulo
  if dia <> (now() at time zone 'America/Sao_Paulo')::date then raise exception 'FALHA dia do pedido: %', dia; end if;
  log := log || 'dia de São Paulo OK; ';

  -- 3. no dia seguinte recomeça do 1 (pedido gravado com data de amanhã)
  insert into orders (customer_id, table_number, subtotal, fee, total, note, status, payment_status, payment_method, created_at)
  values (cust, tbl, 1, 0, 1, 'TESTE-NUMERO', 'Na Fila', 'pending', 'entrega', now() + interval '1 day')
  returning daily_number into nc;
  if nc <> 1 then raise exception 'FALHA dia seguinte não recomeçou do 1: veio %', nc; end if;
  log := log || 'recomeça no dia seguinte OK; ';

  -- 4. nenhum número repetido no mesmo dia
  if exists (select 1 from orders group by order_day, daily_number having count(*) > 1) then
    raise exception 'FALHA número repetido no mesmo dia'; end if;
  log := log || 'sem repetidos OK; ';

  raise exception 'TESTE_NUMERO_PEDIDO_PASSOU: %', log;
end $$;
