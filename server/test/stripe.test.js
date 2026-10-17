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
  profiles: [{ id: "ana", role: "cliente", name: "Ana", phone: "1", cpf: "1", birth_date: "2000-01-01", terms_accepted_at: "x" }],
  orders: [],
  kiosk_settings: [{ id: 1, cancel_window_minutes: 0 }],
};

function query(table) {
  const filters = [];
  let patch = null;
  const rows = () => db[table].filter((r) => filters.every(([k, v]) => r[k] === v));
  const q = {
    select: () => q,
    eq: (k, v) => (filters.push([k, v]), q),
    update: (p) => ((patch = p), q),
    async single() { const r = rows()[0]; return r ? { data: r, error: null } : { data: null, error: { message: "nada" } }; },
    async maybeSingle() { return { data: rows()[0] || null, error: null }; },
    then(ok, fail) {
      if (patch) rows().forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: rows(), error: null }).then(ok, fail);
    },
  };
  return q;
}
const fake = {
  from: query,
  rpc: async () => ({ error: null }),
  auth: { getUser: async (t) => (t === "tok-ana" ? { data: { user: { id: "ana", email: "ana@teste.com" } }, error: null } : { data: null, error: {} }) },
};
mock.module("../src/supabase.js", { namedExports: { supabaseAdmin: fake, supabaseAuth: fake } });

// Stripe falso: guarda as sessões criadas e devolve o que a API devolveria.
const sessions = {};
const refunds = [];
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
  refunds = { create: async (b) => (refunds.push(b), { id: "re_1", status: "succeeded" }) };
  webhooks = signer.webhooks;
}
mock.module("stripe", { defaultExport: FakeStripe });

let base, server;
before(async () => {
  process.env.SUPABASE_URL = "https://teste.supabase.co";
  process.env.CORS_ORIGIN = "http://localhost:8000";
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
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

test("status diz que o cartão é cobrado pelo Stripe em modo teste (PIX segue provisório)", async () => {
  const r = await api("GET", "/payments/status");
  assert.deepEqual(r.body, { configured: false, pix: "provisorio", card: "stripe", cardTestMode: true });
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
  assert.deepEqual(refunds, [{ payment_intent: "pi_teste_1" }]);
  assert.equal(db.orders[0].payment_status, "refunded");
});
