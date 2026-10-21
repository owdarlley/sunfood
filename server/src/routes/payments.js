import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  PAYMENT_WINDOW_MINUTES,
  stripeConfigured,
  stripeTestMode,
  createStripeCheckout,
  constructStripeEvent,
  fetchCheckoutSession,
  stripePublishableKey,
  createOrReuseCardIntent,
  createCardSession,
  fetchPaymentIntent,
  createStripePix,
  setCardHolder,
  isStripePaymentId,
} from "../payments/stripe.js";
import { syncStripeRefunds } from "../order-refunds.js";
import { refundWholeOrder, refundDuplicatePayment, approveOrderPayment, LATE_PAYMENT_REASON } from "../order-payments.js";
import { isValidCpf, onlyDigits } from "../validation/cpf.js";
import { cardCheckoutSchema, validate } from "../validation/schemas.js";
import { paymentCoversOrder } from "../business-rules.js";
import { limiter } from "../rate-limit.js";

export const paymentsRouter = Router();

const sessionLimiter = limiter("card-session", {
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: "Muitas tentativas de pagamento. Tente novamente em alguns minutos." },
});

const pixLimiter = limiter("pix", {
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: { error: "Muitas tentativas de pagamento. Tente novamente em alguns minutos." },
});

// O front usa isso pra saber se mostra o QR real ou o aviso de "ambiente de
// testes" — nunca finge que está cobrando de verdade sem chave configurada.
// PIX e cartão são cobrados pelo Stripe. Sem STRIPE_SECRET_KEY, os dois são
// aprovados na hora como "provisório" (fora de produção).
const provider = () => (stripeConfigured ? "stripe" : "provisorio");
paymentsRouter.get("/status", (req, res) =>
  res.json({
    pix: provider(),
    card: provider(),
    cardTestMode: stripeConfigured && stripeTestMode,
    // Com a chave publicável, o app mostra os campos do cartão na própria tela.
    stripePublishableKey: stripeConfigured ? stripePublishableKey : null,
  })
);

// Mesma lista de origens do CORS (app.js): o Stripe só pode mandar o
// cliente de volta pro próprio app, nunca pra um site qualquer.
const APP_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:8000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

async function loadOwnUnpaidOrder(req, res, method) {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", req.params.orderId)
    .maybeSingle();
  if (error || !order) {
    res.status(404).json({ error: "Pedido não encontrado." });
    return null;
  }
  if (order.customer_id !== req.user.sub) {
    res.status(403).json({ error: "Sem permissão para este pedido." });
    return null;
  }
  if (order.payment_status === "approved") {
    res.status(409).json({ error: "Este pedido já está pago." });
    return null;
  }
  if (order.payment_method !== method || order.status !== "Na Fila") {
    res.status(409).json({ error: "Este pedido não pode mais ser pago por aqui." });
    return null;
  }
  return order;
}

// Provisório, até o Stripe ser configurado: PIX e cartão são aprovados
// na hora, sem cobrança real (pedido do dono do quiosque). Ficam marcados com
// payment_provider "provisorio" pra aparecer assim no Admin. Sem payment_id,
// cancelar não tenta estorno.
async function approveProvisionally(order, res) {
  // Em produção, falta de chave é erro de configuração, nunca pedido de graça.
  if (process.env.VERCEL_ENV === "production") {
    console.error("Pagamento sem provedor configurado em produção:", order.id);
    return res.status(503).json({ error: "Pagamento online indisponível no momento. Escolha pagar na entrega." });
  }
  const { error } = await supabaseAdmin
    .from("orders")
    .update({ payment_status: "approved", payment_provider: "provisorio" })
    .eq("id", order.id);
  if (error) return res.status(500).json({ error: "Não foi possível registrar o pagamento." });
  res.json({ provisional: true, paymentStatus: "approved" });
}

// Cliente: gera a cobrança PIX do próprio pedido.
paymentsRouter.post("/pix/:orderId", requireAuth, requireRole("cliente"), pixLimiter, async (req, res) => {
  const order = await loadOwnUnpaidOrder(req, res, "pix");
  if (!order) return;
  if (provider() === "provisorio") return approveProvisionally(order, res);

  try {
    const pix = await createStripePix({
      orderId: order.id,
      amount: Number(order.total),
      payerEmail: req.user.email,
      description: `Pedido Sunfood — mesa ${order.table_number}`,
      expiresInMinutes: PAYMENT_WINDOW_MINUTES,
      existingId: order.payment_provider === "stripe" && isStripePaymentId(order.payment_id) ? order.payment_id : null,
    });
    await supabaseAdmin
      .from("orders")
      .update({ payment_provider: "stripe", payment_id: pix.paymentIntentId })
      .eq("id", order.id);
    res.json({
      qrCode: pix.qrCode,
      qrCodeImageUrl: pix.qrCodeImageUrl,
      testPayUrl: stripeTestMode ? pix.instructionsUrl : null,
      status: "pending",
      expiresAt: pix.expiresAt,
    });
  } catch (e) {
    console.error("Erro ao criar PIX no Stripe:", e);
    res.status(502).json({ error: "O PIX está indisponível no momento. Escolha cartão ou pagar na entrega." });
  }
});

