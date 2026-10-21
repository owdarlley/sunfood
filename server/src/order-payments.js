import { supabaseAdmin } from "./supabase.js";
import { needsRefund } from "./business-rules.js";
import { PAYMENT_WINDOW_MINUTES } from "./payments/stripe.js";
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

// Aprova o pedido com este pagamento, só se ninguém aprovou antes (dois
// webhooks ao mesmo tempo). Se outro pagamento ganhou, este é estornado.
export async function approveOrderPayment(order, paymentId, extra = {}) {
  const { data: won } = await supabaseAdmin
    .from("orders")
    .update({ ...extra, payment_status: "approved", payment_id: paymentId })
    .eq("id", order.id)
    .eq("payment_status", order.payment_status)
    .select("id");
  if (won?.length) return;
  const { data: now } = await supabaseAdmin.from("orders").select("*").eq("id", order.id).maybeSingle();
  if (now && now.payment_id && String(now.payment_id) !== String(paymentId)
      && ["approved", "refunded"].includes(now.payment_status)) {
    await refundDuplicatePayment(now, paymentId);
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
  if (row.payment_method !== "entrega" && (row.payment_status === "pending" || row.payment_provider === "provisorio")) {
    await supabaseAdmin.from("orders").update({ payment_status: "cancelled" }).eq("id", row.id);
  }
  return { ok: true, refunded: false };
}

// Pedido cancelado que continua pago no app: estorno que falhou no
// cancelamento, ou pagamento que chegou enquanto o pedido era cancelado.
// Só olha as últimas 24 horas, pra nunca mexer em pedido antigo.
export async function retryPendingRefunds() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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
    if (!rpcError) await supabaseAdmin.from("orders").update({ payment_status: "cancelled" }).eq("id", id);
  }
  await retryPendingRefunds();
}

// Mesma limpeza, chamada de rotas que muitos clientes usam (cardápio, novo
// pedido): roda no máximo uma vez por minuto em cada instância da API. Sem
// isso, um PIX abandonado só saía da fila (e só devolvia o estoque) quando
// alguém da equipe abria a lista de pedidos.
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
