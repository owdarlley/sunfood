import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { categorySchema, categoryOrderSchema, validate } from "../validation/schemas.js";

export const categoriesRouter = Router();

const toApi = (row) => ({ name: row.name, color: row.color, position: row.position });

// Erros do Postgres que viram mensagem pro admin.
function dbError(res, error, fallback) {
  if (error?.code === "23505") return res.status(409).json({ error: "Já existe uma categoria com esse nome." });
  if (error?.code === "23514") return res.status(409).json({ error: "Essa categoria ainda tem itens. Mova ou exclua os itens antes." });
  return res.status(500).json({ error: fallback });
}

// Público: o cardápio do cliente monta as abas com isso.
categoriesRouter.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("categories").select("*").order("position").order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar categorias." });
  res.json(data.map(toApi));
});

// Admin: nova categoria entra no fim da lista.
categoriesRouter.post("/", requireAuth, requireRole("admin"), validate(categorySchema), async (req, res) => {
  const { data: last } = await supabaseAdmin
    .from("categories")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await supabaseAdmin
    .from("categories")
    .insert({ ...req.body, position: (last?.position ?? 0) + 1 })
    .select()
    .single();
  if (error) return dbError(res, error, "Não foi possível criar a categoria.");
  res.status(201).json(toApi(data));
});

// Admin: nova ordem (a lista inteira de nomes, na ordem da tela). Vem antes de
// /:name pra "reorder" não ser lido como nome de categoria.
categoriesRouter.post("/reorder", requireAuth, requireRole("admin"), validate(categoryOrderSchema), async (req, res) => {
  const { error } = await supabaseAdmin.rpc("reorder_categories", { p_names: req.body.names });
  if (error) {
    if (/category_list_mismatch/.test(error.message || ""))
      return res.status(409).json({ error: "As categorias mudaram. Recarregue a tela." });
    return res.status(500).json({ error: "Não foi possível reordenar." });
  }
  res.json({ ok: true });
});

// Admin: renomear e/ou trocar a cor. Renomear leva os itens junto (o banco
// atualiza products.category sozinho).
categoriesRouter.put("/:name", requireAuth, requireRole("admin"), validate(categorySchema), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("categories")
    .update(req.body)
    .eq("name", req.params.name)
    .select()
    .maybeSingle();
  if (error) return dbError(res, error, "Não foi possível salvar a categoria.");
  if (!data) return res.status(404).json({ error: "Categoria não encontrada." });
  res.json(toApi(data));
});

// Admin: excluir. Só sai se não tiver item ativo nela (o banco recusa) e se
// não for a última (o formulário de produto precisa de pelo menos uma).
categoriesRouter.delete("/:name", requireAuth, requireRole("admin"), async (req, res) => {
  const { data: all, error: listError } = await supabaseAdmin.from("categories").select("name");
  if (listError) return res.status(500).json({ error: "Não foi possível excluir a categoria." });
  if (!all.some((c) => c.name === req.params.name)) return res.status(404).json({ error: "Categoria não encontrada." });
  if (all.length <= 1) return res.status(409).json({ error: "O cardápio precisa de pelo menos uma categoria." });
  const { error } = await supabaseAdmin.from("categories").delete().eq("name", req.params.name);
  if (error) return dbError(res, error, "Não foi possível excluir a categoria.");
  res.json({ ok: true });
});
