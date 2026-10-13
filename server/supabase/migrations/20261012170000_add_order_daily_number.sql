-- Número curto do pedido: #001, #002... recomeçando a cada dia (horário de
-- São Paulo). É o que cliente, cozinha e admin veem na tela; o id (uuid)
-- continua sendo a chave interna usada pela API e pelo Mercado Pago.
alter table public.orders
  add column if not exists order_day date,
  add column if not exists daily_number integer;

-- Pedidos que já existem ganham o número na ordem em que foram feitos no dia.
update public.orders o
set order_day = n.day, daily_number = n.num
from (
  select id,
    (created_at at time zone 'America/Sao_Paulo')::date as day,
    row_number() over (
      partition by (created_at at time zone 'America/Sao_Paulo')::date
      order by created_at, id
    ) as num
  from public.orders
) n
where o.id = n.id and o.daily_number is null;

-- Pedido novo pega o próximo número do dia. O lock por dia faz dois pedidos
-- simultâneos esperarem um pelo outro, então nunca saem com o mesmo número.
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

drop trigger if exists orders_daily_number on public.orders;
create trigger orders_daily_number
  before insert on public.orders
  for each row execute function public.set_order_daily_number();

alter table public.orders
  alter column order_day set not null,
  alter column daily_number set not null;

create unique index if not exists orders_day_number_key on public.orders (order_day, daily_number);
