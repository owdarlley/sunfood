import Stripe from "stripe";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Chave publicável (pk_test_...): pode ir pro app, é ela que desenha os
// campos do cartão (Payment Element) dentro da tela de pagamento.
export const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || null;

// Com STRIPE_SECRET_KEY configurada, o cartão passa a ser cobrado pelo Stripe
// (campos no app com STRIPE_PUBLISHABLE_KEY, senão Checkout hospedado); o PIX continua no Mercado Pago. A chave fica só na
// variável de ambiente do servidor, nunca no repositório nem no front.
export const stripeConfigured = !!SECRET_KEY;
// Chave sk_test_/rk_test_: nada é cobrado de verdade (cartão 4242 4242 4242 4242).
export const stripeTestMode = /^(sk|rk)_test_/.test(SECRET_KEY || "");

let client = null;
function stripe() {
  if (!client) client = new Stripe(SECRET_KEY);
  return client;
}

// Pagamentos do Stripe são guardados no pedido pelo id do PaymentIntent.
export const isStripePaymentId = (id) => String(id || "").startsWith("pi_");

// Cria a página de pagamento do Stripe pro valor do pedido e devolve o link.
// Os dados do cartão são digitados lá — nunca passam pelo app nem por aqui.
// O pedido vai em client_reference_id e metadata pra casar com o webhook.
export async function createStripeCheckout({ orderId, amount, payerEmail, successUrl, cancelUrl, description, expiresInMinutes }) {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: Math.round(Number(amount) * 100),
          product_data: { name: description || `Pedido Sunfood #${orderId}` },
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
// Cartão salvo: cada cliente do Sunfood tem um Customer no Stripe (achado
// pelo e-mail + metadata sunfood_user_id, sem coluna nova no banco). O
// CustomerSession deixa o Payment Element mostrar a caixa "salvar cartão" e
// os cartões já salvos. O número do cartão fica só no Stripe.
export async function createOrReuseCardIntent({ orderId, amount, payerEmail, payerName, userId, description, existingId, withSession = true }) {
  const cents = Math.round(Number(amount) * 100);
  // As chamadas ao Stripe que não dependem uma da outra vão juntas, pra os
  // campos do cartão aparecerem mais rápido.
  const [customer, old] = await Promise.all([
    userId ? findOrCreateCustomer({ userId, email: payerEmail, name: payerName }) : null,
    existingId ? stripe().paymentIntents.retrieve(existingId) : null,
  ]);
  const reusable = old && old.amount === cents && (old.customer || null) === customer
    && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(old.status);
  const [pi, customerSessionClientSecret] = await Promise.all([
    reusable ? old : stripe().paymentIntents.create({
      amount: cents,
      currency: "brl",
      payment_method_types: ["card"],
      customer: customer || undefined,
      description: description || `Pedido Sunfood #${orderId}`,
      receipt_email: payerEmail || undefined,
      metadata: { order_id: orderId },
    }),
    customer && withSession ? createCustomerSession(customer) : null,
  ]);
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret, amount: pi.amount, customerSessionClientSecret };
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
    const list = await stripe().customers.list({ email, limit: 20 });
    const found = list.data.find((c) => c.metadata?.sunfood_user_id === userId);
    if (found) return found.id;
  }
  const c = await stripe().customers.create({
    email: email || undefined,
    name: name || undefined,
    metadata: { sunfood_user_id: userId },
  });
  return c.id;
}

// Cartão salvo só pra compras com o cliente presente (on_session): o Sunfood
// nunca cobra sozinho depois.
async function createCustomerSession(customer) {
  const cs = await stripe().customerSessions.create({
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
  await stripe().paymentIntents.update(paymentIntentId, {
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
    const old = await stripe().paymentIntents.retrieve(existingId).catch(() => null);
    const qr = old?.next_action?.pix_display_qr_code;
    const valid = !qr?.expires_at || qr.expires_at * 1000 > Date.now() + 60 * 1000;
    if (old && old.status === "requires_action" && old.amount === cents && qr?.data && valid) return pixResult(old);
  }
  // Mesma chave para dois pedidos simultâneos (clique duplo): uma cobrança só.
  const idempotencyKey = `sunfood-pix-${orderId}-${existingId || "1"}`;
  const pi = await stripe().paymentIntents.create({
    amount: cents,
    currency: "brl",
    payment_method_types: ["pix"],
    payment_method_data: { type: "pix" },
    payment_method_options: { pix: { expires_after_seconds: expiresInMinutes * 60 } },
    confirm: true,
    description: description || `Pedido Sunfood #${orderId}`,
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
export async function fetchPaymentIntent(id) {
  const pi = await stripe().paymentIntents.retrieve(id);
  return {
    orderId: pi.metadata?.order_id || null,
    paid: pi.status === "succeeded",
    amount: Number(pi.amount_received) / 100,
    paymentIntentId: pi.id,
  };
}

// Confere a assinatura do webhook (cabeçalho Stripe-Signature) sobre o corpo
// cru da requisição. Lança erro se não bater.
export function constructStripeEvent(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET não configurado.");
  return stripe().webhooks.constructEvent(rawBody, signatureHeader, WEBHOOK_SECRET);
}

// Nunca confiar só no corpo do webhook: a sessão é rebuscada na API do
// Stripe com a nossa chave antes de liberar o pedido.
export async function fetchCheckoutSession(sessionId) {
  const s = await stripe().checkout.sessions.retrieve(sessionId);
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
  const r = await stripe().refunds.create(body, idempotencyKey ? { idempotencyKey } : undefined);
  return { simulated: false, refundId: r.id, status: r.status, amountCents: r.amount };
}

// Rebusca a cobrança e os estornos dela na API (o webhook charge.refunded só
// avisa que algo mudou). Pega estornos feitos direto no painel do Stripe.
export async function fetchChargeRefunds(chargeId) {
  const c = await stripe().charges.retrieve(chargeId, { expand: ["refunds"] });
  return {
    paymentIntentId: typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id || null,
    amountRefunded: Number(c.amount_refunded) / 100,
    fullyRefunded: !!c.refunded,
    refunds: (c.refunds?.data || [])
      .filter((r) => r.status === "succeeded" || r.status === "pending")
      .map((r) => ({ id: r.id, amount: Number(r.amount) / 100, metadata: r.metadata || {} })),
  };
}
