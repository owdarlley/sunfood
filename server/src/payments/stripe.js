import Stripe from "stripe";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Com STRIPE_SECRET_KEY configurada, o cartão passa a ser cobrado pelo Stripe
// (Checkout hospedado); o PIX continua no Mercado Pago. A chave fica só na
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
