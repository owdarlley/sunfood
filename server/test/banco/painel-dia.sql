-- Teste no banco do painel do dia e do encerramento (auditoria geral M1 e B2).
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_PAINEL_DIA_PASSOU.
do $$
declare
  meio_dia timestamptz := ((now() at time zone 'America/Sao_Paulo')::date + time '12:00') at time zone 'America/Sao_Paulo';
  antes jsonb; depois jsonb; pid uuid; ok boolean; log text := '';
begin
  update kiosk_settings set day_closed = false, paused = false where id = 1;
  antes := dashboard_stats();
  -- PIX pago (conta), na entrega (conta), PIX não pago e cartão estornado (não contam).
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (1, 50, 0, 50, 'Entregue', 'pix', 'approved', meio_dia),
           (2, 30, 0, 30, 'Pronto', 'entrega', 'pending', meio_dia),
           (3, 100, 0, 100, 'Na Fila', 'pix', 'pending', meio_dia),
           (4, 70, 0, 70, 'Entregue', 'cartao', 'refunded', meio_dia);
  depois := dashboard_stats();
  -- M1: o painel conta igual ao relatório de vendas.
  if (depois->>'revenueToday')::numeric - (antes->>'revenueToday')::numeric <> 80 then
    raise exception 'FALHA painel: esperado +80, veio +%', (depois->>'revenueToday')::numeric - (antes->>'revenueToday')::numeric; end if;
  if (depois->>'ordersToday')::int - (antes->>'ordersToday')::int <> 2 then raise exception 'FALHA pedidos do painel'; end if;
  if (dashboard_stats()->>'revenueToday') is distinct from (sales_report(1)->>'revenue') then
    raise exception 'FALHA painel (%) e relatório (%) não batem', dashboard_stats()->>'revenueToday', sales_report(1)->>'revenue'; end if;
  log := log || 'painel = relatório OK; ';

  -- B2: dia encerrado barra o pedido dentro do banco.
  perform close_day();
  ok := false;
  begin
    perform create_order(jsonb_build_object('tableNumber', 1, 'subtotal', 10, 'fee', 0, 'total', 10, 'paymentMethod', 'entrega',
      'items', jsonb_build_array(jsonb_build_object('productId', (select id from products limit 1), 'name', 'X', 'price', 10, 'qty', 1))));
  exception when others then ok := sqlerrm like '%kiosk_closed%';
  end;
  if not ok then raise exception 'FALHA pedido gravado com o dia encerrado'; end if;
  ok := false;
  begin perform close_day(); exception when others then ok := sqlerrm like '%day_already_closed%'; end;
  if not ok then raise exception 'FALHA encerrou o dia duas vezes'; end if;
  log := log || 'dia encerrado OK; ';

  -- B2: valores impossíveis.
  ok := false;
  begin update orders set refunded_amount = total + 1 where id = (select id from orders limit 1);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA estorno maior que o total'; end if;
  ok := false;
  begin insert into order_items (order_id, name, price, qty) values ((select id from orders limit 1), 'X', 1, 0);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA item com quantidade zero'; end if;
  log := log || 'checks OK';

  raise exception 'TESTE_PAINEL_DIA_PASSOU: %', log;
end;
$$;