// Cliente: abre o checkout de cartão do Stripe pro próprio pedido (quando o
// app não tem a chave publicável pra mostrar os campos na tela). O app
// redireciona pra checkoutUrl e o cliente volta pra returnUrl depois; a
// confirmação chega pelo webhook, como no PIX.
paymentsRouter.post(
  "/card/:orderId",
  requireAuth,
  requireRole("cliente"),
  pixLimiter,
  validate(cardCheckoutSchema),
  async (req, res) => {
    const order = await loadOwnUnpaidOrder(req, res, "cartao");
    if (!order) return;

    if (provider() === "provisorio") return approveProvisionally(order, res);

    const returnUrl = new URL(req.body.returnUrl);
    if (!APP_ORIGINS.includes(returnUrl.origin)) {
      return res.status(400).json({ error: "Endereço de retorno não permitido." });
    }
    returnUrl.searchParams.set("pedido", order.id);

    // Desistiu na página do Stripe: volta com status=failure e o app mostra
    // a tela de "não foi possível pagar", com a opção de tentar de novo.
    const cancelUrl = new URL(returnUrl);
    cancelUrl.searchParams.set("status", "failure");
    try {
      const checkout = await createStripeCheckout({
        orderId: order.id,
        amount: Number(order.total),
        payerEmail: req.user.email,
        successUrl: returnUrl.toString(),
        cancelUrl: cancelUrl.toString(),
        description: `Pedido Sunfood — mesa ${order.table_number}`,
        expiresInMinutes: PAYMENT_WINDOW_MINUTES,
      });
      await supabaseAdmin.from("orders").update({ payment_provider: "stripe" }).eq("id", order.id);
      res.json({ checkoutUrl: checkout.checkoutUrl });
    } catch (e) {
      console.error("Erro ao criar checkout do Stripe:", e);
      res.status(502).json({ error: "Falha ao abrir o pagamento com cartão. Tente novamente." });
    }
  }
);

// Sessão do cliente no Stripe (cartões salvos e a caixa "salvar cartão"),
// pedida pelo app assim que o cliente chega no carrinho. Com ela e a chave
// publicável, os campos do cartão aparecem antes de o pedido existir.
paymentsRouter.post("/card-session", requireAuth, requireRole("cliente"), sessionLimiter, async (req, res) => {
  if (!stripeConfigured || !stripePublishableKey) {
    return res.status(409).json({ error: "Pagamento com cartão no app indisponível." });
  }
  try {
    const session = await createCardSession({ userId: req.user.sub, email: req.user.email, name: req.user.name });
    res.json({ ...session, publishableKey: stripePublishableKey });
  } catch (e) {
    console.error("Erro ao criar sessão do cliente no Stripe:", e);
    res.status(502).json({ error: "Falha ao preparar o pagamento com cartão." });
  }
});

// Cliente: campos do cartão dentro do app (Stripe Payment Element). Devolve o
// client_secret do PaymentIntent do pedido; quem aprova o pedido continua
// sendo o webhook (payment_intent.succeeded), nunca o navegador.
paymentsRouter.post("/card-intent/:orderId", requireAuth, requireRole("cliente"), pixLimiter, async (req, res) => {
  if (!stripeConfigured || !stripePublishableKey) {
    return res.status(409).json({ error: "Pagamento com cartão no app indisponível." });
  }
  const order = await loadOwnUnpaidOrder(req, res, "cartao");
  if (!order) return;
  try {
    const intent = await createOrReuseCardIntent({
      orderId: order.id,
      amount: Number(order.total),
      payerEmail: req.user.email,
      payerName: req.user.name,
      userId: req.user.sub,
      description: `Pedido Sunfood — mesa ${order.table_number}`,
      existingId: String(order.payment_id || "").startsWith("pi_") ? order.payment_id : null,
      // ?session=0: o app já pegou a sessão do cliente em /card-session.
      withSession: req.query.session !== "0",
    });
    // payment_id guarda o PaymentIntent desde já: é por ele que o webhook e
    // o estorno acham o pagamento. needsRefund só estorna se estiver aprovado.
    await supabaseAdmin
      .from("orders")
      .update({ payment_provider: "stripe", payment_id: intent.paymentIntentId })
      .eq("id", order.id);
    res.json({
      clientSecret: intent.clientSecret,
      amount: intent.amount,
      publishableKey: stripePublishableKey,
      customerSessionClientSecret: intent.customerSessionClientSecret,
    });
  } catch (e) {
    console.error("Erro ao criar PaymentIntent do Stripe:", e);
    res.status(502).json({ error: "Falha ao abrir o pagamento com cartão. Tente novamente." });
  }
});

