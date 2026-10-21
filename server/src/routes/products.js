import { randomUUID } from "node:crypto";
import express from "express";
import { supabaseAdmin } from "../supabase.js";
import { asyncRouter } from "../async-router.js";
import { expireUnpaidOrdersSoon } from "../order-payments.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { MAX_IMAGE_BYTES, imageType, publicBucketPrefix } from "../images.js";
import { productSchema, soldOutToggleSchema, validate } from "../validation/schemas.js";

export const productsRouter = asyncRouter();

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    longDescription: row.long_description,
    category: row.category,
    price: Number(row.price),
    // Esgotado "de fato" é o sinal manual (cozinha/admin) OU o estoque
    // controlado ter zerado — quem consome essa API não precisa saber qual
    // dos dois motivos foi.
    soldOut: row.sold_out || (row.stock_qty !== null && row.stock_qty <= 0),
    stockQty: row.stock_qty,
    portion: row.portion,
    prepTime: row.prep_time,
    kcal: row.kcal,
    rating: row.rating,
    reviewCount: row.review_count,
    ingredients: row.ingredients,
    imageKey: row.mark,
    imageUrl: row.image_url || null,
    tags: row.tags || [],
  };
}

function fromApi(p) {
  const row = {
    name: p.name,
    description: p.description,
    long_description: p.longDescription,
    category: p.category,
    price: p.price,
    portion: p.portion,
    prep_time: p.prepTime,
  };
  // Só grava o estoque quando ele veio no corpo: editar nome/preço não pode
  // sobrescrever o saldo com um valor velho (pedidos feitos enquanto o
  // formulário estava aberto seriam "desfeitos").
  if (p.stockQty !== undefined) row.stock_qty = p.stockQty;
  // Mesma ideia: ausente = mantém a foto; null = tira a foto.
  if (p.imageUrl !== undefined) row.image_url = p.imageUrl;
  if (p.ingredients !== undefined) row.ingredients = p.ingredients;
  if (p.tags !== undefined) row.tags = p.tags;
  return row;
}

// Fotos dos produtos ficam no Storage do Supabase, num bucket público (o
// cardápio mostra sem login). Só esta API grava nele, com a service role,
// depois de conferir que quem enviou é admin.
export const PRODUCT_IMAGES_BUCKET = "produtos";
function publicImagePrefix() {
  return publicBucketPrefix(PRODUCT_IMAGES_BUCKET);
}

// A foto só pode apontar pro nosso bucket: impede o admin (ou um token roubado)
// de colocar no cardápio uma imagem de um site qualquer.
// Além do prefixo, o resto tem que ser um caminho de foto simples (auditoria
// B-05): nada de "..", outro bucket por trás de barras ou extensão estranha.
// As fotos antigas ficam em cardapio/ e levam ?v= para furar o cache.
const IMAGE_PATH = /^[\w-]+(\/[\w-]+)*\.(jpg|png|webp)(\?v=\d+)?$/;

function checkImageUrl(req, res, next) {
  const url = req.body.imageUrl;
  if (url != null && !(url.startsWith(publicImagePrefix()) && IMAGE_PATH.test(url.slice(publicImagePrefix().length))))
    return res.status(400).json({ error: "Foto inválida. Envie a foto pelo botão do formulário." });
  next();
}

// Apaga a foto do Storage. Se falhar, sobra só um arquivo solto, então não vira erro.
async function removeProductImage(url) {
  if (!url?.startsWith(publicImagePrefix())) return;
  const path = url.slice(publicImagePrefix().length).split("?")[0];
  try {
    await supabaseAdmin.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
  } catch {
    // arquivo solto no bucket não atrapalha o cardápio
  }
}

// A chave estrangeira recusou: a categoria foi excluída ou renomeada enquanto
// o formulário estava aberto.
const MISSING_CATEGORY = "Essa categoria não existe mais. Escolha outra.";

// Público: cardápio do cliente.
productsRouter.get("/", async (req, res) => {
  await expireUnpaidOrdersSoon();
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .is("archived_at", null)
    .order("category")
    .order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar cardápio." });
  // O app consulta a cada 15 s: com no-cache o navegador manda o ETag e,
  // sem mudança, recebe 304 sem o corpo (auditoria M7).
  res.set("Cache-Control", "no-cache");
  res.json(data.map(toApi));
});

