import { supabaseAdmin } from "./supabase.js";
import { refundPayment } from "./payments/mercadopago.js";
import { isStripePaymentId, refundStripePayment, fetchChargeRefunds } from "./payments/stripe.js";

const cents = (v) => Math.round(Number(v || 0) * 100);

// Status em que o admin ainda pode tirar o pedido da cozinha.
export const ADMIN_CANCELLABLE = ["Na Fila", "Em Preparo", "Pronto"];

// Quanto ainda dá pra devolver: o que foi pago no app menos o já estornado.
// "Pagar na entrega" e pedido não pago não têm nada a devolver por aqui.
export function refundableCents(row) {
  if (row.payment_method === "entrega" || row.payment_status !== "approved" || !row.payment_id) return 0;
  return Math.max(0, cents(row.total) - cents(row.refunded_amount));
}

const fail = (httpStatus, error) => ({ ok: false, httpStatus, error });

// Estorno pelo painel do admin.
//   cancel: tira o pedido da cozinha e devolve tudo o que falta devolver.
//   parcial: devolve amountCents e o pedido continua.
// O dinheiro volta antes de qualquer mudança no pedido: se o Stripe ou o
// Mercado Pago recusar, nada muda.
export async function refundOrderByAdmin(row, { cancel, amountCents, reason, actor }) {
  // A tabela de estornos vem da migração 20261017210000; sem ela não dá pra
  // registrar, então nem chega a devolver.
  const { error: tableError } = await supabaseAdmin.from("order_refunds").select("id").eq("order_id", row.id);
  if (tableError) return fail(503, "Estorno pelo painel ainda não liberado: falta rodar o SQL do estorno no Supabase.");

  if (row.status === "Cancelado") return fail(409, "Este pedido já foi cancelado.");
  if (cancel && !ADMIN_CANCELLABLE.includes(row.status)) {
    return fail(409, "Pedido já entregue: use o estorno parcial ou total sem cancelar.");
  }
  const remaining = refundableCents(row);
  const amount = cancel ? remaining : amountCents;
  if (!cancel) {
    if (!remaining) return fail(409, "Nada a estornar: o pedido não foi pago no app ou já foi estornado.");
    if (!amount || amount < 1 || amount > remaining) {
      return fail(400, `Valor do estorno precisa estar entre R$ 0,01 e ${(remaining / 100).toFixed(2).replace(".", ",")}.`);
    }
  }

  let refundedNow = 0;
  if (amount > 0) {
    const stripe = isStripePaymentId(row.payment_id);
    let result;
    try {
      result = stripe
        ? await refundStripePayment(row.payment_id, {
            amountCents: amount,
            metadata: { order_id: row.id, sunfood_reason: reason.slice(0, 200), sunfood_actor: actor || "" },
            // Mesmo pedido, mesmo valor já devolvido e mesmo pedido de estorno = mesma chave.
            idempotencyKey: `sunfood-refund-${row.id}-${cents(row.refunded_amount)}-${amount}`,
          })
        : await refundPayment(row.payment_id, amount === remaining ? undefined : amount / 100);
    } catch (e) {
      console.error("Erro ao estornar pelo painel:", e);
      return fail(502, "Não foi possível estornar o pagamento. Tente novamente.");
    }
    refundedNow = amount;
    const { error } = await supabaseAdmin.from("order_refunds").insert({
      order_id: row.id,
      amount: amount / 100,
      reason,
      provider: stripe ? "stripe" : "mercadopago",
      provider_refund_id: result.refundId || null,
      actor: actor || null,
    });
    // Já registrado pelo webhook (mesmo id do estorno): tudo bem.
    if (error && error.code !== "23505") console.error("Estorno feito mas não registrado:", row.id, error);
    const total = cents(row.refunded_amount) + amount;
    await supabaseAdmin
      .from("orders")
      .update({ refunded_amount: total / 100, payment_status: total >= cents(row.total) ? "refunded" : "approved" })
      .eq("id", row.id);
  }

  if (cancel) {
    const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
      p_order_id: row.id,
      p_status: "Cancelado",
      p_actor: actor || null,
    });
    if (rpcError) {
      console.error("Erro ao cancelar pelo painel:", row.id, rpcError);
      if (refundedNow) return fail(500, "O valor foi estornado, mas o pedido não saiu da fila. Tente cancelar de novo.");
      return fail(500, "Não foi possível cancelar o pedido.");
    }
    // Não pago no app (ou "pagar na entrega"): não há o que devolver.
    if (!refundedNow && row.payment_method !== "entrega" && row.payment_status === "pending") {
      await supabaseAdmin.from("orders").update({ payment_status: "cancelled" }).eq("id", row.id);
    }
  }
  return { ok: true, refunded: refundedNow / 100 };
}

// Webhook charge.refunded: registra estornos feitos fora do app (painel do
// Stripe) e acerta o total estornado do pedido. Os dados vêm da API, não do
// corpo do webhook.
export async function syncStripeRefunds(chargeId) {
  const charge = await fetchChargeRefunds(chargeId);
  if (!charge.paymentIntentId) return;
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("payment_id", charge.paymentIntentId)
    .maybeSingle();
  if (!order) return;
  const { data: known, error } = await supabaseAdmin.from("order_refunds").select("provider_refund_id").eq("order_id", order.id);
  if (error) return; // SQL do estorno ainda não rodado
  const seen = new Set((known || []).map((r) => r.provider_refund_id));
  for (const r of charge.refunds) {
    if (seen.has(r.id)) continue;
    const { error: insertError } = await supabaseAdmin.from("order_refunds").insert({
      order_id: order.id,
      amount: r.amount,
      reason: r.metadata.sunfood_reason || "Estorno feito no painel do Stripe",
      provider: "stripe",
      provider_refund_id: r.id,
      actor: r.metadata.sunfood_actor || null,
    });
    if (insertError && insertError.code !== "23505") console.error("Estorno do Stripe não registrado:", r.id, insertError);
  }
  await supabaseAdmin
    .from("orders")
    .update({
      refunded_amount: charge.amountRefunded,
      payment_status: charge.fullyRefunded || cents(charge.amountRefunded) >= cents(order.total) ? "refunded" : order.payment_status,
    })
    .eq("id", order.id);
}
