// Teste de fluxo das telas do Sunfood num navegador de verdade (Chromium),
// com uma API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/telas.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR; // opcional: pasta com node_modules de react/react-dom/@babel/standalone
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// Servidor estático do site (igual ao GitHub Pages, só que local).
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };

async function open(path, { role, seed } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 } });
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) api.seed();
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  if (role && role !== 'cliente') await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

// 1. Páginas do site abrem sem erro de JavaScript
for (const p of ['index.html', 'sobre.html', 'funcionalidades.html', 'como-funciona.html', 'perfis.html', 'mapa.html', 'contato.html', 'termos.html', 'privacidade.html', 'redefinir-senha.html']) {
  const page = await open(p);
  check(`página ${p} abre sem erro`, page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
}

// 2. Cliente: login -> cardápio -> carrinho -> mesa -> PIX -> confirmação
await step('fluxo do cliente', async () => {
  const page = await open('app-cliente.dc.html');
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  let t = await text(page);
  check('cliente: login abre o cardápio', t.includes('Batata Frita') && t.includes('Água de Coco'));
  check('cliente: item sem estoque aparece como Esgotado', /Açaí[\s\S]*Esgotado/.test(t));
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  t = await text(page);
  check('cliente: carrinho soma subtotal + 10% de taxa', t.includes('R$ 50,00') && t.includes('R$ 5,00') && t.includes('R$ 55,00'));
  await click(page, 'Ir para pagamento');
  t = await text(page);
  check('cliente: aviso de mesas ativas vem do cadastro de mesas', t.includes('Mesas ativas: 1, 3 a 5.'), (t.match(/Mesas? ativas?:[^\n]*/) || [])[0]);
  await page.getByPlaceholder('00').fill('2');
  await click(page, 'Confirmar mesa');
  check('cliente: mesa inativa é recusada', !(await text(page)).includes('Total do pedido · Mesa 2'));
  await page.getByPlaceholder('00').fill('1');
  await click(page, 'Confirmar mesa');
  check('cliente: mesa ativa leva ao pagamento', (await text(page)).includes('Mesa 1'));
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$');
  const sent = page.api.db.orders[0];
  check('cliente: pedido enviado com mesa e itens certos', sent && sent.tableNumber === 1 && sent.items[0].productId === 'p1' && sent.items[0].qty === 2, JSON.stringify(sent?.items));
  t = await text(page);
  check('cliente: tela do PIX abre', t.includes('Pagamento via PIX'));
  check('cliente: tela do PIX mostra o valor do pedido (R$ 55,00)', /Valor a pagar\s*R\$ 55,00/.test(t), (t.match(/Valor a pagar\s*(R\$ [\d,.]+)/) || [])[1]);
  await click(page, 'Simular pagamento aprovado');
  await page.waitForTimeout(800);
  t = await text(page);
  check('cliente: pagamento aprovado leva à confirmação', t.includes('Pedido Confirmado') || t.includes('confirmado'));
  check('cliente: sem erro de JavaScript no fluxo', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

// 3. Cozinha: kanban avança Na Fila -> Em Preparo -> Pronto -> Entregue
await step('fluxo da cozinha', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  check('cozinha: pedido aparece na fila com observação', (await text(page)).includes('Obs: sem sal'));
  await click(page, 'Iniciar preparo'); await click(page, 'Marcar como pronto'); await click(page, 'Marcar como entregue');
  check('cozinha: pedido chega a Entregue', page.api.db.orders[0].status === 'Entregue', page.api.db.orders[0].status);
  check('cozinha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 4. Admin: todas as telas renderizam
for (const sc of ['dashboard', 'orders', 'productForm', 'tables', 'pause', 'perfSales', 'perfOps', 'closeDay']) {
  await step(`admin ${sc}`, async () => {
    const page = await open(`app-cliente.dc.html?module=admin&screen=${sc}`, { role: 'admin', seed: true });
    const err = page.jsErrors.join(' | ') || await renderError(page);
    check(`admin: tela ${sc} abre sem erro`, !err, err);
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
