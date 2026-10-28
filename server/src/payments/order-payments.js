import { supabaseAdmin } from "../lib/supabase.js";
import { needsRefund } from "../validation/business-rules.js";
import { PAYMENT_WINDOW_MINUTES, stripeStatus, isStripePaymentId, cancelStripePaymentIntent } from "./stripe.js";
import { recordRefund, refundAtProvider } from "./order-refunds.js";

// Motivos que o cliente vê nos detalhes do pedido.
export const CUSTOMER_CANCEL_REASON = "Você cancelou o pedido";
export const LATE_PAYMENT_REASON = "O pagamento chegou depois que o pedido já tinha saído da fila";

const cents = (v) => Math.round(Number(v || 0) * 100);

// Devolve o que falta devolver de um pagamento e anota no histórico de
// estornos do pedido. paidCents: quanto esse pagamento cobrou (padrão: o
// total do pedido). Se já houve estorno parcial, devolve só o saldo.
export async function refundWholeOrder(row, paymentId, reason, { paidCents } = {}) {
  const already = String(row.payment_id || "") === String(paymentId) ? cents(row.refunded_amount) : 0;
  const amountCents = Math.max(0, (paidCents ?? cents(row.total)) - already);
  const result = await refundAtProvider(paymentId, {
    amountCents: already ? amountCents : undefined,
    key: `sunfood-full-${paymentId}-${already}`,
    metadata: { order_id: row.id, sunfood_reason: reason },
  });
  await recordRefund(row.id, {
    amount: amountCents / 100,
    reason,
    provider: "stripe",
    refundId: result?.refundId,
  });
  return { ...result, refundedTotal: (already + amountCents) / 100 };
}

// Segundo pagamento aprovado para um pedido que já estava pago (dois QR Codes,
// duas abas de checkout): devolve esse pagamento inteiro. Não entra no
// histórico do pedido, que continua pago pelo primeiro.
export async function refundDuplicatePayment(order, paymentId) {
  console.warn("Pagamento em dobro estornado:", { order: order.id, kept: order.payment_id, refunded: paymentId });
  await refundAtProvider(paymentId, {
    key: `sunfood-duplicate-${paymentId}`,
    metadata: { order_id: order.id, sunfood_reason: "Pagamento em dobro" },
  });
}

// Pagamento que chegou depois de o pedido ter saído da fila: devolve o
// dinheiro. paidCents: quanto foi cobrado (padrão: o total do pedido).
export async function refundLatePayment(order, paymentId, { paidCents } = {}) {
  const { refundedTotal } = await refundWholeOrder({ ...order, payment_id: paymentId, refunded_amount: 0 },
    paymentId, LATE_PAYMENT_REASON, { paidCents });
  await supabaseAdmin
    .from("orders")
    .update({ payment_status: "refunded", payment_provider: "stripe", payment_id: paymentId,
      refunded_amount: Math.min(refundedTotal, Number(order.total)) })
    .eq("id", order.id);
}

// Aprova o pedido com este pagamento, só se ninguém mexeu no pagamento antes
// (dois webhooks ao mesmo tempo, ou o pedido sendo cancelado). Se outro
// pagamento ganhou, este é estornado. Se o pedido foi cancelado no meio do
// caminho (auditoria A1), o pagamento também volta: nenhum caminho deixa o
// cliente cobrado com o pedido cancelado e sem estorno.
export async function approveOrderPayment(order, paymentId, extra = {}, { paidCents } = {}) {
  const { data: won } = await supabaseAdmin
    .from("orders")
    .update({ ...extra, payment_status: "approved", payment_id: paymentId })
    .eq("id", order.id)
    .eq("payment_status", order.payment_status)
    .select("*");
  if (won?.length) {
    // Aprovou, mas o pedido foi cancelado entre a leitura e a gravação. Se o
    // estorno falhar, fica Cancelado e pago, e retryPendingRefunds tenta de novo.
    if (won[0].status === "Cancelado") await refundLatePayment(won[0], paymentId, { paidCents });
    return;
  }
  const { data: now } = await supabaseAdmin.from("orders").select("*").eq("id", order.id).maybeSingle();
  if (!now) return;
  if (["approved", "refunded"].includes(now.payment_status)) {
    if (now.payment_id && String(now.payment_id) !== String(paymentId)) await refundDuplicatePayment(now, paymentId);
    return;
  }
  // O cancelamento ganhou (pagamento "cancelled"): este pagamento chegou tarde.
  if (now.status === "Cancelado") await refundLatePayment(now, paymentId, { paidCents });
}

// Fecha o pagamento de um pedido que saiu da fila sem estar pago. A gravação
// só vale se o pagamento ainda estiver pendente (auditoria A1): se o webhook
// aprovou no meio do caminho, o dinheiro volta em vez de o "aprovado" ser
// apagado. Também fecha o PaymentIntent no Stripe (auditoria B4).
async function closeUnpaidPayment(id) {
  const { data: closed } = await supabaseAdmin
    .from("orders")
    .update({ payment_status: "cancelled" })
    .eq("id", id)
    .in("payment_status", ["pending", "rejected"])
    .select("id, payment_id");
  if (closed?.length) {
    const paymentId = closed[0].payment_id;
    if (isStripePaymentId(paymentId) && (await stripeStatus()).configured) {
      // Se o pagamento já estiver em andamento, o Stripe recusa e o webhook
      // que chegar depois estorna (approveOrderPayment).
      await cancelStripePaymentIntent(paymentId).catch((e) => console.warn("PaymentIntent não cancelado:", paymentId, e.message));
    }
    return { refunded: false };
  }
  const { data: now } = await supabaseAdmin.from("orders").select("*").eq("id", id).maybeSingle();
  if (!now || !needsRefund(now) || now.payment_provider === "provisorio") return { refunded: false };
  try {
    const { refundedTotal } = await refundWholeOrder(now, now.payment_id, CUSTOMER_CANCEL_REASON);
    await supabaseAdmin.from("orders").update({ payment_status: "refunded", refunded_amount: refundedTotal }).eq("id", id);
    return { refunded: true };
  } catch (e) {
    console.error("Pedido cancelado, estorno pendente:", id, e);
    return { refunded: false, refundPending: true };
  }
}

