import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole, requireCompleteProfile } from "../middleware/auth.js";
import { createOrderSchema, manualOrderSchema, orderStatusUpdateSchema, paymentReceivedSchema, orderRefundSchema, validate } from "../validation/schemas.js";
import {
  computeOrderTotals,
  meetsMinimumOrder,
  effectiveMinOrderCents,
  tableCountFrom,
  formatBRL,
  canCancel,
  cancelWindowFrom,
  cancelDeadline,
  withinCancelWindow,
  isValidTransition,
  awaitingOnlinePayment,
  canRecordReceipt,
  needsRefund,
  VALID_TRANSITIONS,
} from "../business-rules.js";
import { cancelOrderWithRefund, expireUnpaidOrdersSoon, runMaintenanceSoon } from "../order-payments.js";
import { refundOrderByAdmin, customerRefunds } from "../order-refunds.js";
import { limiter } from "../rate-limit.js";
import { asyncRouter } from "../async-router.js";

export const ordersRouter = asyncRouter();

// Status que o garçom acompanha: o que ainda vai sair da cozinha e o que está pronto para levar.
const WAITER_STATUSES = ["Na Fila", "Em Preparo", "Pronto"];

// Trava contra spam de pedidos (bug de cliente ou tentativa de abuso) — bem
// mais generoso que o limite de login, já que é uso normal repetir pedidos.
// Conta por pessoa logada (auditoria M9): no Wi-Fi do quiosque muitos
// clientes dividem o mesmo IP.
const createOrderLimiter = limiter("create-order", {
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => "user:" + req.user.sub,
  message: { error: "Muitos pedidos em pouco tempo. Aguarde um instante." },
});

// PIX/cartão não pago segura o estoque até vencer (~40 min). Sem limite, um
// cliente esgotava um item com pedidos que nunca pagava (auditoria M9).
export const MAX_UNPAID_ONLINE_ORDERS = 3;

// Dia de hoje no fuso do quiosque (AAAA-MM-DD), igual ao order_day do banco.
export function spToday(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export function daysBefore(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Status de pedido em andamento: aparecem na lista da equipe seja de que dia forem.
const ACTIVE_STATUSES = ["Na Fila", "Em Preparo", "Pronto"];

// O Supabase devolve no máximo 1000 linhas por consulta e corta o resto sem
// avisar: busca em páginas até acabar.
const PAGE = 1000;
async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...data);
    if (data.length < PAGE) return { data: rows, error: null };
  }
}

// Prazo de cancelamento configurado pelo quiosque (0 = sem prazo).
async function loadCancelWindow() {
  const { data } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).maybeSingle();
  return cancelWindowFrom(data);
}

// cancelWindow só é passado nas respostas pro cliente: o app usa
// cancelDeadline pra mostrar até que horas dá pra cancelar.
function toApi(row, cancelWindow) {
  return {
    id: row.id,
    // Número curto do dia (1, 2, 3...), que o app mostra como #001.
    number: row.daily_number ?? null,
    tableNumber: row.table_number,
    userId: row.customer_id,
    customerName: row.customer_name,
    waiterId: row.waiter_id ?? null,
    deliveredBy: row.delivered_by ?? null,
    deliveredAt: row.delivered_at ?? null,
    status: row.status,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    note: row.note,
    paymentMethod: row.payment_method,
    paymentProvider: row.payment_provider,
    paymentId: row.payment_id,
    paymentStatus: row.payment_status,
    // Soma dos estornos (total ou parciais) feitos pelo painel ou pelo Stripe.
    refundedAmount: Number(row.refunded_amount || 0),
    // Só nas respostas pro cliente: valor, motivo, itens e quando de cada estorno.
    refunds: row.refunds,
    receivedWith: row.received_with,
    receivedAt: row.received_at,
    receivedBy: row.received_by ?? null,
    cancelDeadline: cancelWindow === undefined ? undefined : cancelDeadline(row.created_at, cancelWindow),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: (row.order_items || []).map((it) => ({
      productId: it.product_id,
      name: it.name,
      qty: it.qty,
      unitPrice: Number(it.price),
      note: it.note,
    })),
  };
}

const ORDER_SELECT = "*, order_items(*)";

const hasRefund = (row) => Number(row.refunded_amount || 0) > 0 || row.payment_status === "refunded";

