import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { removeAvatarFile } from "./auth.js";
import {
  REPORT_PERIODS,
  salesReportQuerySchema,
  waiterActiveSchema,
  waiterCreateSchema,
  validate,
} from "../validation/schemas.js";

export const waitersRouter = Router();

// Conta desativada = bloqueada no Supabase Auth (não entra mais), sem apagar
// nada: os pedidos que o garçom lançou e entregou continuam nas métricas.
const BAN_FOREVER = "876000h"; // ~100 anos

const isBanned = (authUser) => Boolean(authUser?.banned_until && new Date(authUser.banned_until) > new Date());

function metricsToApi(period, data) {
  return {
    period,
    from: data.from,
    to: data.to,
    delivered: Number(data.delivered),
    avgDeliverMin: Number(data.avgDeliverMin),
    launched: Number(data.launched),
    launchedTotal: Number(data.launchedTotal),
    received: Number(data.received),
    byDay: (data.byDay || []).map((d) => ({ date: d.date, delivered: Number(d.delivered), launched: Number(d.launched) })),
  };
}

// Pedidos do garçom no período: os que ele lançou na mesa e os que entregou.
// Duas consultas (em vez de um "or") e junta sem repetir quem está nas duas.
async function waiterOrders(waiterId, fromDate) {
  // Meia-noite de São Paulo (UTC-3, sem horário de verão) do primeiro dia.
  const start = new Date(`${fromDate}T00:00:00-03:00`).toISOString();
  // "*" como nas outras rotas de pedido: uma coluna listada aqui que o banco
  // ainda não tem (ex.: daily_number antes da migração) derrubava a consulta.
  const select = "*, order_items(name, qty)";
  const [launched, delivered] = await Promise.all([
    supabaseAdmin.from("orders").select(select).eq("waiter_id", waiterId).gte("created_at", start),
    supabaseAdmin.from("orders").select(select).eq("delivered_by", waiterId).gte("delivered_at", start),
  ]);
  if (launched.error || delivered.error) return null;
  const byId = new Map();
  for (const row of [...launched.data, ...delivered.data]) byId.set(row.id, row);
  const rows = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const ids = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { data: profiles } = await supabaseAdmin.from("profiles").select("id, name").in("id", ids);
    for (const p of profiles || []) names.set(p.id, p.name);
  }
  return rows.map((row) => ({
    id: row.id,
    number: row.daily_number ?? null,
    tableNumber: row.table_number,
    customerName: names.get(row.customer_id) || null,
    status: row.status,
    total: Number(row.total),
    paymentMethod: row.payment_method,
    receivedWith: row.received_with,
    launched: row.waiter_id === waiterId,
    delivered: row.delivered_by === waiterId,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    items: (row.order_items || []).map((it) => ({ name: it.name, qty: it.qty })),
  }));
}

async function findWaiter(id) {
  const { data } = await supabaseAdmin.from("profiles").select("id, name, email, role, avatar_path, created_at").eq("id", id).maybeSingle();
  return data && data.role === "garcom" ? data : null;
}

// Garçom: as próprias métricas no período (hoje, 7 ou 30 dias).
waitersRouter.get(
  "/waiter/metrics",
  requireAuth,
  requireRole("garcom"),
  validate(salesReportQuerySchema, "query"),
  async (req, res) => {
    const period = req.query.period || "hoje";
    const { data, error } = await supabaseAdmin.rpc("waiter_metrics", { p_waiter: req.user.sub, p_days: REPORT_PERIODS[period] });
    if (error) return res.status(500).json({ error: "Erro ao calcular suas métricas." });
    res.json(metricsToApi(period, data));
  }
);

// Cozinha e admin: se há garçom cadastrado. Com garçom, quem marca "Entregue"
// é ele; a cozinha para em "Pronto".
waitersRouter.get("/waiters/any", requireAuth, requireRole("admin", "cozinha"), async (req, res) => {
  const { data, error } = await supabaseAdmin.from("profiles").select("id").eq("role", "garcom").limit(1);
  if (error) return res.status(500).json({ error: "Erro ao carregar os garçons." });
  res.json({ hasWaiters: (data || []).length > 0 });
});

// Admin: lista dos garçons, com o que cada um fez hoje.
waitersRouter.get("/waiters", requireAuth, requireRole("admin"), async (req, res) => {
  const { data: rows, error } = await supabaseAdmin
    .from("profiles")
    .select("id, name, email, created_at")
    .eq("role", "garcom")
    .order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar os garçons." });
  const waiters = await Promise.all(
    rows.map(async (row) => {
      const [{ data: found }, { data: today }] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(row.id),
        supabaseAdmin.rpc("waiter_metrics", { p_waiter: row.id, p_days: 1 }),
      ]);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        createdAt: row.created_at,
        active: !isBanned(found?.user),
        deliveredToday: Number(today?.delivered || 0),
        launchedToday: Number(today?.launched || 0),
      };
    })
  );
  res.json(waiters);
});