// Cancela um pedido e, se ele já foi pago no app, devolve o dinheiro.
// O pedido sai da fila PRIMEIRO (set_order_status trava a linha): se a
// cozinha já começou a preparar, nada é estornado e quem chamou recebe 409.
// Se o estorno falhar depois disso, o pedido fica cancelado e pago, e
// retryPendingRefunds tenta de novo (a chave de idempotência evita estorno em dobro).
export async function cancelOrderWithRefund(row) {
  const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
    p_order_id: row.id,
    p_status: "Cancelado",
  });
  if (rpcError) {
    if (String(rpcError.message || "").includes("invalid_transition")) {
      return { ok: false, httpStatus: 409, error: "O pedido já saiu da fila e não pode mais ser cancelado." };
    }
    return { ok: false, httpStatus: 500, error: "Não foi possível cancelar o pedido." };
  }

  if (needsRefund(row)) {
    try {
      const { refundedTotal } = await refundWholeOrder(row, row.payment_id, CUSTOMER_CANCEL_REASON);
      await supabaseAdmin.from("orders").update({ payment_status: "refunded", refunded_amount: refundedTotal }).eq("id", row.id);
      return { ok: true, refunded: true };
    } catch (e) {
      console.error("Pedido cancelado, estorno pendente:", row.id, e);
      return { ok: true, refunded: false, refundPending: true };
    }
  }
  if (row.payment_method === "entrega") return { ok: true, refunded: false };
  if (row.payment_provider === "provisorio") {
    await supabaseAdmin.from("orders").update({ payment_status: "cancelled" }).eq("id", row.id);
    return { ok: true, refunded: false };
  }
  return { ok: true, ...(await closeUnpaidPayment(row.id)) };
}

// Pedido cancelado que continua pago no app: estorno que falhou no
// cancelamento, ou pagamento que chegou enquanto o pedido era cancelado.
// Olha os últimos 30 dias (auditoria M8: com só 24 horas, um estorno que
// falhou num dia sem movimento ficava preso). O admin também pode estornar
// esse pedido pelo painel.
export const PENDING_REFUND_DAYS = 30;

export async function retryPendingRefunds() {
  const since = new Date(Date.now() - PENDING_REFUND_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("status", "Cancelado")
    .eq("payment_status", "approved")
    .in("payment_method", ["pix", "cartao"])
    .gte("created_at", since);
  if (error || !data) return;
  for (const row of data) {
    if (!needsRefund(row) || row.payment_provider === "provisorio") continue;
    try {
      const { refundedTotal } = await refundWholeOrder(row, row.payment_id, CUSTOMER_CANCEL_REASON);
      await supabaseAdmin.from("orders").update({ payment_status: "refunded", refunded_amount: refundedTotal }).eq("id", row.id);
    } catch (e) {
      console.error("Estorno pendente falhou de novo:", row.id, e);
    }
  }
}

// Pedido pago no app que ficou sem pagamento (cliente desistiu do PIX ou do
// cartão) sai da fila depois do prazo de pagamento, com folga pro webhook
// chegar — assim não segura estoque pra sempre. Se um pagamento atrasado
// chegar depois disso, o webhook estorna (ver payments.js).
const EXPIRE_AFTER_MINUTES = PAYMENT_WINDOW_MINUTES + 10;

export async function expireUnpaidOrders() {
  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("status", "Na Fila")
    .in("payment_method", ["pix", "cartao"])
    .eq("payment_status", "pending")
    .lt("created_at", cutoff);
  if (error || !data) return;
  for (const { id } of data) {
    const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", { p_order_id: id, p_status: "Cancelado" });
    if (!rpcError) await closeUnpaidPayment(id);
  }
}

// Libera o estoque de PIX/cartão abandonados, chamada de rotas que muitos
// usam (cardápio, novo pedido, lista da equipe): roda no máximo uma vez por
// minuto em cada instância da API. Só mexe no banco; os estornos pendentes,
// que chamam o Stripe, ficam fora das rotas públicas (auditoria M7) e rodam
// na limpeza completa (runMaintenance), chamada pelo Cron da Vercel e pela
// lista de pedidos da equipe.
let lastExpireRun = 0;
export async function expireUnpaidOrdersSoon(now = Date.now()) {
  if (now - lastExpireRun < 60 * 1000) return;
  lastExpireRun = now;
  try {
    await expireUnpaidOrders();
  } catch (e) {
    console.error("Erro ao expirar pedidos não pagos:", e);
  }
}

// Limpeza completa: pedidos vencidos e estornos pendentes.
export async function runMaintenance() {
  await expireUnpaidOrders();
  await retryPendingRefunds();
}

let lastMaintenanceRun = 0;
export async function runMaintenanceSoon(now = Date.now()) {
  if (now - lastMaintenanceRun < 5 * 60 * 1000) return;
  lastMaintenanceRun = now;
  try {
    await runMaintenance();
  } catch (e) {
    console.error("Erro na limpeza de pedidos:", e);
  }
}
