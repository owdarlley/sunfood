-- O admin liga e desliga o pedido mínimo sem perder o valor salvo.
-- Começa ligado, como era antes.
alter table public.kiosk_settings
  add column if not exists min_order_enabled boolean not null default true;
