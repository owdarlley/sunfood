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
  hasConfigSecret,
} from "../payments/stripe-config.js";
import { newStripe, STRIPE_API_VERSION } from "../payments/stripe.js";
import { PENDING_REFUND_DAYS } from "../order-payments.js";

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

const isProduction = () => process.env.VERCEL_ENV === "production";

// Endereço público desta API (o Stripe manda os avisos de pagamento pra cá).
// Em produção vem sempre de API_PUBLIC_URL: pelo cabeçalho Host, salvar a
// partir de um Preview apontaria o webhook para o Preview.
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
// pagamentos sem confirmação. Erro na consulta não vira "nenhum" (auditoria R4-M6).
async function openOnlinePayments() {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("payment_provider", "stripe")
    .eq("payment_status", "pending")
    .eq("status", "Na Fila");
  if (error) throw new Error("Pagamentos em aberto não conferidos: " + error.message);
  return data.length;
}

// Pedidos pagos pelo Stripe que ainda podem ser estornados (os mesmos 30 dias
// do estorno automático). Desconectar apagaria as chaves da conta onde eles
// foram pagos (auditoria R4-A2).
async function refundablePayments() {
  const since = new Date(Date.now() - PENDING_REFUND_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("payment_provider", "stripe")
    .eq("payment_status", "approved")
    .gte("created_at", since);
  if (error) throw new Error("Pagamentos estornáveis não conferidos: " + error.message);
  return data.length;
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

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
    previousAccounts: (row?.previous_accounts || []).length,
    // Em produção, chave de teste precisa de confirmação (auditoria R4-M1).
    production: isProduction(),
    updatedAt: row?.updated_at || null,
    updatedBy: await profileName(row?.updated_by),
  };
  if (cfg.secretKey) {
    try {
      out.account = await accountInfo(newStripe(cfg.secretKey));
      out.connection = { ok: true };
    } catch (e) {
      out.connection = { ok: false, error: stripeError(e) };
    }
  }
  res.json(out);
});

// Conta anterior guardada por 30 dias depois da troca (o prazo dos estornos).
const RETIRE_MS = PENDING_REFUND_DAYS * 24 * 60 * 60 * 1000;

// Apaga um webhook criado pelo painel, sem travar a gravação se falhar.
async function dropEndpoint(secretKey, id, why) {
  if (!id) return;
  try {
    await newStripe(secretKey).webhookEndpoints.del(id);
  } catch (e) {
    console.warn(`Webhook do Stripe não apagado (${why}):`, e.message);
  }
}

