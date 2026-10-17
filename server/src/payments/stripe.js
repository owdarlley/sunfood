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
export async function createOrReuseCardIntent({ orderId, amount, payerEmail, payerName, userId, description, existingId }) {
  const cents = Math.round(Number(amount) * 100);
  const customer = userId ? await findOrCreateCustomer({ userId, email: payerEmail, name: payerName }) : null;
  let pi = null;
  if (existingId) {
    const old = await stripe().paymentIntents.retrieve(existingId);
    const sameCustomer = (old.customer || null) === customer;
    if (old.amount === cents && sameCustomer && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(old.status)) pi = old;
  }
  if (!pi) {
    pi = await stripe().paymentIntents.create({
      amount: cents,
      currency: "brl",
      payment_method_types: ["card"],
      customer: customer || undefined,
      description: description || `Pedido Sunfood #${orderId}`,
      receipt_email: payerEmail || undefined,
      metadata: { order_id: orderId },
    });
  }
  const customerSessionClientSecret = customer ? await createCustomerSession(customer) : null;
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret, customerSessionClientSecret };
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
// confirmPayment), que o antifraude do Stripe usa; o CPF fica guardado no
// PaymentIntent pra identificar o titular numa contestação.
export async function setCardHolder(paymentIntentId, { name, cpf }) {
  await stripe().paymentIntents.update(paymentIntentId, {
    metadata: { holder_name: name, holder_cpf: cpf },
  });
}

// PIX pelo Stripe: cria e confirma o PaymentIntent no servidor e devolve o
// QR (imagem e copia-e-cola). O pedido só é liberado pelo webhook
// payment_intent.succeeded, depois que o banco do cliente confirma.
export async function createStripePix({ orderId, amount, payerEmail, description, expiresInMinutes }) {
  const pi = await stripe().paymentIntents.create({
    amount: Math.round(Number(amount) * 100),
    currency: "brl",
    payment_method_types: ["pix"],
    payment_method_data: { type: "pix" },
    payment_method_options: { pix: { expires_after_seconds: expiresInMinutes * 60 } },
    confirm: true,
    description: description || `Pedido Sunfood #${orderId}`,
    receipt_email: payerEmail || undefined,
    metadata: { order_id: orderId },
  });
  const qr = pi.next_action?.pix_display_qr_code || {};
  return {
    paymentIntentId: pi.id,
    qrCode: qr.data || null,
    qrCodeImageUrl: qr.image_url_png || null,
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

// Devolve o valor total de um pagamento aprovado no Stripe.
export async function refundStripePayment(paymentIntentId) {
  const r = await stripe().refunds.create({ payment_intent: paymentIntentId });
  return { simulated: false, refundId: r.id, status: r.status };
}
