import Stripe from "stripe";
import { stripeSettings } from "./stripe-config.js";

// As chaves vêm da aba Stripe do painel (criptografadas no banco) ou, sem
// nada salvo lá, das variáveis STRIPE_* da Vercel (ver stripe-config.js).
// A chave secreta nunca vai para o repositório nem para o front.
//
// configured: com a chave secreta, PIX e cartão são cobrados pelo Stripe
// (cartão com campos no app se houver a chave publicável, senão Checkout
// hospedado). testMode: chave sk_test_/rk_test_, nada é cobrado de verdade
// (cartão 4242 4242 4242 4242). publishableKey (pk_...) pode ir pro app: é
// ela que desenha os campos do cartão (Payment Element).
export async function stripeStatus() {
  const cfg = await stripeSettings();
  return {
    configured: !!cfg.secretKey,
    testMode: /^(sk|rk)_test_/.test(cfg.secretKey || ""),
    publishableKey: cfg.publishableKey || null,
  };
}

// Por quanto tempo uma cobrança online fica aberta. Depois disso o pedido não
// pago sai da fila (ver order-payments.js).
export const PAYMENT_WINDOW_MINUTES = 30;

// Versão da API do Stripe fixada (auditoria R3-M12): atualizar o SDK não
// muda sozinho o formato das respostas. O webhook criado pelo painel usa a mesma.
export const STRIPE_API_VERSION = "2025-10-29.clover";
export const newStripe = (key) => new Stripe(key, { apiVersion: STRIPE_API_VERSION });

// Um cliente por chave: trocar a chave no painel passa a valer sem reiniciar.
// key: uma chave específica (conta anterior); sem ela, a conta atual.
const clients = new Map();
async function stripe(key) {
  const k = key || (await stripeSettings()).secretKey;
  if (!k) throw new Error("Stripe não configurado.");
  if (!clients.has(k)) clients.set(k, newStripe(k));
  return clients.get(k);
}

// Pagamento feito numa conta anterior (troca de conta no painel, auditoria
// R4-A2): procura primeiro na conta atual e, se o Stripe não achar
// (resource_missing), nas anteriores. Assim estorno e cancelamento continuam
// funcionando para pedidos pagos antes da troca.
async function onPaymentAccount(fn) {
  const cfg = await stripeSettings();
  const keys = [...new Set([cfg.secretKey, ...(cfg.previous || []).map((p) => p.secretKey)].filter(Boolean))];
  if (!keys.length) throw new Error("Stripe não configurado.");
  let last;
  for (const k of keys) {
    try {
      return await fn(await stripe(k));
    } catch (e) {
      if (e?.code !== "resource_missing") throw e;
      last = e;
    }
  }
  throw last;
}

// Pedido já pago no Stripe (o webhook ainda não chegou): não gera outra cobrança.
export class AlreadyPaidError extends Error {
  constructor(id) {
    super("Pagamento já recebido: " + id);
    this.code = "already_paid";
  }
}
const PAID_OR_PAYING = ["succeeded", "processing"];

// Pagamentos do Stripe são guardados no pedido pelo id do PaymentIntent.
export const isStripePaymentId = (id) => String(id || "").startsWith("pi_");

// Cria a página de pagamento do Stripe pro valor do pedido e devolve o link.
// Os dados do cartão são digitados lá — nunca passam pelo app nem por aqui.
// O pedido vai em client_reference_id e metadata pra casar com o webhook.
export async function createStripeCheckout({ orderId, amount, payerEmail, successUrl, cancelUrl, description, expiresInMinutes }) {
  const session = await (await stripe()).checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: Math.round(Number(amount) * 100),
          product_data: { name: description || `Pedido SunFood #${orderId}` },
        },
      },
    ],
    customer_email: payerEmail || undefined,
    client_reference_id: orderId,
    metadata: { order_id: orderId },
    payment_intent_data: { metadata: { order_id: orderId } },
    success_url: successUrl,
    cancel_url: cancelUrl,
    // O Stripe exige no mínimo 30 minutos.
    expires_at: Math.floor(Date.now() / 1000) + Math.max(30, expiresInMinutes) * 60,
    locale: "pt-BR",
  });
  return { sessionId: session.id, checkoutUrl: session.url };
}

