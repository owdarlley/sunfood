// Cartão pelo Stripe (modo teste): checkout criado no servidor e pedido
// liberado só pelo webhook assinado, com a sessão rebuscada na API. Stripe e
// Supabase são falsos aqui: nada sai da máquina.
import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

const RealStripe = (await import("stripe")).default;
const WEBHOOK_SECRET = "whsec_teste";
const signer = new RealStripe("sk_test_assinatura");

const ORDER = "00000000-0000-4000-8000-0000000000aa";
const db = {
  profiles: [{ id: "ana", role: "cliente", name: "Ana", phone: "1", cpf: "1", birth_date: "2000-01-01", terms_accepted_at: "x" },
    { id: "adm", role: "admin", name: "Bia Admin" }],
  orders: [],
  order_refunds: [],
  kiosk_settings: [{ id: 1, cancel_window_minutes: 0 }],
};

const rpcCalls = [];
function query(table) {
  const filters = [];
  let patch = null;
  let inserted = null;
  // Tabela que ainda não existe no banco (SQL não rodado): erro como o do Supabase.
  if (!db[table]) {
    const missing = { select: () => missing, eq: () => missing, insert: () => missing, order: () => missing,
      then: (ok, fail) => Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } }).then(ok, fail) };
    return missing;
  }
  const rows = () => db[table].filter((r) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const q = {
    select: () => q,
    eq: (k, v) => (filters.push([k, v]), q),
    in: (k, v) => (filters.push([k, v]), q),
    order: () => q,
    update: (p) => ((patch = p), q),
    insert: (row) => {
      // Banco sem a coluna de itens (SQL 20261017220000 não rodado): erro do PostgREST.
      if (db.noItemsColumn && "items" in row) { inserted = { error: { code: "PGRST204", message: "Could not find the 'items' column" } }; return q; }
      // Índice único do id do estorno no provedor.
      if (row.provider_refund_id && db[table].some((r) => r.provider_refund_id === row.provider_refund_id)) inserted = { error: { code: "23505" } };
      else { db[table].push({ id: "rf_" + (db[table].length + 1), created_at: new Date().toISOString(), ...row }); inserted = { error: null }; }
      return q;
    },
    async single() { const r = rows()[0]; return r ? { data: r, error: null } : { data: null, error: { message: "nada" } }; },
    async maybeSingle() { return { data: rows()[0] || null, error: null }; },
    then(ok, fail) {
      if (inserted) return Promise.resolve({ data: null, ...inserted }).then(ok, fail);
      if (patch) rows().forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: rows(), error: null }).then(ok, fail);
    },
  };
  return q;
}
const fake = {
  from: query,
  rpc: async (fn, args) => {
    rpcCalls.push([fn, args]);
    if (fn === "set_order_status") { const o = db.orders.find((x) => x.id === args.p_order_id); if (o) o.status = args.p_status; }
    return { error: null };
  },
  auth: { getUser: async (t) => (t === "tok-ana" ? { data: { user: { id: "ana", email: "ana@teste.com" } }, error: null }
    : t === "tok-adm" ? { data: { user: { id: "adm", email: "bia@teste.com" } }, error: null } : { data: null, error: {} }) },
};
mock.module("../src/supabase.js", { namedExports: { supabaseAdmin: fake, supabaseAuth: fake } });

// Stripe falso: guarda as sessões criadas e devolve o que a API devolveria.
const sessions = {};
const refunds = [];
const refundOpts = [];
const charges = {};
const intents = {};
const customers = [];
const customerSessions = [];
class FakeStripe {
  constructor(key) { this.key = key; }
  checkout = {
    sessions: {
      create: async (body) => {
        const id = "cs_test_" + (Object.keys(sessions).length + 1);
        sessions[id] = { id, url: "https://checkout.stripe.com/c/pay/" + id, body, payment_status: "unpaid", status: "open",
          client_reference_id: body.client_reference_id, metadata: body.metadata,
          amount_total: body.line_items[0].price_data.unit_amount, payment_intent: null };
        return sessions[id];
      },
      retrieve: async (id) => sessions[id],
    },
  };
  paymentIntents = {
    create: async (body) => {
      const id = "pi_teste_" + (Object.keys(intents).length + 2);
      const pix = body.payment_method_types[0] === "pix";
      intents[id] = { id, client_secret: id + "_secret_x", amount: body.amount, amount_received: 0, metadata: body.metadata, body, customer: body.customer || null,
        status: pix ? "requires_action" : "requires_payment_method",
        next_action: pix ? { pix_display_qr_code: { data: "000201PIXSTRIPE", image_url_png: "https://qr.stripe.com/x.png", hosted_instructions_url: "https://payments.stripe.com/pix/x" } } : null };
      return intents[id];
    },
    retrieve: async (id) => intents[id],
    update: async (id, body) => (Object.assign(intents[id].metadata, body.metadata), intents[id]),
  };
  refunds = { create: async (b, opts) => (refunds.push(b), refundOpts.push(opts), { id: "re_" + refunds.length, status: "succeeded", amount: b.amount }) };
  charges = { retrieve: async (id) => charges[id] };
  customers = {
    list: async ({ email }) => ({ data: customers.filter((c) => c.email === email) }),
    create: async (b) => { const c = { id: "cus_" + (customers.length + 1), ...b }; customers.push(c); return c; },
  };
  customerSessions = { create: async (b) => (customerSessions.push(b), { client_secret: "cuss_secret_" + customerSessions.length }) };
  webhooks = signer.webhooks;
}
mock.module("stripe", { defaultExport: FakeStripe });