// Admin: envia a foto (o navegador já reduz e comprime) e recebe o endereço
// público, que vai no imageUrl ao criar/editar o produto.
productsRouter.post(
  "/images",
  requireAuth,
  requireRole("admin"),
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = imageType(buf);
    if (!type) return res.status(400).json({ error: "Envie uma foto em JPG, PNG ou WebP." });
    const path = `${randomUUID()}.${type.ext}`;
    const { error } = await supabaseAdmin.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(path, buf, { contentType: type.mime, cacheControl: "31536000", upsert: false });
    if (error) return res.status(500).json({ error: "Não foi possível guardar a foto." });
    res.status(201).json({ url: publicImagePrefix() + path });
  }
);

// Admin: criar produto novo (corrige o savePf() do protótipo, que nunca persistia).
productsRouter.post("/", requireAuth, requireRole("admin"), validate(productSchema), checkImageUrl, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .insert(fromApi(req.body))
    .select()
    .single();
  if (error?.code === "23503") return res.status(400).json({ error: MISSING_CATEGORY });
  if (error) return res.status(500).json({ error: "Não foi possível criar o produto." });
  res.status(201).json(toApi(data));
});

// Admin: editar produto existente.
productsRouter.put("/:id", requireAuth, requireRole("admin"), validate(productSchema), checkImageUrl, async (req, res) => {
  // Foto trocada ou retirada: a antiga sai do Storage depois de salvar (B-05).
  let oldImage = null;
  if (req.body.imageUrl !== undefined) {
    const { data: current } = await supabaseAdmin.from("products").select("image_url").eq("id", req.params.id).maybeSingle();
    oldImage = current?.image_url || null;
  }
  let update = supabaseAdmin.from("products").update(fromApi(req.body)).eq("id", req.params.id).is("archived_at", null);
  const base = req.body.stockQty !== undefined ? req.body.stockQtyBase : undefined;
  if (base !== undefined) update = base === null ? update.is("stock_qty", null) : update.eq("stock_qty", base);
  const { data, error } = await update.select().maybeSingle();
  if (error?.code === "23503") return res.status(400).json({ error: MISSING_CATEGORY });
  if (!error && !data && base !== undefined) {
    const { data: now } = await supabaseAdmin.from("products").select("stock_qty").eq("id", req.params.id).is("archived_at", null).maybeSingle();
    if (now) {
      return res.status(409).json({
        error: `O estoque mudou enquanto você editava (agora: ${now.stock_qty ?? "ilimitado"}). Confira e salve de novo.`,
        code: "stock_changed",
        stockQty: now.stock_qty,
      });
    }
  }
  if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
  if (oldImage && oldImage !== data.image_url) {
    // Só apaga se nenhum outro produto (nem arquivado) usa a mesma foto.
    const { data: others } = await supabaseAdmin.from("products").select("id").eq("image_url", oldImage).limit(1);
    if (others && !others.length) await removeProductImage(oldImage);
  }
  res.json(toApi(data));
});

// Admin: excluir item do cardápio. Sem pedidos = apaga de vez (e a foto);
// com pedidos = arquiva, pra não estragar o histórico nem os relatórios.
productsRouter.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc("delete_or_archive_product", { p_id: req.params.id });
  if (error) {
    // id que não é UUID também cai aqui (o Postgres recusa o tipo).
    if (/product_not_found|invalid input syntax/.test(error.message || ""))
      return res.status(404).json({ error: "Produto não encontrado." });
    return res.status(500).json({ error: "Não foi possível excluir o produto." });
  }
  // A foto só sai do Storage quando o produto foi apagado de verdade.
  if (data.action === "deleted") await removeProductImage(data.imageUrl);
  res.json({ action: data.action });
});

// Cozinha (ou admin): sinalizar item indisponível / disponível de novo.
productsRouter.patch(
  "/:id/sold-out",
  requireAuth,
  requireRole("admin", "cozinha"),
  validate(soldOutToggleSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("products")
      .update({ sold_out: req.body.soldOut })
      .eq("id", req.params.id)
      .is("archived_at", null)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
    res.json(toApi(data));
  }
);