// Valida e grava um pedido. Todas as regras de negócio são checadas aqui,
// no servidor — o front pode ser enganado, o backend não. Usado pelo cliente
// (pedido pelo app) e pelo garçom (pedido feito na mesa, sem cliente no app).
async function placeOrder(res, { tableNumber, items, note, paymentMethod, customerId = null, waiterId = null }) {
  // Libera o estoque de PIX/cartão abandonados antes de conferir o deste pedido.
  await expireUnpaidOrdersSoon();
  const productIds = items.map((i) => i.productId);
  // Configuração, mesa, produtos e pedidos em aberto do cliente de uma vez (auditoria B12).
  const [{ data: settings }, { data: table }, { data: products, error: productsError }, unpaid] = await Promise.all([
    supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single(),
    supabaseAdmin.from("kiosk_tables").select("*").eq("number", tableNumber).maybeSingle(),
    supabaseAdmin.from("products").select("*").in("id", productIds),
    customerId && paymentMethod !== "entrega"
      ? supabaseAdmin
          .from("orders")
          .select("id")
          .eq("customer_id", customerId)
          .eq("status", "Na Fila")
          .in("payment_method", ["pix", "cartao"])
          .eq("payment_status", "pending")
      : { data: [] },
  ]);
  if (settings?.paused) {
    return res.status(409).json({ error: "Quiosque pausado no momento — não é possível fechar o pedido." });
  }
  if (settings?.day_closed) {
    return res.status(409).json({ error: "O quiosque já encerrou o dia — não é possível fechar o pedido." });
  }

  const tableCount = tableCountFrom(settings);
  if (tableNumber > tableCount) {
    return res.status(404).json({ error: `Mesa ${tableNumber} não existe. O quiosque tem mesas de 1 a ${tableCount}.` });
  }

  if (!table) return res.status(404).json({ error: `Mesa ${tableNumber} não existe.` });
  if (!table.active) {
    return res.status(409).json({ error: `Mesa ${tableNumber} está inativa. Procure um atendente.` });
  }
  if ((unpaid.data || []).length >= MAX_UNPAID_ONLINE_ORDERS) {
    return res.status(409).json({
      error: "Você já tem pedidos esperando pagamento. Pague ou cancele um deles antes de fazer outro.",
      code: "too_many_unpaid",
    });
  }

  if (productsError) return res.status(500).json({ error: "Erro ao validar itens do pedido." });

  const byId = new Map(products.map((p) => [p.id, p]));
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) return res.status(404).json({ error: `Produto ${item.productId} não encontrado.` });
    if (product.archived_at) return res.status(409).json({ error: `${product.name} saiu do cardápio.` });
    if (product.sold_out) return res.status(409).json({ error: `Item indisponível: ${product.name}.` });
    if (product.stock_qty !== null && product.stock_qty < item.qty) {
      return res.status(409).json({ error: `Estoque insuficiente: ${product.name} (restam ${product.stock_qty}).` });
    }
  }

  // Aritmética em centavos pra não acumular erro de ponto flutuante, e só
  // volta pra reais decimais na hora de gravar.
  const priceCentsOf = (item) => Math.round(Number(byId.get(item.productId).price) * 100);
  const { subtotalCents, totalCents } = computeOrderTotals(items, priceCentsOf);
  const minOrderCents = effectiveMinOrderCents(settings);
  if (!meetsMinimumOrder(subtotalCents, minOrderCents)) {
    return res.status(422).json({ error: `Pedido mínimo de ${formatBRL(minOrderCents)}.` });
  }

  const { data: created, error: createError } = await supabaseAdmin.rpc("create_order", {
    payload: {
      customerId,
      waiterId,
      tableNumber,
      subtotal: subtotalCents / 100,
      fee: 0,
      total: totalCents / 100,
      note: note || "",
      paymentMethod,
      items: items.map((item) => {
        const product = byId.get(item.productId);
        return { productId: product.id, name: product.name, price: Number(product.price), qty: item.qty, note: item.note || "" };
      }),
    },
  });
  if (createError) {
    // Corrida entre dois pedidos concorrentes: o pré-check acima passou, mas
    // o estoque esgotou entre a checagem e o lock da linha dentro do RPC.
    if (createError.message?.startsWith("out_of_stock:")) {
      return res.status(409).json({ error: `Estoque insuficiente: ${createError.message.slice("out_of_stock:".length)}.` });
    }
    // O dia foi encerrado (ou o quiosque pausado) entre a checagem acima e a
    // gravação: o banco confere de novo dentro de create_order (auditoria B2).
    if (createError.message?.includes("kiosk_closed")) {
      return res.status(409).json({ error: "O quiosque não está recebendo pedidos agora." });
    }
    return res.status(500).json({ error: "Não foi possível registrar o pedido." });
  }

  const { data: row } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", created.id).maybeSingle();
  // O pedido já foi gravado: mesmo se a releitura falhar, responde com o id
  // (auditoria M5). Um erro aqui faria o cliente pedir de novo e duplicar.
  if (!row) return res.status(201).json({ id: created.id, status: "Na Fila", items: [] });
  res.status(201).json(toApi(row, customerId ? cancelWindowFrom(settings) : undefined));
}

