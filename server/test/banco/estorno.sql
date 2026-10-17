-- Teste no banco (Supabase) do estorno pelo painel do admin
-- (migração 20261017210000_add_order_refunds.sql).
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_ESTORNO_PASSOU.
do $$
declare
  cust uuid; tbl int; prod record; oid uuid; ok boolean; st text; antes jsonb; depois jsonb; estoque int;
  log text := '';
  itens jsonb;
begin
  select id into cust from profiles where role = 'cliente' limit 1;
  select number into tbl from kiosk_tables where active order by number limit 1;
  select id, name, price, stock_qty into prod from products where not sold_out and stock_qty is not null and stock_qty > 0 order by name limit 1;
  if prod.id is null then
    select id, name, price, stock_qty into prod from products where not sold_out order by name limit 1;
  end if;
  itens := jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1));

  -- 1. estorno parcial sai do faturamento do relatório
  antes := sales_report(1);
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'cartao', 'items', itens)))->>'id';
  update orders set payment_status = 'approved', payment_id = 'pi_teste' where id = oid;
  insert into order_refunds (order_id, amount, reason, provider, provider_refund_id) values (oid, 0.01, 'teste', 'stripe', 're_teste_banco');
  update orders set refunded_amount = 0.01 where id = oid;
  depois := sales_report(1);
  if round((depois->>'revenue')::numeric - (antes->>'revenue')::numeric, 2) <> prod.price - 0.01 then
    raise exception 'FALHA relatório: esperado +%, veio % -> %', prod.price - 0.01, antes->>'revenue', depois->>'revenue';
  end if;
  log := log || 'parcial sai do faturamento OK; ';

  -- 2. o mesmo estorno do Stripe não é registrado duas vezes
  ok := false;
  begin
    insert into order_refunds (order_id, amount, reason, provider, provider_refund_id) values (oid, 0.01, 'de novo', 'stripe', 're_teste_banco');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'FALHA estorno duplicado aceito'; end if;
  log := log || 'estorno duplicado recusado OK; ';

  -- 3. admin cancela em preparo; o estoque não volta (a comida já foi usada)
  perform set_order_status(oid, 'Em Preparo');
  if prod.stock_qty is not null then select stock_qty into estoque from products where id = prod.id; end if;
  perform set_order_status(oid, 'Cancelado');
  select status into st from orders where id = oid;
  if st <> 'Cancelado' then raise exception 'FALHA cancelar em preparo: veio %', st; end if;
  if prod.stock_qty is not null and (select stock_qty from products where id = prod.id) <> estoque then
    raise exception 'FALHA estoque voltou ao cancelar em preparo';
  end if;
  log := log || 'cancelar em preparo OK; ';

  -- 4. cancelar na fila ainda devolve o estoque
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'entrega', 'items', itens)))->>'id';
  if prod.stock_qty is not null then select stock_qty into estoque from products where id = prod.id; end if;
  perform set_order_status(oid, 'Cancelado');
  if prod.stock_qty is not null and (select stock_qty from products where id = prod.id) <> estoque + 1 then
    raise exception 'FALHA estoque não voltou ao cancelar na fila';
  end if;
  log := log || 'cancelar na fila devolve estoque OK; ';

  -- 5. entregue não cancela
  ok := false;
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'entrega', 'items', itens)))->>'id';
  perform set_order_status(oid, 'Em Preparo'); perform set_order_status(oid, 'Pronto'); perform set_order_status(oid, 'Entregue');
  begin perform set_order_status(oid, 'Cancelado'); exception when others then ok := sqlerrm like 'invalid_transition%'; end;
  if not ok then raise exception 'FALHA entregue foi cancelado'; end if;
  log := log || 'entregue não cancela OK; ';

  -- 6. só o servidor lê os estornos
  if has_table_privilege('anon', 'public.order_refunds', 'select') and
     exists (select 1 from pg_policies where tablename = 'order_refunds') then
    raise exception 'FALHA order_refunds aberta para anon';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.relname = 'order_refunds' and c.relnamespace = 'public'::regnamespace) then
    raise exception 'FALHA order_refunds sem RLS';
  end if;
  log := log || 'estornos só pelo servidor OK';

  raise exception 'TESTE_ESTORNO_PASSOU: %', log;
end $$;