stripeAdminRouter.put("/", saveLimiter, async (req, res) => {
  const secretKey = String(req.body?.secretKey || "").trim();
  const publishableKey = String(req.body?.publishableKey || "").trim();
  if (!SECRET_RE.test(secretKey))
    return res.status(400).json({ error: "A chave secreta começa com sk_test_, sk_live_, rk_test_ ou rk_live_." });
  if (!PUBLISHABLE_RE.test(publishableKey))
    return res.status(400).json({ error: "A chave publicável começa com pk_test_ ou pk_live_." });
  if (modeOf(secretKey) !== modeOf(publishableKey))
    return res.status(400).json({ error: "As duas chaves precisam ser do mesmo modo: as duas de teste ou as duas de produção." });

  if (isProduction()) {
    // Sem segredo próprio, a criptografia dependeria da service role, e girar
    // essa chave apagaria as chaves salvas sem aviso (auditoria R4-M3).
    if (!hasConfigSecret())
      return res.status(503).json({ error: "Falta a variável STRIPE_CONFIG_SECRET na Vercel. Crie a variável e tente de novo." });
    if (!process.env.API_PUBLIC_URL)
      return res.status(503).json({ error: "Falta a variável API_PUBLIC_URL na Vercel. Crie a variável e tente de novo." });
    // Chave de teste em produção: os clientes "pagariam" com o cartão de
    // teste e o pedido iria para a cozinha sem cobrança (auditoria R4-M1).
    if (modeOf(secretKey) === "test" && req.body?.confirmTestMode !== true) {
      return res.status(409).json({
        needsTestConfirm: true,
        error: "Estas são chaves de teste: com elas, nenhum pagamento é cobrado de verdade. Confirme se é isso mesmo.",
      });
    }
  }

  const api = newStripe(secretKey);
  let account;
  try {
    account = await accountInfo(api);
  } catch (e) {
    return res.status(400).json({ error: stripeError(e) });
  }

  const old = await readStripeRow();
  const livemode = modeOf(secretKey) === "live";
  const sameAccount = old && old.account_id === account.id && old.livemode === livemode;
  // A coluna previous_accounts guarda a conta anterior para os estornos.
  const canKeepPrevious = !old || "previous_accounts" in old;
  if (!sameAccount) {
    if (old && !canKeepPrevious) {
      return res.status(409).json({ error: "Falta rodar o SQL da troca de conta do Stripe no Supabase. Depois tente de novo." });
    }
    const open = await openOnlinePayments();
    if (open > 0) {
      return res.status(409).json({
        error: `Há ${plural(open, "pedido esperando", "pedidos esperando")} pagamento por PIX ou cartão. Troque a conta quando a fila de pagamentos esvaziar.`,
      });
    }
  }

  // Webhook novo primeiro (o segredo só aparece na criação). O antigo só é
  // apagado depois de o novo estar salvo: se algo falhar no meio, o quiosque
  // continua com o webhook que funcionava (auditoria R4-M5).
  const url = webhookUrl(req);
  let endpoint;
  try {
    endpoint = await api.webhookEndpoints.create({
      url,
      enabled_events: WEBHOOK_EVENTS,
      api_version: STRIPE_API_VERSION,
      description: "SunFood: confirma PIX, cartão e estornos (criado pelo painel)",
      metadata: { sunfood: "1" },
    });
  } catch (e) {
    console.error("Webhook do Stripe não criado:", e.message);
    return res.status(400).json({ error: "Chaves certas, mas o webhook não foi criado. " + stripeError(e) });
  }

  // Contas anteriores: a que sai entra na lista com o webhook ainda ligado,
  // pra os pagamentos feitos nela continuarem estornáveis e confirmados
  // (auditoria R4-A2). Depois de 30 dias ela sai, e o webhook dela também.
  const now = Date.now();
  const kept = [];
  const expired = [];
  for (const p of old?.previous_accounts || []) {
    if (p.account_id === account.id && p.livemode === livemode) expired.push(p); // voltou para essa conta
    else if (now - Date.parse(p.retired_at) > RETIRE_MS) expired.push(p);
    else kept.push(p);
  }
  if (old && !sameAccount) {
    kept.unshift({
      account_id: old.account_id,
      livemode: old.livemode,
      secret_key_enc: old.secret_key_enc,
      webhook_secret_enc: old.webhook_secret_enc,
      webhook_endpoint_id: old.webhook_endpoint_id,
      retired_at: new Date(now).toISOString(),
    });
  }

  const row = {
    id: 1,
    secret_key_enc: encryptSecret(secretKey),
    publishable_key: publishableKey,
    webhook_secret_enc: encryptSecret(endpoint.secret),
    webhook_endpoint_id: endpoint.id,
    account_id: account.id,
    account_name: account.name,
    livemode,
    updated_at: new Date(now).toISOString(),
    updated_by: req.user.sub,
  };
  if (canKeepPrevious) row.previous_accounts = kept;
  const { error } = await supabaseAdmin.from("stripe_settings").upsert(row);
  if (error) {
    await dropEndpoint(secretKey, endpoint.id, "gravação falhou");
    const missing = error.code === "42P01" || error.code === "PGRST205";
    return res.status(500).json({
      error: missing ? "Falta rodar o SQL da aba Stripe no Supabase." : "Não foi possível salvar a configuração.",
    });
  }
  forgetStripeSettings();

  // Só agora tira os webhooks que ficaram sem uso nesta conta: os que o
  // painel criou para este endereço e o anterior desta mesma conta.
  try {
    const list = await api.webhookEndpoints.list({ limit: 100 });
    for (const ep of list.data.filter((ep) => ep.id !== endpoint.id && ep.url === url && ep.metadata?.sunfood === "1")) {
      await dropEndpoint(secretKey, ep.id, "substituído");
    }
  } catch (e) {
    console.warn("Webhooks antigos do Stripe não conferidos:", e.message);
  }
  if (sameAccount && old.webhook_endpoint_id !== endpoint.id) await dropEndpoint(secretKey, old.webhook_endpoint_id, "substituído");
  for (const p of expired) {
    try {
      await dropEndpoint(decryptSecret(p.secret_key_enc), p.webhook_endpoint_id, "conta anterior");
    } catch (e) {
      console.warn("Chave de conta anterior do Stripe não abre:", e.message);
    }
  }
  res.json({ ok: true, account, mode: modeOf(secretKey) });
});

// Volta para as variáveis STRIPE_* da Vercel (ou para o modo provisório).
stripeAdminRouter.delete("/", saveLimiter, async (req, res) => {
  const old = await readStripeRow();
  if (!old) return res.json({ ok: true });
  const open = await openOnlinePayments();
  if (open > 0) {
    return res.status(409).json({
      error: `Há ${plural(open, "pedido esperando", "pedidos esperando")} pagamento por PIX ou cartão. Desconecte quando a fila de pagamentos esvaziar.`,
    });
  }
  const paid = await refundablePayments();
  if (paid > 0) {
    return res.status(409).json({
      error: `Há ${plural(paid, "pedido pago", "pedidos pagos")} pelo Stripe nos últimos ${PENDING_REFUND_DAYS} dias que ainda podem ser estornados. Para mudar de conta, cole as chaves da conta nova: a atual continua valendo para esses estornos.`,
    });
  }
  const { error } = await supabaseAdmin.from("stripe_settings").delete().eq("id", 1);
  if (error) return res.status(500).json({ error: "Não foi possível desconectar." });
  forgetStripeSettings();
  for (const p of [old, ...(old.previous_accounts || [])]) {
    try {
      await dropEndpoint(decryptSecret(p.secret_key_enc), p.webhook_endpoint_id, "desconectado");
    } catch (e) {
      console.warn("Chave do Stripe não abre:", e.message);
    }
  }
  res.json({ ok: true });
});
