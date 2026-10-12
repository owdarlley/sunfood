// Número curto do pedido: o servidor manda "number" (1, 2, 3... por dia) e o
// app mostra #001, #002 em vez do id gigante (uuid). Confere o cliente
// (pedido em andamento e histórico), a cozinha e o admin, e que pedido sem
// número mostra só o começo do id (celular, tablet, computador e tela larga).
// Uso: node fluxo/numero-pedido.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const file = path === '/' ? 'index.html' : path;
    const b = await readFile(join(ROOT, file)); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(b);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };

const UUID = '3f9c2b7e-8d41-4a6f-9b0e-5c7d1e2f3a4b';
const ANTIGO = 'a1b2c3d4-0000-4000-8000-000000000001';
const pedido = (id, extra) => ({ id, tableNumber: 3, customerName: 'Ana Teste', status: 'Na Fila', subtotal: 25, total: 27.5, note: '',
  paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  items: [{ productId: 'p1', name: 'Batata Frita', qty: 1, unitPrice: 25, note: '' }], ...extra });

async function open(vp, role, path) {
  const mobile = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role);
  api.db.orders.push(pedido(UUID, { number: 7 }), pedido(ANTIGO, { status: 'Entregue' }));
  await ctx.route('http://localhost:8787/**', api);
  await ctx.addInitScript(r => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  await page.goto(BASE + 'app-cliente.dc.html?' + path);
  await page.waitForTimeout(1500);
  return page;
}
const text = p => p.locator('body').innerText();
const semUuid = t => !t.includes(UUID) && !t.includes(ANTIGO) && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(t);

const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
for (const [nome, vp] of TELAS) {
  try {
    let p = await open(vp, 'cliente', 'module=cliente&screen=status');
    let t = await text(p);
    check(`${nome}: cliente vê o pedido em andamento como #007`, t.includes('#007') && semUuid(t), t.slice(0, 200));
    await p.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=history'); await p.waitForTimeout(1200);
    t = await text(p);
    check(`${nome}: histórico mostra #007 e o pedido sem número encurtado (#A1B2C3)`, t.includes('#007') && t.includes('#A1B2C3') && semUuid(t), t.slice(0, 200));
    check(`${nome}: cliente sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();

    p = await open(vp, 'cozinha', 'module=cozinha&screen=kanban');
    t = await text(p);
    check(`${nome}: cozinha vê #007`, t.includes('#007') && semUuid(t), t.slice(0, 200));
    await p.context().close();

    p = await open(vp, 'admin', 'module=admin&screen=orders');
    t = await text(p);
    check(`${nome}: admin vê #007 na lista de pedidos`, t.includes('#007') && semUuid(t), t.slice(0, 200));
    await p.context().close();
  } catch (e) { check(`${nome}: rodou até o fim`, false, e.message.split('\n')[0]); }
}

await browser.close();
server.close();
const falhas = results.filter(ok => !ok).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
