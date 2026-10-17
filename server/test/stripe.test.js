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
const intents = {};
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
      intents[id] = { id, client_secret: id + "_secret_x", amount: body.amount, amount_received: 0, metadata: body.metadata, body,
        status: pix ? "requires_action" : "requires_payment_method",
        next_action: pix ? { pix_display_qr_code: { data: "000201PIXSTRIPE", image_url_png: "https://qr.stripe.com/x.png", hosted_instructions_url: "https://payments.stripe.com/pix/x" } } : null };
      return intents[id];
    },
    retrieve: async (id) => intents[id],
    update: async (id, body) => (Object.assign(intents[id].metadata, body.metadata), intents[id]),
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
  assert.deepEqual(refunds, [{ payment_intent: "pi_teste_1" }]);
  assert.equal(db.orders[0].payment_status, "refunded");
});

const ORDER2 = "00000000-0000-4000-8000-0000000000bb";

test("campos no app: cria o PaymentIntent em reais e devolve só o client_secret e a chave publicável", async () => {
  db.orders.push({ id: ORDER2, customer_id: "ana", total: 41, status: "Na Fila", payment_method: "cartao", payment_status: "pending", table_number: 2, created_at: new Date().toISOString(), order_items: [] });
  const r = await api("POST", `/payments/card-intent/${ORDER2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = Object.keys(intents)[0];
  assert.deepEqual(r.body, { clientSecret: id + "_secret_x", publishableKey: "pk_test_123" });
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