let base, server;
before(async () => {
  process.env.SUPABASE_URL = "https://teste.supabase.co";
  process.env.CORS_ORIGIN = "http://localhost:8000";
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  const { app } = await import("../src/app.js");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ana", ...headers },
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function webhook(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  return api("POST", "/payments/stripe/webhook", payload, { "Stripe-Signature": header });
}

const completed = (id) => ({ id: "evt_1", type: "checkout.session.completed", data: { object: { id } } });

test("status diz que cartão e PIX são cobrados pelo Stripe em modo teste", async () => {
  const r = await api("GET", "/payments/status");
  assert.deepEqual(r.body, { configured: false, pix: "stripe", card: "stripe", cardTestMode: true, stripePublishableKey: "pk_test_123" });
});

test("cartão abre o checkout do Stripe pelo valor do pedido, em reais", async () => {
  db.orders.push({ id: ORDER, customer_id: "ana", total: 33.5, status: "Na Fila", payment_method: "cartao", payment_status: "pending", table_number: 3, created_at: new Date().toISOString(), order_items: [] });
  const r = await api("POST", `/payments/card/${ORDER}`, { returnUrl: "http://localhost:8000/app-cliente.dc.html?module=cliente&screen=card" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  const s = sessions.cs_test_1.body;
  assert.equal(s.line_items[0].price_data.currency, "brl");
  assert.equal(s.line_items[0].price_data.unit_amount, 3350);
  assert.equal(s.client_reference_id, ORDER);
  assert.match(s.success_url, new RegExp(`pedido=${ORDER}`));
  assert.match(s.cancel_url, /status=failure/);
  assert.equal(db.orders[0].payment_provider, "stripe");
  assert.equal(db.orders[0].payment_status, "pending");
});

test("retorno pra fora do app é recusado", async () => {
  const r = await api("POST", `/payments/card/${ORDER}`, { returnUrl: "https://site-qualquer.com/" });
  assert.equal(r.status, 400);
});

test("webhook com assinatura errada não libera o pedido", async () => {
  sessions.cs_test_1.payment_status = "paid";
  sessions.cs_test_1.payment_intent = "pi_teste_1";
  const r = await webhook(completed("cs_test_1"), "whsec_outro");
  assert.equal(r.status, 400);
  assert.equal(db.orders[0].payment_status, "pending");
});

test("webhook não confia no corpo: sessão ainda não paga na API não libera", async () => {
  sessions.cs_test_1.payment_status = "unpaid";
  const r = await webhook(completed("cs_test_1"));
  assert.equal(r.status, 200);
  assert.equal(db.orders[0].payment_status, "pending");
});

test("webhook assinado de sessão paga aprova o pedido e guarda o PaymentIntent", async () => {
  sessions.cs_test_1.payment_status = "paid";
  const r = await webhook(completed("cs_test_1"));
  assert.equal(r.status, 200);
  assert.equal(db.orders[0].payment_status, "approved");
  assert.equal(db.orders[0].payment_id, "pi_teste_1");
});

test("cancelar pedido pago pelo Stripe estorna no Stripe", async () => {
  const r = await api("POST", `/orders/${ORDER}/cancel`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(refunds, [{ payment_intent: "pi_teste_1", metadata: { order_id: ORDER, sunfood_reason: "Você cancelou o pedido" } }]);
  assert.equal(db.orders[0].payment_status, "refunded");
  // Fica no histórico do pedido, que o cliente vê nos detalhes.
  const reg = db.order_refunds.filter((x) => x.order_id === ORDER);
  assert.deepEqual(reg.map(({ amount, reason, provider_refund_id }) => ({ amount, reason, provider_refund_id })),
    [{ amount: db.orders[0].total, reason: "Você cancelou o pedido", provider_refund_id: "re_1" }]);
  assert.deepEqual(r.body.refunds.map(({ amount, reason }) => ({ amount, reason })), [{ amount: db.orders[0].total, reason: "Você cancelou o pedido" }]);
});

const ORDER2 = "00000000-0000-4000-8000-0000000000bb";

test("campos no app: cria o PaymentIntent em reais e devolve só o client_secret e a chave publicável", async () => {
  db.orders.push({ id: ORDER2, customer_id: "ana", total: 41, status: "Na Fila", payment_method: "cartao", payment_status: "pending", table_number: 2, created_at: new Date().toISOString(), order_items: [] });
  const r = await api("POST", `/payments/card-intent/${ORDER2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = Object.keys(intents)[0];
  assert.deepEqual(r.body, { clientSecret: id + "_secret_x", amount: 4100, publishableKey: "pk_test_123", customerSessionClientSecret: "cuss_secret_1" });
  assert.equal(intents[id].body.currency, "brl");
  assert.equal(intents[id].body.amount, 4100);
  assert.equal(intents[id].metadata.order_id, ORDER2);
  const o = db.orders.find((x) => x.id === ORDER2);
  assert.equal(o.payment_id, id);
  assert.equal(o.payment_status, "pending");
});

test("campos no app: voltar à tela reaproveita o mesmo PaymentIntent", async () => {
  const r = await api("POST", `/payments/card-intent/${ORDER2}`);
  assert.equal(r.status, 200);
  assert.equal(Object.keys(intents).length, 1);
});

test("cartão salvo: um Customer por cliente, ligado ao PaymentIntent, salvar só on_session", async () => {
  assert.equal(customers.length, 1, "não duplica o Customer ao voltar à tela");
  assert.equal(customers[0].email, "ana@teste.com");
  assert.equal(customers[0].metadata.sunfood_user_id, "ana");
  assert.equal(Object.values(intents)[0].customer, "cus_1");
  const f = customerSessions[1].components.payment_element;
  assert.equal(customerSessions[1].customer, "cus_1");
  assert.equal(f.enabled, true);
  assert.equal(f.features.payment_method_save, "enabled");
  assert.equal(f.features.payment_method_save_usage, "on_session");
  assert.equal(f.features.payment_method_redisplay, "enabled");
});

test("sessão do cliente antes do pedido: mesmo Customer, sem criar PaymentIntent", async () => {
  const before = Object.keys(intents).length;
  const r = await api("POST", "/payments/card-session");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.publishableKey, "pk_test_123");
  assert.match(r.body.customerSessionClientSecret, /^cuss_secret_/);
  assert.equal(customers.length, 1);
  assert.equal(customerSessions.at(-1).customer, "cus_1");
  assert.equal(Object.keys(intents).length, before);
});

test("campos no app: com ?session=0 não cria outra sessão do cliente", async () => {
  const n = customerSessions.length;
  const r = await api("POST", `/payments/card-intent/${ORDER2}?session=0`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.customerSessionClientSecret, null);
  assert.equal(customerSessions.length, n);
});

test("campos no app: o navegador não aprova; só o webhook payment_intent.succeeded rebuscado na API", async () => {
  const id = Object.keys(intents)[0];
  const ev = { id: "evt_2", type: "payment_intent.succeeded", data: { object: { id, status: "succeeded" } } };
  let r = await webhook(ev); // corpo diz succeeded, mas a API ainda não
  assert.equal(r.status, 200);
  assert.equal(db.orders.find((x) => x.id === ORDER2).payment_status, "pending");
  Object.assign(intents[id], { status: "succeeded", amount_received: 4100 });
  r = await webhook(ev);
  assert.equal(r.status, 200);
  assert.equal(db.orders.find((x) => x.id === ORDER2).payment_status, "approved");
});

test("titular do cartão: recusa nome incompleto e CPF inválido", async () => {
  let r = await api("POST", `/payments/card-holder/${ORDER2}`, { name: "Ana", cpf: "529.982.247-25" });
  assert.equal(r.status, 400);
  r = await api("POST", `/payments/card-holder/${ORDER2}`, { name: "Ana Souza", cpf: "123.456.789-00" });
  assert.equal(r.status, 400);
});

test("titular do cartão: guarda nome e CPF no PaymentIntent", async () => {
  const db2 = db.orders.find((x) => x.id === ORDER2);
  const saved = db2.payment_status;
  db2.payment_status = "pending";
  const r = await api("POST", `/payments/card-holder/${ORDER2}`, { name: "  Ana   Souza ", cpf: "529.982.247-25" });
  db2.payment_status = saved;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const meta = intents[db2.payment_id].metadata;
  assert.equal(meta.holder_name, "Ana Souza");
  assert.equal(meta.holder_cpf, "52998224725");
  assert.equal(meta.order_id, ORDER2);
});

const ORDER3 = "00000000-0000-4000-8000-0000000000cc";

test("PIX pelo Stripe: gera o QR e NÃO aprova o pedido antes de pagar", async () => {
  db.orders.push({ id: ORDER3, customer_id: "ana", total: 14, status: "Na Fila", payment_method: "pix", payment_status: "pending", table_number: 1, created_at: new Date().toISOString(), order_items: [] });
  const r = await api("POST", `/payments/pix/${ORDER3}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.qrCode, "000201PIXSTRIPE");
  assert.equal(r.body.qrCodeImageUrl, "https://qr.stripe.com/x.png");
  assert.equal(r.body.testPayUrl, "https://payments.stripe.com/pix/x");
  const pi = Object.values(intents).find((x) => x.metadata.order_id === ORDER3);
  assert.equal(pi.body.currency, "brl");
  assert.equal(pi.body.amount, 1400);
  assert.equal(pi.body.confirm, true);
  assert.equal(pi.body.payment_method_options.pix.expires_after_seconds, 30 * 60);
  const o = db.orders.find((x) => x.id === ORDER3);
  assert.equal(o.payment_status, "pending");
  assert.equal(o.payment_provider, "stripe");
  assert.equal(o.payment_id, pi.id);
});

test("PIX pelo Stripe: pedir de novo (página recarregada) mostra o mesmo QR, sem outra cobrança", async () => {
  const before = Object.keys(intents).length;
  const r = await api("POST", `/payments/pix/${ORDER3}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.qrCode, "000201PIXSTRIPE");
  assert.equal(Object.keys(intents).length, before);
});

test("PIX pelo Stripe: QR vencido gera outro", async () => {
  const pi = Object.values(intents).find((x) => x.metadata.order_id === ORDER3);
  const before = Object.keys(intents).length;
  pi.next_action.pix_display_qr_code.expires_at = Math.floor(Date.now() / 1000) - 10;
  const r = await api("POST", `/payments/pix/${ORDER3}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Object.keys(intents).length, before + 1);
  assert.notEqual(db.orders.find((x) => x.id === ORDER3).payment_id, pi.id);
  delete pi.next_action.pix_display_qr_code.expires_at;
});

test("PIX pelo Stripe: o webhook aprova quando o banco confirma", async () => {
  const pi = Object.values(intents).find((x) => x.metadata.order_id === ORDER3);
  Object.assign(pi, { status: "succeeded", amount_received: 1400 });
  const r = await webhook({ id: "evt_3", type: "payment_intent.succeeded", data: { object: { id: pi.id } } });
  assert.equal(r.status, 200);
  assert.equal(db.orders.find((x) => x.id === ORDER3).payment_status, "approved");
});

test("cartão no Stripe nunca liga parcelamento (sempre à vista)", () => {
  for (const pi of Object.values(intents)) assert.equal(pi.body.payment_method_options?.card?.installments, undefined);
  for (const sess of Object.values(sessions)) assert.equal(sess.body.payment_method_options?.card?.installments, undefined);
});

// ---- Estorno pelo painel do admin ----
const PAGO = "00000000-0000-4000-8000-0000000000dd";
const ENTREGA = "00000000-0000-4000-8000-0000000000ee";
const adm = (method, path, body) => api(method, path, body, { Authorization: "Bearer tok-adm" });

test("estorno parcial pelo admin: devolve só a parte, com motivo e quem fez, e o pedido continua", async () => {
  db.orders.push({ id: PAGO, customer_id: "ana", total: 50, refunded_amount: 0, status: "Em Preparo", payment_method: "cartao",
    payment_status: "approved", payment_provider: "stripe", payment_id: "pi_pago", table_number: 1, created_at: new Date().toISOString(), order_items: [] });
  const n = refunds.length;
  const r = await adm("POST", `/orders/${PAGO}/refund`, { amount: 12.5, reason: "Faltou o suco" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(refunds[n], { payment_intent: "pi_pago", amount: 1250, metadata: { order_id: PAGO, sunfood_reason: "Faltou o suco", sunfood_actor: "adm" } });
  assert.match(refundOpts[n].idempotencyKey, /^sunfood-refund-/);
  const o = db.orders.find((x) => x.id === PAGO);
  assert.equal(o.refunded_amount, 12.5);
  assert.equal(o.payment_status, "approved");
  assert.equal(o.status, "Em Preparo");
  assert.equal(r.body.refundedAmount, 12.5);
  const reg = db.order_refunds.find((x) => x.order_id === PAGO);
  assert.equal(reg.amount, 12.5);
  assert.equal(reg.actor, "adm");
  assert.equal(reg.provider_refund_id, "re_" + (n + 1));
});

test("estorno maior do que falta devolver é recusado sem chamar o Stripe", async () => {
  const n = refunds.length;
  const r = await adm("POST", `/orders/${PAGO}/refund`, { amount: 40, reason: "Teste" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /37,50/);
  assert.equal(refunds.length, n);
});

test("estorno sem motivo é recusado", async () => {
  const r = await adm("POST", `/orders/${PAGO}/refund`, { amount: 1 });
  assert.equal(r.status, 400);
});

test("cliente não estorna pelo painel", async () => {
  const r = await api("POST", `/orders/${PAGO}/refund`, { amount: 1, reason: "Quero de volta" });
  assert.equal(r.status, 403);
});

test("histórico de estornos mostra valor, motivo e quem fez", async () => {
  const r = await adm("GET", `/orders/${PAGO}/refunds`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(({ amount, reason, by }) => ({ amount, reason, by })), [{ amount: 12.5, reason: "Faltou o suco", by: "Bia Admin" }]);
});

test("cancelar pelo admin em preparo devolve o que falta e tira o pedido da cozinha", async () => {
  const n = refunds.length;
  const r = await adm("POST", `/orders/${PAGO}/refund`, { cancel: true, reason: "Cliente foi embora" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(refunds[n].amount, 3750);
  const o = db.orders.find((x) => x.id === PAGO);
  assert.equal(o.status, "Cancelado");
  assert.equal(o.payment_status, "refunded");
  assert.equal(o.refunded_amount, 50);
  assert.deepEqual(rpcCalls.at(-1), ["set_order_status", { p_order_id: PAGO, p_status: "Cancelado", p_actor: "adm" }]);
  assert.equal((await adm("POST", `/orders/${PAGO}/refund`, { amount: 1, reason: "De novo" })).status, 409);
});

test("cancelar \"pagar na entrega\" pelo admin não chama o Stripe", async () => {
  db.orders.push({ id: ENTREGA, customer_id: "ana", total: 20, refunded_amount: 0, status: "Pronto", payment_method: "entrega",
    payment_status: "pending", table_number: 2, created_at: new Date().toISOString(), order_items: [] });
  const n = refunds.length;
  const r = await adm("POST", `/orders/${ENTREGA}/refund`, { cancel: true, reason: "Pedido errado" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(refunds.length, n);
  assert.equal(db.orders.find((x) => x.id === ENTREGA).status, "Cancelado");
});

test("sem o SQL do estorno rodado, nada é devolvido", async () => {
  const saved = db.order_refunds;
  delete db.order_refunds;
  const id = "00000000-0000-4000-8000-0000000000ff";
  db.orders.push({ id, customer_id: "ana", total: 10, status: "Na Fila", payment_method: "cartao", payment_status: "approved", payment_id: "pi_semsql",
    table_number: 1, created_at: new Date().toISOString(), order_items: [] });
  const n = refunds.length;
  const r = await adm("POST", `/orders/${id}/refund`, { cancel: true, reason: "Teste sem SQL" });
  db.order_refunds = saved;
  assert.equal(r.status, 503);
  assert.match(r.body.error, /SQL/);
  assert.equal(refunds.length, n);
});

test("estorno feito no painel do Stripe chega pelo webhook charge.refunded", async () => {
  const id = "00000000-0000-4000-8000-000000000011";
  db.orders.push({ id, customer_id: "ana", total: 30, refunded_amount: 0, status: "Entregue", payment_method: "cartao", payment_status: "approved",
    payment_id: "pi_painel", table_number: 1, created_at: new Date().toISOString(), order_items: [] });
  charges.ch_painel = { id: "ch_painel", payment_intent: "pi_painel", amount_refunded: 500, refunded: false,
    refunds: { data: [{ id: "re_painel", amount: 500, status: "succeeded", metadata: {} }] } };
  // O corpo do evento é ignorado: os valores vêm da API.
  const r = await webhook({ id: "evt_ref", type: "charge.refunded", data: { object: { id: "ch_painel", amount_refunded: 99999 } } });
  assert.equal(r.status, 200);
  const o = db.orders.find((x) => x.id === id);
  assert.equal(o.refunded_amount, 5);
  assert.equal(o.payment_status, "approved");
  const reg = db.order_refunds.filter((x) => x.order_id === id);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].reason, "Estorno feito no painel do Stripe");
  // O mesmo evento de novo não duplica.
  await webhook({ id: "evt_ref", type: "charge.refunded", data: { object: { id: "ch_painel" } } });
  assert.equal(db.order_refunds.filter((x) => x.order_id === id).length, 1);
});

const ITENS = "00000000-0000-4000-8000-000000000022";
test("estorno parcial com itens: o cliente vê valor, itens, motivo e data, sem quem estornou", async () => {
  db.orders.push({ id: ITENS, customer_id: "ana", total: 40, refunded_amount: 0, status: "Entregue", payment_method: "cartao", payment_status: "approved",
    payment_provider: "stripe", payment_id: "pi_itens", table_number: 3, created_at: new Date().toISOString(),
    order_items: [{ product_id: "p1", name: "Água", qty: 2, price: 5 }, { product_id: "p2", name: "Pastel", qty: 1, price: 30 }] });
  const n = refunds.length;
  const r = await adm("POST", `/orders/${ITENS}/refund`, { amount: 10, reason: "Item em falta", items: [{ name: "Água", qty: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(refunds[n].metadata.sunfood_items, "2x Água");
  assert.deepEqual(db.order_refunds.find((x) => x.order_id === ITENS).items, [{ name: "Água", qty: 2 }]);

  const one = await api("GET", `/orders/${ITENS}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.refunds.length, 1);
  const [rf] = one.body.refunds;
  assert.deepEqual({ amount: rf.amount, reason: rf.reason, items: rf.items }, { amount: 10, reason: "Item em falta", items: [{ name: "Água", qty: 2 }] });
  assert.ok(rf.at);
  assert.equal("by" in rf || "actor" in rf || "provider" in rf, false);

  const mine = await api("GET", "/orders/mine");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.find((o) => o.id === ITENS).refunds[0].reason, "Item em falta");
  // Pedido sem estorno vem com a lista vazia.
  assert.ok(mine.body.filter((o) => !o.refundedAmount && o.paymentStatus !== "refunded").every((o) => o.refunds.length === 0));
});

test("sem a coluna de itens no banco, o estorno é registrado sem eles", async () => {
  db.noItemsColumn = true;
  const before = db.order_refunds.length;
  const r = await adm("POST", `/orders/${ITENS}/refund`, { amount: 5, reason: "Pedido errado", items: [{ name: "Pastel", qty: 1 }] });
  delete db.noItemsColumn;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.order_refunds.length, before + 1);
  assert.equal(db.order_refunds.at(-1).reason, "Pedido errado");
  assert.equal(db.order_refunds.at(-1).items, undefined);
});

test("itens do estorno chegam também pelo webhook (metadata do Stripe)", async () => {
  const id = "00000000-0000-4000-8000-000000000033";
  db.orders.push({ id, customer_id: "ana", total: 30, refunded_amount: 0, status: "Entregue", payment_method: "cartao", payment_status: "approved",
    payment_id: "pi_meta", table_number: 1, created_at: new Date().toISOString(), order_items: [] });
  charges.ch_meta = { id: "ch_meta", payment_intent: "pi_meta", amount_refunded: 1200, refunded: false,
    refunds: { data: [{ id: "re_meta", amount: 1200, status: "succeeded", metadata: { sunfood_reason: "Item em falta", sunfood_items: "2x Água, 1x Suco de laranja" } }] } };
  const r = await webhook({ id: "evt_meta", type: "charge.refunded", data: { object: { id: "ch_meta" } } });
  assert.equal(r.status, 200);
  const reg = db.order_refunds.find((x) => x.order_id === id);
  assert.equal(reg.reason, "Item em falta");
  assert.deepEqual(reg.items, [{ name: "Água", qty: 2 }, { name: "Suco de laranja", qty: 1 }]);
});