// Cartão de crédito ou débito: o tipo "card" do Stripe aceita os dois (quem
// decide é o cartão). Parcelamento não é ligado em lugar nenhum — no Stripe
// ele só existe se for ativado no PaymentIntent — então é sempre à vista.

// Campos do cartão dentro do app (Payment Element): cria — ou reaproveita,
// se o cliente voltou à tela — o PaymentIntent do pedido e devolve o
// client_secret que o app usa pra confirmar. O cartão é digitado nos campos
// do próprio Stripe (iframes), nunca passa pelo app nem por aqui.
//
// Cartão salvo: cada cliente do SunFood tem um Customer no Stripe (achado
// pelo e-mail + metadata sunfood_user_id, sem coluna nova no banco). O
// CustomerSession deixa o Payment Element mostrar a caixa "salvar cartão" e
// os cartões já salvos. O número do cartão fica só no Stripe.
export async function createOrReuseCardIntent({ orderId, amount, payerEmail, payerName, userId, description, existingId, withSession = true }) {
  const cents = Math.round(Number(amount) * 100);
  // As chamadas ao Stripe que não dependem uma da outra vão juntas, pra os
  // campos do cartão aparecerem mais rápido.
  const [customer, old] = await Promise.all([
    userId ? findOrCreateCustomer({ userId, email: payerEmail, name: payerName }) : null,
    // PaymentIntent de outra conta (troca no painel) não é achado: cria outro.
    existingId ? (await stripe()).paymentIntents.retrieve(existingId).catch(() => null) : null,
  ]);
  if (old && PAID_OR_PAYING.includes(old.status)) throw new AlreadyPaidError(old.id);
  const reusable = old && old.amount === cents && (old.customer || null) === customer
    && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(old.status);
  const [pi, customerSessionClientSecret] = await Promise.all([
    reusable ? old : (await stripe()).paymentIntents.create({
      amount: cents,
      currency: "brl",
      payment_method_types: ["card"],
      customer: customer || undefined,
      description: description || `Pedido SunFood #${orderId}`,
      receipt_email: payerEmail || undefined,
      metadata: { order_id: orderId },
    }),
    customer && withSession ? createCustomerSession(customer) : null,
  ]);
  // O PaymentIntent anterior não serve mais (valor mudou): fecha, pra não
  // poder ser pago junto com o novo.
  if (old && !reusable && old.id !== pi.id) await closeStaleIntent(old);
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret, amount: pi.amount, customerSessionClientSecret };
}

async function closeStaleIntent(old) {
  if (!["requires_payment_method", "requires_confirmation", "requires_action"].includes(old.status)) return;
  await (await stripe()).paymentIntents.cancel(old.id).catch((e) => console.warn("PaymentIntent antigo não cancelado:", old.id, e.message));
}

// Cobrança nova que perdeu a corrida para um pagamento (auditoria R3-A1):
// fecha, pra não ficar um QR ou um cartão pagável sem pedido.
export async function cancelUnusedIntent(id) {
  await (await stripe()).paymentIntents.cancel(id).catch((e) => console.warn("PaymentIntent sem uso não cancelado:", id, e.message));
}

// Sessão do cliente pedida antes de existir o pedido: o app desenha os campos
// do cartão (e os cartões salvos) logo que o cliente chega no pagamento, sem
// esperar o pedido nem o PaymentIntent.
export async function createCardSession({ userId, email, name }) {
  const customer = await findOrCreateCustomer({ userId, email, name });
  return { customerSessionClientSecret: await createCustomerSession(customer) };
}

async function findOrCreateCustomer({ userId, email, name }) {
  if (email) {
    const list = await (await stripe()).customers.list({ email, limit: 20 });
    const found = list.data.find((c) => c.metadata?.sunfood_user_id === userId);
    if (found) return found.id;
  }
  const c = await (await stripe()).customers.create({
    email: email || undefined,
    name: name || undefined,
    metadata: { sunfood_user_id: userId },
  });
  return c.id;
}

// Cartão salvo só pra compras com o cliente presente (on_session): o SunFood
// nunca cobra sozinho depois.
async function createCustomerSession(customer) {
  const cs = await (await stripe()).customerSessions.create({
    customer,
    components: {
      payment_element: {
        enabled: true,
        features: {
          payment_method_save: "enabled",
          payment_method_save_usage: "on_session",
          payment_method_redisplay: "enabled",
          payment_method_remove: "enabled",
        },
      },
    },
  });
  return cs.client_secret;
}