// Cliente: cria um pedido pelo app.
ordersRouter.post("/", requireAuth, requireRole("cliente"), requireCompleteProfile, createOrderLimiter, validate(createOrderSchema), (req, res) => {
  const { tableNumber, items, note, paymentMethod } = req.body;
  return placeOrder(res, { tableNumber, items, note, paymentMethod, customerId: req.user.sub });
});

// Garçom (ou admin): lança um pedido feito na mesa, de quem não usa o app.
// Mesmas regras do pedido do cliente; o pagamento é sempre na entrega
// (o garçom recebe na mesa) e o pedido fica no nome de quem lançou.
ordersRouter.post("/manual", requireAuth, requireRole("garcom", "admin"), createOrderLimiter, validate(manualOrderSchema), (req, res) => {
  const { tableNumber, items, note } = req.body;
  return placeOrder(res, { tableNumber, items, note, paymentMethod: "entrega", waiterId: req.user.sub });
});

// Cliente: histórico dos próprios pedidos (os 50 mais recentes).
export const HISTORY_LIMIT = 50;
ordersRouter.get("/mine", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("customer_id", req.user.sub)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) return res.status(500).json({ error: "Erro ao carregar histórico." });
  const refunds = await customerRefunds(data.filter(hasRefund).map((row) => row.id));
  res.json(data.map((row) => toApi({ ...row, refunds: refunds.get(row.id) || [] })));
});

// Admin/cozinha/garçom: lista de pedidos para o kanban/painel, consultada a
// cada poucos segundos. Antes vinha o histórico inteiro (auditoria A2); agora:
//   - pedidos em andamento (fila, preparo e prontos), de qualquer dia;
//   - mais os de hoje (cozinha) ou dos últimos ?days= dias (admin: padrão 2,
//     até 31, usado na exportação do relatório).
// O garçom só recebe os pedidos em andamento. Cozinha e garçom não veem
// pedido de PIX/cartão ainda não pago; o admin vê tudo.
export const ADMIN_DEFAULT_DAYS = 2;
export const ADMIN_MAX_DAYS = 31;

