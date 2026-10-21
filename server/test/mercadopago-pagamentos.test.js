// PIX e webhook do Mercado Pago (achado A-02 da auditoria): uma cobrança só
// por pedido e devolução de pagamento em dobro. Mercado Pago e Supabase são
// falsos aqui: nada sai da máquina.
import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

const db = {
  profiles: [{ id: "ana", role: "cliente", name: "Ana", phone: "1", cpf: "1", birth_date: "2000-01-01", terms_accepted_at: "x" }],
  orders: [],
  order_refunds: [],
  kiosk_settings: [{ id: 1, cancel_window_minutes: 0 }],
};

function query(table) {
  const filters = [];
  let patch = null;
  const rows = () => db[table].filter((r) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const q = {
    select: () => q,
    eq: (k, v) => (filters.push([k, v]), q),
    in: (k, v) => (filters.push([k, v]), q),
    order: () => q,
    update: (p) => ((patch = p), q),
    insert: (row) => (db[table].push(row), q),
    async single() { const r = rows()[0]; return r ? { data: r, error: null } : { data: null, error: { message: "nada" } }; },
    async maybeSingle() { return { data: rows()[0] || null, error: null }; },
    then(ok, fail) {
      const hit = rows();
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: hit, error: null }).then(ok, fail);
    },
  };
  return q;
}
const rpcCalls = [];
const fake = {
  from: query,
  rpc: async (fn, args) => (rpcCalls.push([fn, args]), { error: null }),
  auth: { getUser: async (t) => (t === "tok-ana" ? { data: { user: { id: "ana", email: "ana@teste.com" } }, error: null } : { data: null, error: {} }) },
};
mock.module("../src/supabase.js", { namedExports: { supabaseAdmin: fake, supabaseAuth: fake } });

// Mercado Pago falso: guarda as cobranças criadas e os estornos pedidos.
const payments = {};
const created = [];
const refunds = [];
let nextId = 100;
class Payment {
  async create({ body, requestOptions }) {
    const id = ++nextId;
    created.push({ id, body, requestOptions });
    payments[id] = { id, status: "pending", external_reference: body.external_reference, transaction_amount: body.transaction_amount,
      date_of_expiration: body.date_of_expiration,
      point_of_interaction: { transaction_data: { qr_code: "PIX-" + id, qr_code_base64: "base64-" + id } } };
    return payments[id];
  }
  async get({ id }) { return payments[id]; }
}
class PaymentRefund {
  async total({ payment_id, requestOptions }) { refunds.push({ payment_id, requestOptions }); return { id: "rf" + refunds.length, status: "approved" }; }
  async create({ payment_id, body, requestOptions }) { refunds.push({ payment_id, amount: body.amount, requestOptions }); return { id: "rf" + refunds.length, status: "approved" }; }
}
mock.module("mercadopago", { namedExports: { MercadoPagoConfig: class {}, Payment, PaymentRefund, Preference: class {} } });

let base, server;
before(async () => {
  process.env.SUPABASE_URL = "https://teste.supabase.co";
  process.env.CORS_ORIGIN = "http://localhost:8000";
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token";
  delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  const { app } = await import("../src/app.js");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ana" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const webhook = (id) => api("POST", "/payments/mercadopago/webhook", { type: "payment", data: { id: String(id) } });

const ORDER = "00000000-0000-4000-8000-0000000000d1";
const order = () => db.orders.find((o) => o.id === ORDER);

test("PIX: pedir de novo (página recarregada) mostra o mesmo QR, sem outra cobrança", async () => {
  db.orders.push({ id: ORDER, customer_id: "ana", total: 25, refunded_amount: 0, status: "Na Fila", payment_method: "pix",
    payment_status: "pending", table_number: 1, created_at: new Date().toISOString() });
  const r1 = await api("POST", `/payments/pix/${ORDER}`);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(created.length, 1);
  assert.equal(created[0].requestOptions.idempotencyKey, `sunfood-pix-${ORDER}-1`, "clique duplo recebe a mesma cobrança");
  assert.equal(order().payment_id, "101");

  const r2 = await api("POST", `/payments/pix/${ORDER}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.qrCode, "PIX-101");
  assert.equal(r2.body.expiresAt, r1.body.expiresAt);
  assert.ok(Date.parse(r1.body.expiresAt) > Date.now(), "devolve quando o QR vence");
  assert.equal(created.length, 1);
});

test("PIX: QR vencido gera outro, com outra chave de idempotência", async () => {
  payments[101].date_of_expiration = new Date(Date.now() - 1000).toISOString();
  const r = await api("POST", `/payments/pix/${ORDER}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.qrCode, "PIX-102");
  assert.equal(created[1].requestOptions.idempotencyKey, `sunfood-pix-${ORDER}-101`);
  assert.equal(order().payment_id, "102");
});

test("PIX antigo vencendo não tira o pedido da fila", async () => {
  payments[101].status = "cancelled";
  assert.equal((await webhook(101)).status, 200);
  assert.equal(order().status, "Na Fila");
  assert.equal(order().payment_status, "pending");
  assert.equal(rpcCalls.length, 0);
});

test("o cliente paga os dois QR Codes: o primeiro aprova, o segundo volta inteiro", async () => {
  payments[101].status = "approved";
  assert.equal((await webhook(101)).status, 200);
  assert.equal(order().payment_status, "approved");
  assert.equal(order().payment_id, "101");

  payments[102].status = "approved";
  assert.equal((await webhook(102)).status, 200);
  assert.deepEqual(refunds, [{ payment_id: "102", requestOptions: { idempotencyKey: "sunfood-duplicate-102" } }]);
  assert.equal(order().payment_id, "101");
  assert.equal(order().payment_status, "approved");
  assert.equal(db.order_refunds.length, 0);

  // O aviso de estorno do pagamento em dobro não marca o pedido como estornado.
  payments[102].status = "refunded";
  assert.equal((await webhook(102)).status, 200);
  assert.equal(order().payment_status, "approved");
});

test("pedido pago não gera outra cobrança PIX", async () => {
  const r = await api("POST", `/payments/pix/${ORDER}`);
  assert.equal(r.status, 409);
  assert.equal(created.length, 2);
});