// Admin: cria a conta de um garçom. O e-mail já sai confirmado (quem cadastra
// é o quiosque) e o papel vira "garcom" logo depois que o banco cria o perfil.
waitersRouter.post("/waiters", requireAuth, requireRole("admin"), validate(waiterCreateSchema), async (req, res) => {
  const { name, email, password } = req.body;
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error || !data?.user) {
    if (error?.code === "email_exists" || /already (been )?registered|already exists/i.test(error?.message || "")) {
      return res.status(409).json({ error: "Já existe uma conta com esse e-mail." });
    }
    if (error?.code === "weak_password") {
      return res.status(400).json({ error: "Senha fraca. Use pelo menos 8 caracteres, misturando letras e números." });
    }
    return res.status(500).json({ error: "Não foi possível criar a conta do garçom." });
  }
  const { error: roleError } = await supabaseAdmin
    .from("profiles")
    .update({ role: "garcom", name })
    .eq("id", data.user.id);
  if (roleError) {
    // Sem o papel certo a conta entraria como cliente: desfaz a criação.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    return res.status(500).json({ error: "Não foi possível criar a conta do garçom." });
  }
  res.status(201).json({ id: data.user.id, name, email, active: true, deliveredToday: 0, launchedToday: 0 });
});

// Admin: desativa (não entra mais) ou reativa um garçom.
waitersRouter.patch("/waiters/:id", requireAuth, requireRole("admin"), validate(waiterActiveSchema), async (req, res) => {
  const { data: row } = await supabaseAdmin.from("profiles").select("id, role").eq("id", req.params.id).maybeSingle();
  if (!row || row.role !== "garcom") return res.status(404).json({ error: "Garçom não encontrado." });
  const { active } = req.body;
  const { error } = await supabaseAdmin.auth.admin.updateUserById(row.id, { ban_duration: active ? "none" : BAN_FOREVER });
  if (error) return res.status(500).json({ error: "Não foi possível salvar." });
  res.json({ id: row.id, active });
});

// Admin: métricas e pedidos de um garçom no período (hoje, 7 ou 30 dias).
// "Atendidos" junta os pedidos que ele lançou ou entregou, sem os cancelados.
waitersRouter.get(
  "/waiters/:id/report",
  requireAuth,
  requireRole("admin"),
  validate(salesReportQuerySchema, "query"),
  async (req, res) => {
    const waiter = await findWaiter(req.params.id);
    if (!waiter) return res.status(404).json({ error: "Garçom não encontrado." });
    const period = req.query.period || "hoje";
    const [{ data, error }, { data: found }] = await Promise.all([
      supabaseAdmin.rpc("waiter_metrics", { p_waiter: waiter.id, p_days: REPORT_PERIODS[period] }),
      supabaseAdmin.auth.admin.getUserById(waiter.id),
    ]);
    if (error) return res.status(500).json({ error: "Erro ao calcular as métricas do garçom." });
    const orders = await waiterOrders(waiter.id, data.from);
    if (!orders) return res.status(500).json({ error: "Erro ao carregar os pedidos do garçom." });
    const served = orders.filter((o) => o.status !== "Cancelado");
    const servedTotal = Math.round(served.reduce((sum, o) => sum + o.total, 0) * 100) / 100;
    res.json({
      waiter: { id: waiter.id, name: waiter.name, email: waiter.email, createdAt: waiter.created_at, active: !isBanned(found?.user) },
      metrics: {
        ...metricsToApi(period, data),
        served: served.length,
        servedTotal,
        avgTicket: served.length ? Math.round((servedTotal / served.length) * 100) / 100 : 0,
      },
      orders,
    });
  }
);

// Admin: exclui a conta do garçom. Os pedidos ficam (relatórios e caixa não
// mudam), só perdem o vínculo com ele: o banco põe waiter_id e delivered_by
// em nulo (ON DELETE SET NULL).
waitersRouter.delete("/waiters/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const waiter = await findWaiter(req.params.id);
  if (!waiter) return res.status(404).json({ error: "Garçom não encontrado." });
  const { error } = await supabaseAdmin.auth.admin.deleteUser(waiter.id);
  if (error) return res.status(500).json({ error: "Não foi possível excluir o garçom." });
  await removeAvatarFile(waiter.avatar_path);
  res.json({ id: waiter.id, message: "Garçom excluído." });
});