ordersRouter.get("/", requireAuth, requireRole("admin", "cozinha", "garcom"), async (req, res) => {
  // A equipe consulta a cada poucos segundos: a limpeza roda no máximo uma vez por minuto.
  await expireUnpaidOrdersSoon();
  if (req.user.role === "admin") await runMaintenanceSoon();
  const { status } = req.query;
  const requested = Number.parseInt(req.query.days, 10);
  const days = req.user.role === "admin"
    ? Math.min(ADMIN_MAX_DAYS, Math.max(1, Number.isInteger(requested) ? requested : ADMIN_DEFAULT_DAYS))
    : 1;
  const since = daysBefore(spToday(), days - 1);
  const pick = (list) => list.filter((s) => !status || s === status);
  const activeStatuses = pick(ACTIVE_STATUSES);
  const recentStatuses = req.user.role === "garcom" ? pick(WAITER_STATUSES) : status ? [status] : null;
  const base = () => supabaseAdmin.from("orders").select(ORDER_SELECT).order("created_at", { ascending: false });
  const [older, recent] = await Promise.all([
    activeStatuses.length ? fetchAll(() => base().in("status", activeStatuses).lt("order_day", since)) : { data: [] },
    recentStatuses && !recentStatuses.length
      ? { data: [] }
      : fetchAll(() => (recentStatuses ? base().in("status", recentStatuses) : base()).gte("order_day", since)),
  ]);
  if (older.error || recent.error) return res.status(500).json({ error: "Erro ao carregar pedidos." });
  const data = [...recent.data, ...older.data];
  const visible = req.user.role === "admin" ? data : data.filter((row) => !awaitingOnlinePayment(row));
  // Nome de quem fez o pedido, para a cozinha e o garçom chamarem o cliente
  // pelo nome. Conta apagada fica sem nome (customer_id vira nulo).
  const ids = [...new Set(visible.map((row) => row.customer_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { data: profiles, error: namesError } = await supabaseAdmin.from("profiles").select("id, name").in("id", ids);
    if (namesError) console.error("Nomes dos clientes não carregados:", namesError.message);
    for (const p of profiles || []) names.set(p.id, p.name);
  }
  // Estornos parciais: a cozinha e o garçom veem quais itens foram devolvidos.
  const refunds = await customerRefunds(visible.filter(hasRefund).map((row) => row.id));
  res.json(visible.map((row) => toApi({ ...row, customer_name: names.get(row.customer_id) || null, refunds: refunds.get(row.id) || [] })));
});

// Admin: estorno total (cancela o pedido) ou parcial (o pedido continua),
// pelo mesmo meio em que o cliente pagou. Também cancela pedido "pagar na
// entrega" ou ainda não pago, sem estorno.
ordersRouter.post("/:id/refund", requireAuth, requireRole("admin"), validate(orderRefundSchema), async (req, res) => {
  const { data: row, error } = await supabaseAdmin.from("orders").select("*").eq("id", req.params.id).maybeSingle();
  if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
  const { cancel, amount, reason, items } = req.body;
  const result = await refundOrderByAdmin(row, {
    cancel,
    items,
    amountCents: amount === undefined ? undefined : Math.round(amount * 100),
    reason,
    actor: req.user.sub,
  });
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
  res.json({ ...toApi(updated), refundedNow: result.refunded });
});

// Admin: histórico de estornos do pedido (valor, motivo, quem e quando).
ordersRouter.get("/:id/refunds", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("order_refunds")
    .select("*")
    .eq("order_id", req.params.id)
    .order("created_at", { ascending: true });
  // Erro não vira lista vazia (auditoria B-07): o admin acharia que não houve estorno.
  if (error) return res.status(500).json({ error: "Não foi possível carregar os estornos." });
  const ids = [...new Set(data.map((r) => r.actor).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { data: profiles } = await supabaseAdmin.from("profiles").select("id, name").in("id", ids);
    for (const p of profiles || []) names.set(p.id, p.name);
  }
  res.json(data.map((r) => ({
    amount: Number(r.amount),
    reason: r.reason,
    provider: r.provider,
    items: r.items || [],
    by: names.get(r.actor) || (r.actor ? null : "Painel do Stripe"),
    at: r.created_at,
  })));
});

// Qualquer papel autenticado pode ver o detalhe — cliente só o próprio pedido.
ordersRouter.get("/:id", requireAuth, async (req, res) => {
  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (req.user.role === "cliente" && row.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para ver este pedido." });
  }
  if (req.user.role !== "cliente") return res.json(toApi(row));
  const refunds = hasRefund(row) ? (await customerRefunds([row.id])).get(row.id) || [] : [];
  res.json(toApi({ ...row, refunds }, await loadCancelWindow()));
});

// Cliente: cancelar — RN04, só permitido enquanto o status for "Na Fila" e
// dentro do prazo em minutos que o quiosque configurou.
// Pedido já pago no app é estornado no mesmo meio de pagamento.
ordersRouter.post("/:id/cancel", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (row.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para cancelar este pedido." });
  }
  if (!canCancel(row.status)) {
    return res.status(409).json({
      error: `Cancelamento bloqueado (RN04): o pedido já está em "${row.status}".`,
    });
  }
  const cancelWindow = await loadCancelWindow();
  if (!withinCancelWindow(row.created_at, cancelWindow)) {
    return res.status(409).json({
      error: `O prazo para cancelar pelo app (${cancelWindow} min depois do pedido) já passou. Fale com um atendente.`,
    });
  }

  const result = await cancelOrderWithRefund(row);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });

  const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
  const refunds = hasRefund(updated) ? (await customerRefunds([row.id])).get(row.id) || [] : [];
  res.json(toApi({ ...updated, refunds }, cancelWindow));
});

