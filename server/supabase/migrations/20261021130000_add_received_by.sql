-- Quem anotou o recebimento de um pedido "pagar na entrega" (auditoria M-05).
-- Aplicado em produção em 21/10/2026.
-- Junto com received_at, deixa o caixa rastreável: cada recebimento tem dono.
alter table public.orders
  add column if not exists received_by uuid references public.profiles(id) on delete set null;
