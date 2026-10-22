import Stripe from "stripe";
import { supabaseAdmin } from "../supabase.js";
import { asyncRouter } from "../async-router.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { limiter } from "../rate-limit.js";
import {
  encryptSecret,
  decryptSecret,
  forgetStripeSettings,
  readStripeRow,
  stripeSettings,
  maskKey,
} from "../payments/stripe-config.js";

// Admin > Stripe: o dono do quiosque conecta a própria conta do Stripe colando
// as chaves de API. O servidor confere as chaves no Stripe, cria sozinho o
// webhook que confirma os pagamentos e guarda tudo criptografado. A chave
// secreta e o segredo do webhook nunca voltam para o navegador: a tela só vê
// o começo e o fim da chave, a conta e o modo (teste ou produção).
export const stripeAdminRouter = asyncRouter();
stripeAdminRouter.use(requireAuth, requireRole("admin"));

const saveLimiter = limiter("stripe-admin", {
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: "Muitas tentativas. Tente novamente em alguns minutos." },
});

// Eventos que o webhook (routes/payments.js) trata.
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "payment_intent.succeeded",
  "charge.refunded",
];

const SECRET_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const PUBLISHABLE_RE = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;
const modeOf = (key) => (/^[a-z]{2}_live_/.test(key || "") ? "live" : key ? "test" : null);

// Endereço público desta API (o Stripe manda os avisos de pagamento pra cá).
function webhookUrl(req) {
  const base = process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return base.replace(/\/+$/, "") + "/payments/stripe/webhook";
}

async function accountInfo(api) {
  const a = await api.accounts.retrieve();
  return {
    id: a.id,
    name: a.settings?.dashboard?.display_name || a.business_profile?.name || a.email || a.id,
  };
}

// Erro do Stripe em português, sem detalhe interno.
function stripeError(e) {
  if (e?.type === "StripeAuthenticationError") return "O Stripe recusou a chave secreta. Confira se copiou a chave inteira.";
  if (e?.type === "StripePermissionError")
    return "A chave restrita não tem permissão suficiente. Use a chave secreta (sk_) ou libere Webhooks e Conta na chave restrita.";
  if (e?.type === "StripeConnectionError") return "Não foi possível falar com o Stripe agora. Tente de novo.";
  return "O Stripe recusou a configuração: " + (e?.message || "erro desconhecido") + ".";
}

// Pedidos com PIX ou cartão em aberto: trocar de conta agora deixaria esses
// pagamentos sem confirmação (o webhook antigo some).
async function openOnlinePayments() {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("payment_provider", "stripe")
    .eq("payment_status", "pending")
    .eq("status", "Na Fila");
  return (data || []).length;
}

async function profileName(id) {
  if (!id) return null;
  const { data } = await supabaseAdmin.from("profiles").select("name").eq("id", id).maybeSingle();
  return data?.name || null;
}

stripeAdminRouter.get("/", async (req, res) => {
  const cfg = await stripeSettings();
  const row = cfg.source === "painel" ? await readStripeRow() : null;
  const out = {
    source: cfg.source,
    unreadable: !!cfg.unreadable,
    configured: !!cfg.secretKey,
    mode: modeOf(cfg.secretKey),
    secretKeyHint: maskKey(cfg.secretKey),
    publishableKey: cfg.publishableKey || null,
    webhook: { configured: !!cfg.webhookSecret, url: webhookUrl(req) },
    account: null,
    connection: null,
    updatedAt: row?.updated_at || null,
    updatedBy: await profileName(row?.updated_by),
  };
  if (cfg.secretKey) {
    try {
      out.account = await accountInfo(new Stripe(cfg.secretKey));
      out.connection = { ok: true };
    } catch (e) {
      out.connection = { ok: false, error: stripeError(e) };
    }
  }
  res.json(out);
});

