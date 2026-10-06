// Teste de excluir item do cardápio num navegador de verdade (Chromium): o
// admin clica em Excluir, confirma (ou desiste) e o item some da lista.
// API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/excluir-produto.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) api.seed();
  if (kiosk) Object.assign(api.db.kiosk, kiosk);
  api.db.calls = [];
  // Rotas de conta que a API falsa comum não tem.
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    // Igual à API de verdade: apaga (ou arquiva) e some do cardápio.
    const del = p.match(/^\/products\/([^/]+)$/);
    if (del && req.method() === 'DELETE') {
      const before = api.db.products.length;
      api.db.products = api.db.products.filter(x => x.id !== del[1]);
      return before === api.db.products.length ? json(404, { error: 'Produto não encontrado.' }) : json(200, { action: 'deleted' });
    }
    return api(route);
  });
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

const called = (page, p) => page.api.db.calls.filter(c => c.p === p);
async function login(page) {
  await page.getByPlaceholder('voce@email.com').first().fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
}



const deletes = page => page.api.db.calls.filter(c => /^\/products\/[^/]+$/.test(c.p) && !c.body.name);
const card = (page, nome) => page.locator('.pgrid .card').filter({ hasText: nome });

await step('admin exclui item', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin' });
  check('admin: botão Excluir em cada item', await page.locator('.pgrid .card').getByText('Excluir', { exact: true }).count() === 5);

  await card(page, 'Caipirinha').getByText('Excluir', { exact: true }).click(); await page.waitForTimeout(400);
  let t = await text(page);
  check('admin: pede confirmação antes de excluir', t.includes('Excluir Caipirinha?') && t.includes('Pedidos antigos e relatórios continuam'));
  check('admin: nada é apagado só de clicar em Excluir', !deletes(page).length);
  await card(page, 'Caipirinha').getByText('Cancelar', { exact: true }).click(); await page.waitForTimeout(400);
  t = await text(page);
  check('admin: Cancelar desiste e mantém o item', !t.includes('Excluir Caipirinha?') && t.includes('Caipirinha') && !deletes(page).length);

  // Editando o item que vai ser excluído: o formulário volta para "Novo produto".
  await card(page, 'Caipirinha').getByText('Editar', { exact: true }).click(); await page.waitForTimeout(400);
  await card(page, 'Caipirinha').getByText('Excluir', { exact: true }).click(); await page.waitForTimeout(400);
  for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const btn = await card(page, 'Caipirinha').locator('.btn-danger').boundingBox();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`admin ${nome}: confirmação cabe na tela`, btn && btn.x >= 0 && btn.x + btn.width <= viewport.width && btn.height >= 30 && scroll <= 0, JSON.stringify({ btn, scroll }));
    if (process.env.SHOTS) await card(page, 'Caipirinha').scrollIntoViewIfNeeded().then(() => page.screenshot({ path: `${process.env.SHOTS}/excluir-${nome}.png` }));
  }
  await card(page, 'Caipirinha').getByText('Sim, excluir').click(); await page.waitForTimeout(700);
  const call = deletes(page)[0];
  check('admin: chama DELETE /products/p3 com o token', call && call.p === '/products/p3' && call.auth === 'Bearer tok', JSON.stringify(call));
  t = await text(page);
  check('admin: item some da lista', !t.includes('Caipirinha') && t.includes('Água de Coco'));
  check('admin: avisa "Produto excluído do cardápio."', t.includes('Produto excluído do cardápio.'));
  check('admin: formulário volta para Novo produto', t.includes('Novo produto') && !t.includes('Editar produto'));
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
