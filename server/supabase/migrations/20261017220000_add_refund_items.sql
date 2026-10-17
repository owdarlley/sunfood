-- Itens de cada estorno parcial ([{"name": "Água", "qty": 2}]), para o
-- cliente ver nos detalhes do pedido o que foi devolvido.
alter table public.order_refunds
  add column if not exists items jsonb not null default '[]'::jsonb;