// Admin ou o próprio garçom: anota que o garçom recebeu um pedido "pagar na
// entrega" (dinheiro, cartão na maquininha ou PIX do quiosque), ou desfaz com
// receivedWith null. É o que deixa a tela de Pagamentos do admin com todas as transações.
ordersRouter.patch(
  "/:id/payment-received",
  requireAuth,
  requireRole("admin", "garcom"),
  validate(paymentReceivedSchema),
  async (req, res) => {
    const { data: row, error } = await supabaseAdmin.from("orders").select("*").eq("id", req.params.id).maybeSingle();
    if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
    if (!canRecordReceipt(row)) {
      return res.status(409).json({ error: "Só dá para anotar recebimento de pedido \"pagar na entrega\" que não foi cancelado." });
    }
    const { receivedWith } = req.body;
    // Garçom só mexe no próprio recebimento e nunca depois do dia encerrado;
    // o admin corrige qualquer um. Quem anotou fica gravado (received_by).
    if (req.user.role === "garcom") {
      if (row.received_with && row.received_by !== req.user.sub) {
        return res.status(403).json({ error: "Este recebimento foi anotado por outra pessoa. Fale com o admin." });
      }
      const { data: settings } = await supabaseAdmin.from("kiosk_settings").select("day_closed").eq("id", 1).maybeSingle();
      if (settings?.day_closed) return res.status(409).json({ error: "O dia já foi encerrado. Fale com o admin." });
    }
    const { error: updError } = await supabaseAdmin
      .from("orders")
      .update(
        receivedWith
          ? { payment_status: "approved", received_with: receivedWith, received_at: new Date().toISOString(), received_by: req.user.sub }
          : { payment_status: "pending", received_with: null, received_at: null, received_by: null }
      )
      .eq("id", row.id);
    console.info("Recebimento na entrega:", { order: row.id, by: req.user.sub, receivedWith: receivedWith || null });
    if (updError) return res.status(500).json({ error: "Não foi possível salvar o recebimento." });
    const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
    res.json(toApi(updated));
  }
);

// Admin/cozinha: avançar o status no kanban (Na Fila -> Em Preparo -> Pronto -> Entregue).
// Garçom: só marca "Entregue" um pedido pronto. Quem marca "Entregue" fica
// gravado no pedido (delivered_by), para as métricas do garçom.
ordersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin", "cozinha", "garcom"),
  validate(orderStatusUpdateSchema),
  async (req, res) => {
    const { status: next } = req.body;
    if (req.user.role === "garcom" && next !== "Entregue") {
      return res.status(403).json({ error: "O garçom só marca pedidos como entregues." });
    }
    const { data: row, error } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });

    if (!isValidTransition(row.status, next)) {
      return res.status(422).json({
        error: `Transição inválida de "${row.status}" para "${next}".`,
        allowed: VALID_TRANSITIONS[row.status] || [],
      });
    }

    if (next === "Em Preparo" && awaitingOnlinePayment(row)) {
      return res.status(409).json({ error: "Pedido ainda não foi pago — aguarde a confirmação do pagamento." });
    }

    if (next === "Cancelado") {
      // Pedido já pago no app: cancelar estorna o dinheiro, então só o admin.
      if (needsRefund(row) && req.user.role !== "admin") {
        return res.status(403).json({ error: "Pedido já pago: só o admin pode cancelar (o valor é estornado)." });
      }
      const result = await cancelOrderWithRefund(row);
      if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
    } else {
      const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
        p_order_id: row.id,
        p_status: next,
        p_actor: req.user.sub,
      });
      if (rpcError) {
        // Dois toques no mesmo avanço (ou outra tela já avançou): não é erro do servidor (auditoria B3).
        const msg = String(rpcError.message || "");
        if (msg.includes("invalid_transition")) return res.status(409).json({ error: "Este pedido já foi atualizado. A lista vai se atualizar." });
        if (msg.includes("order_not_found")) return res.status(404).json({ error: "Pedido não encontrado." });
        return res.status(500).json({ error: "Não foi possível atualizar o pedido." });
      }
      // Entregou e já recebeu na mesa: o recebimento fica anotado junto, sem
      // depender de alguém lembrar de abrir a tela de Pagamentos depois.
      if (next === "Entregue" && req.body.receivedWith && canRecordReceipt(row) && row.payment_status !== "approved") {
        await supabaseAdmin
          .from("orders")
          .update({ payment_status: "approved", received_with: req.body.receivedWith, received_at: new Date().toISOString(), received_by: req.user.sub })
          .eq("id", row.id);
      }
    }

    const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
    res.json(toApi(updated));
  }
);
