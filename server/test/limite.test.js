import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Contador do limite de tentativas no banco (auditoria M-03). O cliente do
// Supabase é falso: guarda os contadores num Map, como a função do banco.
mock.module("../src/lib/supabase.js", { namedExports: { supabaseAdmin: {}, supabaseAuth: {} } });
const { PostgresStore } = await import("../src/middleware/rate-limit.js");

function fakeClient() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    fail: false,
    async rpc(fn, args) {
      calls.push([fn, args]);
      if (this.fail) return { data: null, error: { message: "fora do ar" } };
      if (fn === "rate_limit_hit") {
        const row = rows.get(args.p_key) || { hits: 0, reset_at: new Date(Date.now() + args.p_window_ms).toISOString() };
        row.hits += 1;
        rows.set(args.p_key, row);
        return { data: [row], error: null };
      }
      if (fn === "rate_limit_undo") rows.get(args.p_key).hits -= 1;
      if (fn === "rate_limit_reset") rows.delete(args.p_key);
      return { data: null, error: null };
    },
  };
}

test("conta no banco com a chave prefixada pelo nome do limite", async () => {
  const client = fakeClient();
  const store = new PostgresStore("login", client);
  store.init({ windowMs: 60000 });
  await store.increment("1.2.3.4");
  const r = await store.increment("1.2.3.4");
  assert.equal(r.totalHits, 2);
  assert.ok(r.resetTime instanceof Date);
  assert.deepEqual(client.calls[0], ["rate_limit_hit", { p_key: "login:1.2.3.4", p_window_ms: 60000 }]);

  await store.decrement("1.2.3.4");
  assert.equal(client.rows.get("login:1.2.3.4").hits, 1);
  await store.resetKey("1.2.3.4");
  assert.equal(client.rows.has("login:1.2.3.4"), false);
});

test("banco fora do ar: cai para a memória e continua limitando", async () => {
  const client = fakeClient();
  client.fail = true;
  const store = new PostgresStore("login", client);
  store.init({ windowMs: 60000 });
  const errors = mock.method(console, "error", () => {});
  await store.increment("1.2.3.4");
  const r = await store.increment("1.2.3.4");
  errors.mock.restore();
  assert.equal(r.totalHits, 2);
});
