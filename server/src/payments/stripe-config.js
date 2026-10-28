import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase.js";

// Conta do quiosque no Stripe. O admin cola as chaves na aba Stripe do painel
// e o servidor guarda tudo na tabela stripe_settings, com as chaves secretas
// criptografadas (AES-256-GCM). A chave de criptografia nunca vai para o banco:
// sai de STRIPE_CONFIG_SECRET ou, sem ela, da SUPABASE_SERVICE_ROLE_KEY, que
// já só existe na Vercel. Quem ler o banco não consegue usar as chaves, e
// nenhuma rota devolve a chave secreta para o navegador.
// Sem nada salvo no painel, valem as variáveis STRIPE_* da Vercel, como antes.

function cryptoKey() {
  const base = process.env.STRIPE_CONFIG_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base) throw new Error("Sem segredo para criptografar as chaves do Stripe.");
  return Buffer.from(crypto.hkdfSync("sha256", base, "sunfood", "stripe-settings-v1", 32));
}

export function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(blob) {
  const raw = Buffer.from(String(blob).replace(/^v1:/, ""), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

const fromEnv = () => ({
  source: process.env.STRIPE_SECRET_KEY ? "ambiente" : "nenhum",
  secretKey: process.env.STRIPE_SECRET_KEY || null,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
});

// Cada instância da Vercel guarda a configuração por 30 s; a instância que
// salvou no painel limpa na hora (forgetStripeSettings).
const TTL_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

export function forgetStripeSettings() {
  cached = null;
}

// Linha crua do banco (ou null). Tabela ainda não criada (SQL não rodado) ou
// banco fora do ar: segue com as variáveis de ambiente.
export async function readStripeRow() {
  const { data, error } = await supabaseAdmin.from("stripe_settings").select("*").eq("id", 1).maybeSingle();
  if (error) return null;
  return data || null;
}

export async function stripeSettings() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  let cfg = fromEnv();
  const row = await readStripeRow().catch(() => null);
  if (row) {
    try {
      cfg = {
        source: "painel",
        secretKey: decryptSecret(row.secret_key_enc),
        publishableKey: row.publishable_key,
        webhookSecret: row.webhook_secret_enc ? decryptSecret(row.webhook_secret_enc) : null,
        // O webhook da Vercel continua valendo durante a troca.
        fallbackWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
      };
    } catch (e) {
      // Segredo da Vercel trocado depois de salvar: as chaves precisam ser
      // coladas de novo no painel. Até lá, valem as variáveis de ambiente.
      console.error("Chaves do Stripe salvas no painel não abrem:", e.message);
      cfg = { ...fromEnv(), unreadable: true };
    }
  }
  cached = cfg;
  cachedAt = Date.now();
  return cfg;
}

// Mostra só o começo e os 4 últimos caracteres (sk_live_…a1b2).
export const maskKey = (k) => (k ? `${k.slice(0, k.indexOf("_", 3) + 1)}…${k.slice(-4)}` : null);