stripeAdminRouter.put("/", saveLimiter, async (req, res) => {
  const secretKey = String(req.body?.secretKey || "").trim();
  const publishableKey = String(req.body?.publishableKey || "").trim();
  if (!SECRET_RE.test(secretKey))
    return res.status(400).json({ error: "A chave secreta começa com sk_test_, sk_live_, rk_test_ ou rk_live_." });
  if (!PUBLISHABLE_RE.test(publishableKey))
    return res.status(400).json({ error: "A chave publicável começa com pk_test_ ou pk_live_." });
  if (modeOf(secretKey) !== modeOf(publishableKey))
    return res.status(400).json({ error: "As duas chaves precisam ser do mesmo modo: as duas de teste ou as duas de produção." });

  const api = new Stripe(secretKey);
  let account;
  try {
    account = await accountInfo(api);
  } catch (e) {
    return res.status(400).json({ error: stripeError(e) });
  }

  const old = await readStripeRow();
  const sameAccount = old && old.account_id === account.id && old.livemode === (modeOf(secretKey) === "live");
  if (!sameAccount) {
    const open = await openOnlinePayments();
    if (open > 0) {
      return res.status(409).json({
        error: `Há ${open} ${open === 1 ? "pedido esperando" : "pedidos esperando"} pagamento por PIX ou cartão. Troque a conta quando a fila de pagamentos esvaziar.`,
      });
    }
  }

  // Webhook novo (o segredo só aparece na criação). Antes, apaga o que o
  // painel criou para este mesmo endereço, pra não acumular.
  const url = webhookUrl(req);
  let endpoint;
  try {
    const list = await api.webhookEndpoints.list({ limit: 100 });
    for (const ep of list.data.filter((ep) => ep.url === url && ep.metadata?.sunfood === "1")) {
      await api.webhookEndpoints.del(ep.id);
    }
    endpoint = await api.webhookEndpoints.create({
      url,
      enabled_events: WEBHOOK_EVENTS,
      description: "Sunfood: confirma PIX, cartão e estornos (criado pelo painel)",
      metadata: { sunfood: "1" },
    });
  } catch (e) {
    console.error("Webhook do Stripe não criado:", e.message);
    return res.status(400).json({ error: "Chaves certas, mas o webhook não foi criado. " + stripeError(e) });
  }

  // Conta anterior (outra chave): tira o webhook que o painel tinha criado lá.
  if (old && !sameAccount && old.webhook_endpoint_id) {
    try {
      await new Stripe(decryptSecret(old.secret_key_enc)).webhookEndpoints.del(old.webhook_endpoint_id);
    } catch (e) {
      console.warn("Webhook antigo do Stripe não apagado:", e.message);
    }
  }

  const { error } = await supabaseAdmin.from("stripe_settings").upsert({
    id: 1,
    secret_key_enc: encryptSecret(secretKey),
    publishable_key: publishableKey,
    webhook_secret_enc: encryptSecret(endpoint.secret),
    webhook_endpoint_id: endpoint.id,
    account_id: account.id,
    account_name: account.name,
    livemode: modeOf(secretKey) === "live",
    updated_at: new Date().toISOString(),
    updated_by: req.user.sub,
  });
  if (error) {
    await api.webhookEndpoints.del(endpoint.id).catch(() => {});
    const missing = error.code === "42P01" || error.code === "PGRST205";
    return res.status(500).json({
      error: missing ? "Falta rodar o SQL da aba Stripe no Supabase." : "Não foi possível salvar a configuração.",
    });
  }
  forgetStripeSettings();
  res.json({ ok: true, account, mode: modeOf(secretKey) });
});

// Volta para as variáveis STRIPE_* da Vercel (ou para o modo provisório).
stripeAdminRouter.delete("/", saveLimiter, async (req, res) => {
  const old = await readStripeRow();
  if (!old) return res.json({ ok: true });
  const open = await openOnlinePayments();
  if (open > 0) {
    return res.status(409).json({
      error: `Há ${open} ${open === 1 ? "pedido esperando" : "pedidos esperando"} pagamento por PIX ou cartão. Desconecte quando a fila de pagamentos esvaziar.`,
    });
  }
  if (old.webhook_endpoint_id) {
    try {
      await new Stripe(decryptSecret(old.secret_key_enc)).webhookEndpoints.del(old.webhook_endpoint_id);
    } catch (e) {
      console.warn("Webhook do Stripe não apagado:", e.message);
    }
  }
  const { error } = await supabaseAdmin.from("stripe_settings").delete().eq("id", 1);
  if (error) return res.status(500).json({ error: "Não foi possível desconectar." });
  forgetStripeSettings();
  res.json({ ok: true });
});