// Titular do cartão: o nome vai também no billing_details (pelo app, no
// confirmPayment), que o antifraude do Stripe usa. Do CPF, só os 3 primeiros
// e os 2 últimos dígitos: o bastante pra conferir o titular numa contestação,
// sem deixar o CPF inteiro no painel e nos webhooks do Stripe (o Stripe pede
// para não guardar dado pessoal sensível em metadata).
export const maskHolderCpf = (cpf) => `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`;

export async function setCardHolder(paymentIntentId, { name, cpf }) {
  await (await stripe()).paymentIntents.update(paymentIntentId, {
    metadata: { holder_name: name, holder_cpf: maskHolderCpf(cpf) },
  });
}

// PIX pelo Stripe: cria e confirma o PaymentIntent no servidor e devolve o
// QR (imagem e copia-e-cola). O pedido só é liberado pelo webhook
// payment_intent.succeeded, depois que o banco do cliente confirma.
export async function createStripePix({ orderId, amount, payerEmail, description, expiresInMinutes, existingId }) {
  const cents = Math.round(Number(amount) * 100);
  // PIX do pedido ainda em aberto (ex.: o cliente recarregou a página): mostra
  // o mesmo QR em vez de gerar outra cobrança.
  if (existingId) {
    const old = await (await stripe()).paymentIntents.retrieve(existingId).catch(() => null);
    const qr = old?.next_action?.pix_display_qr_code;
    const valid = !qr?.expires_at || qr.expires_at * 1000 > Date.now() + 60 * 1000;
    if (old && PAID_OR_PAYING.includes(old.status)) throw new AlreadyPaidError(old.id);
    if (old && old.status === "requires_action" && old.amount === cents && qr?.data && valid) return pixResult(old);
    // QR vencido ou valor diferente: o antigo é fechado antes de gerar outro,
    // pra o cliente não conseguir pagar os dois (auditoria R3-A1).
    if (old) await closeStaleIntent(old);
  }
  // Mesma chave para dois pedidos simultâneos (clique duplo): uma cobrança só.
  const idempotencyKey = `sunfood-pix-${orderId}-${existingId || "1"}`;
  const pi = await (await stripe()).paymentIntents.create({
    amount: cents,
    currency: "brl",
    payment_method_types: ["pix"],
    payment_method_data: { type: "pix" },
    payment_method_options: { pix: { expires_after_seconds: expiresInMinutes * 60 } },
    confirm: true,
    description: description || `Pedido SunFood #${orderId}`,
    receipt_email: payerEmail || undefined,
    metadata: { order_id: orderId },
  }, { idempotencyKey });
  return pixResult(pi);
}

function pixResult(pi) {
  const qr = pi.next_action?.pix_display_qr_code || {};
  return {
    paymentIntentId: pi.id,
    qrCode: qr.data || null,
    qrCodeImageUrl: qr.image_url_png || null,
    expiresAt: qr.expires_at ? new Date(qr.expires_at * 1000).toISOString() : null,
    // No modo de teste, essa página do Stripe tem o botão de simular o pagamento.
    instructionsUrl: qr.hosted_instructions_url || null,
  };
}

// Rebusca o PaymentIntent na API (o webhook só avisa que algo mudou).
// key: a conta de onde veio o webhook (pode ser uma conta anterior).
export async function fetchPaymentIntent(id, key) {
  const pi = await (key ? stripe(key) : stripe()).then((api) => api.paymentIntents.retrieve(id));
  return {
    orderId: pi.metadata?.order_id || null,
    paid: pi.status === "succeeded",
    status: pi.status,
    amount: Number(pi.amount_received) / 100,
    paymentIntentId: pi.id,
  };
}

