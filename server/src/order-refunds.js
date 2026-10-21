import { supabaseAdmin } from "./supabase.js";
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

// "2x Água, 1x Pastel" (cabe no limite de 500 caracteres do metadata do Stripe).
const itemsLabel = (items) => items.map((it) => `${it.qty}x ${it.name}`).join(", ").slice(0, 500);
const parseItemsLabel = (label) =>
  String(label || "")
    .split(", ")
    .map((part) => /^(\d+)x (.+)$/.exec(part))
    .filter(Boolean)
    .map((m) => ({ name: m[2], qty: Number(m[1]) }));

const fail = (httpStatus, error) => ({ ok: false, httpStatus, error });

// Estorno no Stripe (o pedido guarda o id do PaymentIntent, pi_...). Sem
// amountCents devolve tudo o que falta. A chave de idempotência faz o mesmo
// estorno, pedido de novo (webhook repetido, gravação que falhou), não
// devolver duas vezes.
export async function refundAtProvider(paymentId, { amountCents, key, metadata }) {
  // Pedidos antigos do extinto modo simulado têm payment_id "sim_<pedido>":
  // nunca houve cobrança, então não há o que devolver.
  if (String(paymentId).startsWith("sim_")) return { simulated: true };
  if (!isStripePaymentId(paymentId)) {
    throw new Error(`Pagamento ${paymentId} não é do Stripe: estorne direto no provedor.`);
  }
  return refundStripePayment(paymentId, { amountCents, metadata, idempotencyKey: key });
}

// Grava um estorno no histórico do pedido. O mesmo estorno chegando de novo
// (painel + webhook do Stripe) é ignorado pelo índice único do id. Sem a
// coluna de itens (SQL 20261017220000 ainda não rodado), grava sem eles.
export async function recordRefund(orderId, { amount, reason, provider, refundId, actor, items }) {
  const row = {
    order_id: orderId,
    amount,
    reason,
    provider,
    provider_refund_id: refundId || null,
    actor: actor || null,
  };
  let { error } = await supabaseAdmin.from("order_refunds").insert(items?.length ? { ...row, items } : row);
  if (error && items?.length && (error.code === "PGRST204" || error.code === "42703")) {
    ({ error } = await supabaseAdmin.from("order_refunds").insert(row));
  }
  if (error && error.code !== "23505") console.error("Estorno feito mas não registrado:", orderId, error);
}

// O que o cliente vê dos estornos de cada pedido: valor, motivo, itens e
// quando. Quem da equipe estornou e o meio de pagamento ficam de fora.
export async function customerRefunds(orderIds) {
  const byOrder = new Map();
  if (!orderIds.length) return byOrder;
  const { data, error } = await supabaseAdmin
    .from("order_refunds")
    .select("*")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true });
  if (error) return byOrder;
  for (const r of data || []) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push({
      amount: Number(r.amount),
      reason: r.reason,
      items: (r.items || []).map((it) => ({ name: it.name, qty: it.qty })),
      at: r.created_at,
    });
  }
  return byOrder;
}

// Soma o estorno ao total já devolvido do pedido. A gravação só vale se
// ninguém mudou o total no meio (dois estornos parciais ao mesmo tempo); se
// mudou, relê e soma de novo, pra nenhum dos dois se perder.
async function addRefunded(row, amount) {
  let current = row.refunded_amount ?? 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const total = cents(current) + amount;
    const { data: won } = await supabaseAdmin
      .from("orders")
      .update({ refunded_amount: total / 100, payment_status: total >= cents(row.total) ? "refunded" : "approved" })
      .eq("id", row.id)
      .eq("refunded_amount", current)
      .select("id");
    if (won?.length) return;
    const { data: fresh } = await supabaseAdmin.from("orders").select("refunded_amount").eq("id", row.id).maybeSingle();
    if (!fresh) return;
    current = fresh.refunded_amount ?? 0;
  }
  console.error("Estorno feito mas o total devolvido não foi atualizado:", row.id, amount);
}

// Estorno pelo painel do admin.
//   cancel: tira o pedido da cozinha e devolve tudo o que falta devolver.
//   parcial: devolve amountCents e o pedido continua.
// O dinheiro volta antes de qualquer mudança no pedido: se o Stripe recusar,
// nada muda.
export async function refundOrderByAdmin(row, { cancel, amountCents, reason, actor, items }) {
  // A tabela de estornos vem da migração 20261017210000; sem ela não dá pra
  // registrar, então nem chega a devolver.
  const { error: tableError } = await supabaseAdmin.from("order_refunds").select("id").eq("order_id", row.id);
  if (tableError) return fail(503, "Estorno pelo painel ainda não liberado: falta rodar o SQL do estorno no Supabase.");

  // Cancelado e ainda pago (o estorno automático falhou): o admin consegue
  // devolver pelo painel (auditoria M8). Cancelado sem nada a devolver, não.
  const alreadyCancelled = row.status === "Cancelado";
  if (alreadyCancelled && !refundableCents(row)) return fail(409, "Este pedido já foi cancelado.");
  if (cancel && !alreadyCancelled && !ADMIN_CANCELLABLE.includes(row.status)) {
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
    let result;
    try {
      result = await refundAtProvider(row.payment_id, {
        amountCents: amount,
        metadata: {
          order_id: row.id,
          sunfood_reason: reason.slice(0, 200),
          sunfood_actor: actor || "",
          ...(cancel || !items?.length ? {} : { sunfood_items: itemsLabel(items) }),
        },
        // Mesmo pedido, mesmo valor já devolvido e mesmo pedido de estorno = mesma chave.
        key: `sunfood-refund-${row.id}-${cents(row.refunded_amount)}-${amount}`,
      });
    } catch (e) {
      console.error("Erro ao estornar pelo painel:", e);
      return fail(502, "Não foi possível estornar o pagamento. Tente novamente.");
    }
    refundedNow = amount;
    await recordRefund(row.id, {
      amount: amount / 100,
      reason,
      provider: "stripe",
      refundId: result.refundId,
      actor,
      // Itens só no estorno parcial: no cancelamento volta o pedido inteiro.
      items: cancel ? undefined : items,
    });
    await addRefunded(row, amount);
  }

  if (cancel && !alreadyCancelled) {
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
    await recordRefund(order.id, {
      amount: r.amount,
      reason: r.metadata.sunfood_reason || "Estorno feito no painel do Stripe",
      provider: "stripe",
      refundId: r.id,
      actor: r.metadata.sunfood_actor,
      items: parseItemsLabel(r.metadata.sunfood_items),
    });
  }
  await supabaseAdmin
    .from("orders")
    .update({
      refunded_amount: charge.amountRefunded,
      payment_status: charge.fullyRefunded || cents(charge.amountRefunded) >= cents(order.total) ? "refunded" : order.payment_status,
    })
    .eq("id", order.id);
}
