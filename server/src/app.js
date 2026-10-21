import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { authRouter } from "./routes/auth.js";
import { productsRouter } from "./routes/products.js";
import { categoriesRouter } from "./routes/categories.js";
import { tablesRouter } from "./routes/tables.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";
import { paymentsRouter } from "./routes/payments.js";
import { contactRouter } from "./routes/contact.js";
import { waitersRouter } from "./routes/waiters.js";
import { runMaintenance } from "./order-payments.js";
import { purgeOldContactMessages } from "./routes/contact.js";

// Aceita uma lista separada por vírgula (ex.: GitHub Pages + localhost ao
// mesmo tempo), não só uma origem única.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:8000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const app = express();
// Na Vercel toda requisição chega por um proxy, que põe o IP real do cliente
// em X-Forwarded-For. Sem isso, o express-rate-limit enxerga só o IP do proxy
// e trata todos os clientes como uma pessoa só: 10 logins errados de gente
// diferente bloqueariam o login de todo mundo.
app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Sem header Origin (curl, apps nativos, webhooks) — permite;
      // navegadores sempre mandam Origin em requisições cross-site, então
      // isso não abre a API pra qualquer site.
      if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(Object.assign(new Error("Origem não permitida por CORS."), { status: 403 }));
    },
  })
);
// O webhook do Stripe precisa do corpo cru pra conferir a assinatura; com o
// corpo já lido aqui, o express.json abaixo não mexe nele.
app.use("/payments/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// Limpeza de fundo (auditoria M7): pedidos PIX/cartão vencidos, estornos
// pendentes e mensagens antigas do Fale conosco. O Cron da Vercel chama com
// "Authorization: Bearer <CRON_SECRET>" (ver vercel.json); sem a variável, a
// rota fica fechada. A lista de pedidos do admin também roda a limpeza.
app.get("/cron/limpeza", async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Não autorizado." });
  try {
    await runMaintenance();
    await purgeOldContactMessages();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.use("/auth", authRouter);
app.use("/products", productsRouter);
app.use("/categories", categoriesRouter);
app.use("/tables", tablesRouter);
app.use("/orders", ordersRouter);
app.use("/payments", paymentsRouter);
app.use("/contact", contactRouter);
app.use("/", waitersRouter);
app.use("/", adminRouter);

// Handler de erro genérico — nunca vaza stack trace/detalhe interno pro cliente.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large")
    return res.status(413).json({ error: "Arquivo grande demais. Use uma foto menor." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Corpo da requisição inválido." });
  if (err.status === 403) return res.status(403).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

app.use((req, res) => res.status(404).json({ error: "Rota não encontrada." }));
