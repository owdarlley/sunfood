// Teste do pedido mínimo num navegador de verdade (Chromium): o admin liga e
// desliga o mínimo em "Quiosque e mesas" sem perder o valor salvo, e o
// carrinho do cliente segue o que o admin escolheu. API falsa em memória.
// Uso: node fluxo/admin/pedido-minimo.mjs   (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
  await page.route(/maps\.google\.com|google\.com\/maps/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>mapa</p>' }));
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
    // Igual à API de verdade: muda só o que veio e devolve as configurações.
    if (p === '/kiosk-settings/min-order') {
      if (body.minOrder === undefined && body.enabled === undefined) return json(400, { error: 'Dados inválidos.' });
      if (body.minOrder !== undefined) api.db.kiosk.minOrder = body.minOrder;
      if (body.enabled !== undefined) api.db.kiosk.minOrderEnabled = body.enabled;
      return json(200, api.db.kiosk);
    }
    return api(route);
  });
  page.api = api;
  if (role) await page.addInitScript(r => { try { localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); } catch (e) {} }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

const called = (page, p) => page.api.db.calls.filter(c => c.p === p);


const VIEWS = [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const sw = page => page.getByRole('switch', { name: 'Cobrar pedido mínimo' });

// 1. Admin desliga e liga o pedido mínimo
await step('admin pedido mínimo', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=tables', { role: 'admin', kiosk: { minOrder: 25, minOrderEnabled: true } });
  let t = await text(page);
  check('admin: mostra o mínimo ligado com o valor', t.includes('Ligado: R$ 25,00'), t.slice(0, 300));
  check('admin: chave começa ligada', await sw(page).getAttribute('aria-checked') === 'true');
  await sw(page).click(); await page.waitForTimeout(600);
  const call = called(page, '/kiosk-settings/min-order')[0];
  check('admin: desligar manda só enabled=false com o token', call && JSON.stringify(call.body) === '{"enabled":false}' && call.auth === 'Bearer tok', JSON.stringify(call));
  t = await text(page);
  check('admin: avisa que desligou e guarda o valor', t.includes('Pedido mínimo desligado.') && t.includes('O valor salvo (R$ 25,00)'), t.slice(0, 300));
  check('admin: chave fica desligada', await sw(page).getAttribute('aria-checked') === 'false');
  check('admin: aviso de desligado sai em verde (sucesso)', await page.locator('.alert-ok', { hasText: 'Pedido mínimo desligado.' }).count() === 1);
  await page.waitForTimeout(3500); // o admin recarrega as configurações a cada 3 s
  check('admin: atualização automática mantém desligado', await sw(page).getAttribute('aria-checked') === 'false');
  await page.locator('input[aria-label="Pedido mínimo, em reais"]').fill('15');
  await click(page, 'Salvar mínimo', true);
  check('admin: mudar o valor com o mínimo desligado continua funcionando', page.api.db.kiosk.minOrder === 15 && (await text(page)).includes('O valor salvo (R$ 15,00)'));
  await sw(page).click(); await page.waitForTimeout(600);
  check('admin: liga de novo com o valor novo', page.api.db.kiosk.minOrderEnabled === true && (await text(page)).includes('Ligado: R$ 15,00'));
  for (const [nome, viewport] of VIEWS) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    await sw(page).scrollIntoViewIfNeeded();
    const box = await sw(page).boundingBox();
    check(`admin ${nome}: chave aparece e cabe na tela`, box && box.width >= 40 && box.x + box.width <= viewport.width && await noScroll(page), JSON.stringify(box));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-pedido-minimo-${nome}.png` });
  }
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Falha na API volta a chave para como estava
await step('admin pedido mínimo falha', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=tables', { role: 'admin', kiosk: { minOrder: 25 } });
  await page.route('http://localhost:8787/kiosk-settings/min-order', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Não foi possível salvar o pedido mínimo."}' }));
  await sw(page).click(); await page.waitForTimeout(600);
  check('admin: erro volta a chave para ligada e avisa', await sw(page).getAttribute('aria-checked') === 'true' && (await text(page)).includes('Não foi possível salvar o pedido mínimo.'));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
