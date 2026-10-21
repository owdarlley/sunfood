import rateLimit, { MemoryStore } from "express-rate-limit";
import { supabaseAdmin } from "./supabase.js";

// Limite de tentativas com contador no Postgres (auditoria M-03). Na Vercel
// cada instância da função tem a própria memória, então um contador em memória
// valia por instância e zerava a cada cold start: dava para passar do limite
// de login espalhando as tentativas. Fora da Vercel (testes, dev) continua em
// memória. Se o banco falhar, cai para a memória em vez de travar a rota.
export class PostgresStore {
  constructor(name, client = supabaseAdmin) {
    this.prefix = `${name}:`;
    this.client = client;
    this.memory = new MemoryStore();
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(key) {
    try {
      const { data, error } = await this.client.rpc("rate_limit_hit", {
        p_key: this.prefix + key,
        p_window_ms: this.windowMs,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw error || new Error("rate_limit_hit sem resposta");
      return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
    } catch (err) {
      console.error("[rate-limit] contador no banco falhou, usando memória:", err.message);
      return this.memory.increment(key);
    }
  }

  async decrement(key) {
    await this.quiet("rate_limit_undo", key);
    await this.memory.decrement(key);
  }

  async resetKey(key) {
    await this.quiet("rate_limit_reset", key);
    await this.memory.resetKey(key);
  }

  async quiet(fn, key) {
    try {
      await this.client.rpc(fn, { p_key: this.prefix + key });
    } catch {
      // só ajuste fino do contador; não vale derrubar a requisição
    }
  }
}

// name identifica o limite no banco (cada rota tem o próprio contador).
export function limiter(name, options) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...(process.env.VERCEL ? { store: new PostgresStore(name) } : {}),
    ...options,
  });
}
