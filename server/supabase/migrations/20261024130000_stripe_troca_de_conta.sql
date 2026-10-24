-- Troca de conta do Stripe pela aba Stripe do painel (auditoria R4-A2).
-- A conta que sai fica guardada aqui por 30 dias, com as chaves
-- criptografadas pelo servidor como as da conta atual: os pedidos pagos nela
-- continuam estornáveis e o webhook dela continua confirmando pagamentos.
-- A tabela segue sem policy e sem grant para anon/authenticated.
alter table public.stripe_settings
  add column if not exists previous_accounts jsonb not null default '[]'::jsonb;