// Confere a assinatura do webhook (cabeçalho Stripe-Signature) sobre o corpo
// cru da requisição. Lança erro se não bater.
// Vale o segredo do webhook criado pelo painel, os das contas anteriores e o
// da variável STRIPE_WEBHOOK_SECRET. Devolve também a chave da conta dona do
// segredo que bateu: o evento é rebuscado nela, não na conta atual.
export async function constructStripeEvent(rawBody, signatureHeader) {
  const cfg = await stripeSettings();
  const accounts = [
    { secretKey: cfg.secretKey, webhookSecret: cfg.webhookSecret },
    ...(cfg.previous || []),
  ].filter((a) => a.secretKey && a.webhookSecret);
  if (!accounts.length) throw new Error("Segredo do webhook do Stripe não configurado.");
  let last;
  for (const a of accounts) {
    try {
      return { event: (await stripe(a.secretKey)).webhooks.constructEvent(rawBody, signatureHeader, a.webhookSecret), key: a.secretKey };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// Nunca confiar só no corpo do webhook: a sessão é rebuscada na API do
// Stripe com a nossa chave antes de liberar o pedido.
export async function fetchCheckoutSession(sessionId, key) {
  const s = await (key ? stripe(key) : stripe()).then((api) => api.checkout.sessions.retrieve(sessionId));
  return {
    orderId: s.client_reference_id || s.metadata?.order_id || null,
    paid: s.payment_status === "paid",
    status: s.status, // 'open' | 'complete' | 'expired'
    amount: Number(s.amount_total) / 100,
    paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || null,
  };
}

// Devolve um pagamento aprovado no Stripe: o que falta devolver (sem amount)
// ou só parte dele (amountCents). O motivo e quem estornou vão no metadata,
// pra o webhook charge.refunded registrar o estorno com os mesmos dados.
// idempotencyKey: dois cliques no mesmo estorno não devolvem duas vezes.
export async function refundStripePayment(paymentIntentId, { amountCents, metadata, idempotencyKey } = {}) {
  const body = { payment_intent: paymentIntentId };
  if (amountCents) body.amount = amountCents;
  if (metadata) body.metadata = metadata;
  const r = await onPaymentAccount((api) => api.refunds.create(body, idempotencyKey ? { idempotencyKey } : undefined));
  return { simulated: false, refundId: r.id, status: r.status, amountCents: r.amount };
}

// Rebusca a cobrança e os estornos dela na API (o webhook charge.refunded só
// avisa que algo mudou). Pega estornos feitos direto no painel do Stripe.
export async function fetchChargeRefunds(chargeId, key) {
  const c = await (key ? stripe(key) : stripe()).then((api) => api.charges.retrieve(chargeId, { expand: ["refunds"] }));
  return {
    paymentIntentId: typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id || null,
    amountRefunded: Number(c.amount_refunded) / 100,
    fullyRefunded: !!c.refunded,
    refunds: (c.refunds?.data || [])
      .filter((r) => r.status === "succeeded" || r.status === "pending")
      .map((r) => ({ id: r.id, amount: Number(r.amount) / 100, metadata: r.metadata || {} })),
  };
}

// Pedido cancelado ou vencido sem pagamento (auditoria B4): fecha o
// PaymentIntent, pra o cartão ou o PIX não poderem mais ser cobrados depois.
export async function cancelStripePaymentIntent(id) {
  await onPaymentAccount((api) => api.paymentIntents.cancel(id));
}

// Rebusca um PaymentIntent em qualquer conta (atual ou anterior).
export async function findPaymentIntent(id) {
  const pi = await onPaymentAccount((api) => api.paymentIntents.retrieve(id));
  return { paid: pi.status === "succeeded", status: pi.status, amount: Number(pi.amount_received) / 100 };
}

// Conta excluída (LGPD, auditoria M11): apaga o cliente no Stripe, com os
// cartões salvos. Só o cliente criado para este usuário (metadata).
// Também nas contas anteriores, onde os cartões salvos antes da troca ficaram.
export async function deleteStripeCustomer({ userId, email }) {
  if (!email) return;
  const cfg = await stripeSettings();
  const keys = [...new Set([cfg.secretKey, ...(cfg.previous || []).map((p) => p.secretKey)].filter(Boolean))];
  for (const [i, k] of keys.entries()) {
    try {
      const api = await stripe(k);
      const list = await api.customers.list({ email, limit: 20 });
      for (const c of list.data.filter((c) => c.metadata?.sunfood_user_id === userId)) await api.customers.del(c.id);
    } catch (e) {
      // A conta atual precisa dar certo; as anteriores são o melhor possível.
      if (i === 0) throw e;
      console.warn("Cliente não apagado numa conta anterior do Stripe:", e.message);
    }
  }
}