// Cliente: nome e CPF do titular do cartão, conferidos antes de confirmar o
// pagamento no app. O CPF precisa ter os dígitos verificadores certos.
paymentsRouter.post("/card-holder/:orderId", requireAuth, requireRole("cliente"), pixLimiter, async (req, res) => {
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
  const cpf = onlyDigits(req.body?.cpf);
  if (name.length < 5 || !name.includes(" ") || name.length > 80) {
    return res.status(400).json({ error: "Informe o nome completo do titular, como está no cartão." });
  }
  if (!isValidCpf(cpf)) return res.status(400).json({ error: "CPF do titular inválido. Confira os números." });
  const order = await loadOwnUnpaidOrder(req, res, "cartao");
  if (!order) return;
  if (!isStripePaymentId(order.payment_id)) {
    return res.status(409).json({ error: "Abra o pagamento com cartão de novo." });
  }
  try {
    await setCardHolder(order.payment_id, { name, cpf });
    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao salvar o titular no Stripe:", e);
    res.status(502).json({ error: "Falha ao registrar o titular do cartão. Tente novamente." });
  }
});

// Cliente: consulta o status de pagamento do próprio pedido — usado pro app
// dar polling além de depender só do webhook (rede de segurança).
paymentsRouter.get("/pix/:orderId/status", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("customer_id, payment_status")
    .eq("id", req.params.orderId)
    .maybeSingle();
  if (error || !order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (order.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para este pedido." });
  }
  res.json({ paymentStatus: order.payment_status });
});

// Stripe chama isso quando o pagamento com cartão termina (página do Stripe
// ou campos dentro do app). A assinatura (Stripe-Signature) é conferida sobre
// o corpo cru (ver app.js) e a sessão ou o PaymentIntent é rebuscado na API
// do Stripe antes de liberar o pedido.
paymentsRouter.post("/stripe/webhook", async (req, res) => {
  if (!stripeConfigured) return res.status(200).end();

  let event;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : typeof req.body === "string" ? req.body : null;
    if (!raw) throw new Error("Corpo cru indisponível.");
    event = constructStripeEvent(raw, req.headers["stripe-signature"]);
  } catch (e) {
    console.error("Webhook do Stripe recusado:", e.message);
    return res.status(400).json({ error: "Assinatura inválida." });
  }

  // Estorno feito no painel do Stripe (ou pelo app): acerta o pedido.
  if (event.type === "charge.refunded") {
    try {
      await syncStripeRefunds(event.data.object.id);
      return res.status(200).end();
    } catch (e) {
      console.error("Erro ao registrar estorno do Stripe:", e);
      return res.status(500).end();
    }
  }

  const checkoutEvents = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
  const isIntent = event.type === "payment_intent.succeeded";
  if (!isIntent && !checkoutEvents.includes(event.type)) return res.status(200).end();

  try {
    const session = isIntent
      ? await fetchPaymentIntent(event.data.object.id)
      : await fetchCheckoutSession(event.data.object.id);
    if (!session.orderId || !session.paid || !session.paymentIntentId) return res.status(200).end();

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", session.orderId)
      .maybeSingle();
    if (!order || order.payment_method === "entrega") return res.status(200).end();
    if (order.payment_status === "approved" || order.payment_status === "refunded") {
      // Mesmo pagamento chegando de novo (checkout.session.completed e
      // payment_intent.succeeded) é ignorado; outro pagamento é cobrança em dobro.
      if (order.payment_id && order.payment_id !== session.paymentIntentId) {
        await refundDuplicatePayment(order, session.paymentIntentId);
      }
      return res.status(200).end();
    }

    if (!paymentCoversOrder(session.amount, order.total)) {
      console.error("Pagamento Stripe com valor menor que o pedido:", session.paymentIntentId, session.amount, order.total);
      return res.status(200).end();
    }
    // Pagou depois de o pedido já ter saído da fila: devolve o dinheiro.
    if (order.status === "Cancelado") {
      const { refundedTotal } = await refundWholeOrder({ ...order, payment_id: session.paymentIntentId, refunded_amount: 0 },
        session.paymentIntentId, LATE_PAYMENT_REASON, { paidCents: Math.round(session.amount * 100) });
      await supabaseAdmin
        .from("orders")
        .update({ payment_status: "refunded", payment_provider: "stripe", payment_id: session.paymentIntentId,
          refunded_amount: Math.min(refundedTotal, Number(order.total)) })
        .eq("id", order.id);
      return res.status(200).end();
    }
    await approveOrderPayment(order, session.paymentIntentId, { payment_provider: "stripe" });
    res.status(200).end();
  } catch (e) {
    console.error("Erro ao processar webhook do Stripe:", e);
    res.status(500).end();
  }
});
