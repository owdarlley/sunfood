import crypto from "node:crypto";
import { supabaseAdmin } from "../supabase.js";

// Conta do quiosque no Stripe. O admin cola as chaves na aba Stripe do painel
// e o servidor guarda tudo na tabela stripe_settings, com as chaves secretas
// criptografadas (AES-256-GCM). A chave de criptografia nunca vai para o banco:
// sai de STRIPE_CONFIG_SECRET (obrigatória em produção para salvar chaves) ou,
// nas chaves salvas antes dela existir, da SUPABASE_SERVICE_ROLE_KEY. Quem ler
// o banco não consegue usar as chaves, e nenhuma rota devolve a chave secreta
// para o navegador.
// Sem nada salvo no painel, valem as variáveis STRIPE_* da Vercel, como antes.
// Com algo salvo, nunca: se o banco falhar ou as chaves não abrirem, o
// pagamento online para (erro) em vez de cobrar com outra conta (auditoria R4-A1).

const deriveKey = (base) => Buffer.from(crypto.hkdfSync("sha256", base, "sunfood", "stripe-settings-v1", 32));

// Chave para criptografar: a STRIPE_CONFIG_SECRET; sem ela (fora de produção),
// a service role, como antes.
function cryptoKey() {
  const base = process.env.STRIPE_CONFIG_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base) throw new Error("Sem segredo para criptografar as chaves do Stripe.");
  return deriveKey(base);
}

// Para abrir, tenta as duas: chaves salvas antes da STRIPE_CONFIG_SECRET
// continuam abrindo até serem coladas de novo.
function cryptoKeys() {
  return [process.env.STRIPE_CONFIG_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean).map(deriveKey);
}

export const hasConfigSecret = () => !!process.env.STRIPE_CONFIG_SECRET;

export function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(blob) {
  const raw = Buffer.from(String(blob).replace(/^v1:/, ""), "base64");
  let last = new Error("Sem segredo para abrir as chaves do Stripe.");
  for (const key of cryptoKeys()) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const fromEnv = () => ({
  source: process.env.STRIPE_SECRET_KEY ? "ambiente" : "nenhum",
  secretKey: process.env.STRIPE_SECRET_KEY || null,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
});

// Cada instância da Vercel guarda a configuração por 10 s; a instância que
// salvou no painel limpa na hora (forgetStripeSettings). Erro não fica guardado.
const TTL_MS = 10 * 1000;
let cached = null;
let cachedAt = 0;

export function forgetStripeSettings() {
  cached = null;
}

const MISSING_TABLE = ["42P01", "PGRST205"];

// Linha crua do banco (ou null se não há nada salvo). Tabela ainda não criada
// (SQL não rodado): null, e seguem as variáveis de ambiente. Qualquer outro
// erro (banco fora do ar, tempo esgotado) é lançado: cair para a Vercel aqui
// cobraria com a conta de teste e o webhook da conta real seria descartado.
export async function readStripeRow() {
  const { data, error } = await supabaseAdmin.from("stripe_settings").select("*").eq("id", 1).maybeSingle();
  if (error) {
    if (MISSING_TABLE.includes(error.code)) return null;
    throw new Error("Configuração do Stripe não lida: " + (error.message || error.code));
  }
  return data || null;
}

// Contas usadas antes da atual (troca de conta no painel): continuam valendo
// para estornar, cancelar e receber o webhook dos pagamentos feitos nelas.
function previousAccounts(row) {
  const out = [];
  for (const p of Array.isArray(row.previous_accounts) ? row.previous_accounts : []) {
    try {
      out.push({
        accountId: p.account_id || null,
        secretKey: decryptSecret(p.secret_key_enc),
        webhookSecret: p.webhook_secret_enc ? decryptSecret(p.webhook_secret_enc) : null,
      });
    } catch (e) {
      console.error("Chave de uma conta anterior do Stripe não abre:", p.account_id, e.message);
    }
  }
  return out;
}

export async function stripeSettings() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const env = fromEnv();
  let cfg = { ...env, previous: [] };
  const row = await readStripeRow();
  if (row) {
    // A Vercel continua valendo só para o que veio dela: o webhook antigo
    // (assinado com STRIPE_WEBHOOK_SECRET) é conferido e rebuscado com a
    // STRIPE_SECRET_KEY, nunca com a chave do painel.
    const fromVercel = env.secretKey && env.webhookSecret ? [{ accountId: null, secretKey: env.secretKey, webhookSecret: env.webhookSecret }] : [];
    try {
      cfg = {
        source: "painel",
        secretKey: decryptSecret(row.secret_key_enc),
        publishableKey: row.publishable_key,
        webhookSecret: row.webhook_secret_enc ? decryptSecret(row.webhook_secret_enc) : null,
        previous: [...previousAccounts(row), ...fromVercel],
      };
    } catch (e) {
      // Segredo da Vercel trocado depois de salvar: as chaves precisam ser
      // coladas de novo no painel. Até lá o pagamento online fica fora do ar
      // (auditoria R4-M2): nada de voltar sozinho para as chaves da Vercel.
      console.error("Chaves do Stripe salvas no painel não abrem:", e.message);
      cfg = { source: "painel", unreadable: true, secretKey: null, publishableKey: null, webhookSecret: null, previous: [...previousAccounts(row), ...fromVercel] };
    }
  }
  cached = cfg;
  cachedAt = Date.now();
  return cfg;
}

// Mostra só o começo e os 4 últimos caracteres (sk_live_…a1b2).
export const maskKey = (k) => (k ? `${k.slice(0, k.indexOf("_", 3) + 1)}…${k.slice(-4)}` : null);
