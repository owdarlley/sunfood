import { supabaseAdmin } from "./supabase.js";
import { needsRefund } from "./business-rules.js";
import { refundPayment, PAYMENT_WINDOW_MINUTES } from "./payments/mercadopago.js";
import { isStripePaymentId, refundStripePayment } from "./payments/stripe.js";
import { recordRefund } from "./order-refunds.js";

// Motivos que o cliente vê nos detalhes do pedido.
export const CUSTOMER_CANCEL_REASON = "Você cancelou o pedido";
export const LATE_PAYMENT_REASON = "O pagamento chegou depois que o pedido já tinha saído da fila";

// Devolve tudo o que foi pago e anota no histórico de estornos do pedido.
// Cartão pelo Stripe guarda o id do PaymentIntent (pi_...); o resto é Mercado Pago.
export async function refundWholeOrder(row, paymentId, reason) {
  const stripe = isStripePaymentId(paymentId);
  const result = stripe
    ? await refundStripePayment(paymentId, { metadata: { order_id: row.id, sunfood_reason: reason } })
    : await refundPayment(paymentId);
  await recordRefund(row.id, {
    amount: Number(row.total),
    reason,
    provider: stripe ? "stripe" : "mercadopago",
    refundId: result?.refundId,
  });
  return result;
}

// Cancela um pedido e, se ele já foi pago no app, devolve o dinheiro antes.
// O estorno vem primeiro: se o Mercado Pago (ou o Stripe) recusar, nada muda e quem chamou
// recebe o erro (o pedido não fica cancelado com o dinheiro preso).
export async function cancelOrderWithRefund(row) {
  let refunded = false;
  if (needsRefund(row)) {
    try {
      await refundWholeOrder(row, row.payment_id, CUSTOMER_CANCEL_REASON);
      refunded = true;
    } catch (e) {
      console.error("Erro ao estornar pagamento:", e);
      return { ok: false, httpStatus: 502, error: "Não foi possível estornar o pagamento. Tente novamente." };
    }
  }

  const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
    p_order_id: row.id,
    p_status: "Cancelado",
  });
  if (rpcError && !refunded) return { ok: false, httpStatus: 500, error: "Não foi possível cancelar o pedido." };
  if (rpcError) console.error("Pedido estornado mas não cancelado:", row.id, rpcError);

  if (refunded) {
    await supabaseAdmin.from("orders").update({ payment_status: "refunded", refunded_amount: row.total }).eq("id", row.id);
  } else if (
    row.payment_method !== "entrega" &&
    (row.payment_status === "pending" || row.payment_provider === "provisorio")
  ) {
    await supabaseAdmin.from("orders").update({ payment_status: "cancelled" }).eq("id", row.id);
  }
  return { ok: true, refunded };
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
