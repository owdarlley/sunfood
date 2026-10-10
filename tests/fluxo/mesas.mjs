// Teste da quantidade de mesas num navegador de verdade (Chromium): o admin
// escolhe quantas mesas existem e o cliente só consegue pedir de 1 até esse
// número. API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/mesas.mjs   (a partir da raiz do repositório)
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
    // Igual à API de verdade: cria as mesas que faltam, as que sobram somem.
    if (p === '/kiosk-settings/table-count') {
      const n = body.count;
      if (!Number.isInteger(n) || n < 1 || n > 500) return json(400, { error: 'Dados inválidos.', details: [{ message: 'O máximo é 500 mesas.' }] });
      api.db.kiosk.tableCount = n;
      for (let i = 1; i <= n; i++) if (!api.db.tables.some(t => t.number === i)) api.db.tables.push({ number: i, active: true, seats: 4 });
      api.db.tables = api.db.tables.filter(t => t.number <= n);
      return json(200, api.db.kiosk);
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
  await page.locator('input[type=password]').first().fill('senha');
  await click(page, 'Entrar', true);
}


// 1. Admin escolhe a quantidade de mesas (a API falsa começa com 5)
await step('admin quantidade de mesas', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=tables', { role: 'admin' });
  let t = await text(page);
  check('admin: campo "Quantidade de mesas" aparece', t.includes('Quantidade de mesas'));
  const inp = page.locator('#tableCountInp');
  check('admin: mostra a quantidade de hoje', await inp.getAttribute('placeholder') === 'Hoje: 5', await inp.getAttribute('placeholder'));
  const salvar = async () => { await page.locator('#tableCountInp ~ div').click(); await page.waitForTimeout(600); };
  await inp.fill('0');
  await salvar();
  check('admin: recusa 0 sem chamar a API', (await text(page)).includes('Digite um número de 1 a 500.') && !called(page, '/kiosk-settings/table-count').length);
  await inp.fill('8');
  await salvar();
  const call = called(page, '/kiosk-settings/table-count')[0];
  check('admin: envia a quantidade com o token', call && call.body.count === 8 && call.auth === 'Bearer tok', JSON.stringify(call));
  t = await text(page);
  check('admin: confirma "Agora o quiosque tem 8 mesas."', t.includes('Agora o quiosque tem 8 mesas.'));
  check('admin: mostra 8 mesas, a 2 continua desativada', t.includes('7 de 8 ativas'), (t.match(/\d+ de \d+ ativas/) || [])[0]);
  await inp.fill('3');
  await salvar();
  check('admin: diminuir tira as mesas de sobra', (await text(page)).includes('2 de 3 ativas'));
  for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const box = await page.locator('#tableCountInp').boundingBox();
    const btn = await page.locator('#tableCountInp ~ div').boundingBox();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`admin ${nome}: campo e botão cabem na tela`, box && btn && box.width >= 80 && btn.x + btn.width <= viewport.width && scroll <= 0, JSON.stringify({ box, btn, scroll }));
    if (process.env.SHOTS) await page.locator('#tableCountInp').scrollIntoViewIfNeeded().then(() => page.screenshot({ path: `${process.env.SHOTS}/mesas-${nome}.png` }));
  }
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Cliente: mesa acima da quantidade é recusada com a faixa certa
await step('cliente mesa fora da faixa', async () => {
  const page = await open('app-cliente.dc.html');
  await login(page);
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Ir para pagamento');
  const mesa = page.getByPlaceholder('00');
  await mesa.fill('123');
  check('cliente: aceita número de 3 dígitos', await mesa.inputValue() === '123', await mesa.inputValue());
  await mesa.fill('9');
  await click(page, 'Confirmar mesa');
  const t = await text(page);
  check('cliente: avisa "Mesa 9 não existe (o quiosque tem mesas de 1 a 5)"', t.includes('Mesa 9 não existe (o quiosque tem mesas de 1 a 5)'), (t.match(/Mesa 9[^\n]*/) || [])[0]);
  check('cliente: não vai para o pagamento', !t.includes('Total do pedido · Mesa 9'));
  check('cliente: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
