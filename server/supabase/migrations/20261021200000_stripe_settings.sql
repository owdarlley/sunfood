-- Conta do quiosque no Stripe, configurada pelo admin no painel (aba Stripe).
-- As chaves secretas (sk_/rk_ e whsec_) ficam CRIPTOGRAFADAS pelo servidor
-- (AES-256-GCM, chave derivada de um segredo que só existe na Vercel): quem
-- ler o banco não consegue usar as chaves. A chave publicável (pk_) é pública
-- por natureza. Só o servidor (service role) lê e grava: a tabela não tem
-- policy, então anon/authenticated não enxergam nada. Uma linha só (id = 1).
create table if not exists public.stripe_settings (
  id smallint primary key default 1 check (id = 1),
  secret_key_enc text not null,
  publishable_key text not null,
  webhook_secret_enc text,
  webhook_endpoint_id text,
  account_id text,
  account_name text,
  livemode boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.stripe_settings enable row level security;
revoke all on public.stripe_settings from public, anon, authenticated;
