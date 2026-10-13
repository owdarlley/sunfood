// Teste da localização do quiosque num navegador de verdade (Chromium): o
// admin muda nome, endereço e horário em "Quiosque e mesas" e o cliente vê
// na tela "Localização do quiosque", com o mapa e o "Abrir no mapa" saindo
// do endereço. API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node fluxo/localizacao.mjs   (de dentro de tests)
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
  // O mapa do Google não sai da máquina no teste: vira uma página vazia.
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
    // Igual à API de verdade: valida e devolve as configurações com a localização nova.
    if (p === '/kiosk-settings/location') {
      if (!body.name || !body.address || body.address.trim().length < 5) return json(400, { error: 'Dados inválidos.', details: [{ message: 'Digite o endereço completo.' }] });
      api.db.kiosk.location = { name: body.name.trim(), address: body.address.trim(), hours: (body.hours || '').trim() };
      return json(200, api.db.kiosk);
    }
    return api(route);
  });
  page.api = api;
  // try: o script também roda no iframe do mapa, onde o localStorage é bloqueado.
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


const FACUL = { name: 'Sunfood na Faculdade', address: 'Av. Brasil, 100 - Centro, Santos - SP', hours: 'Seg. a sex., 8h às 22h.' };
const VIEWS = [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]];
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// 1. Admin muda a localização
await step('admin localização', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=tables', { role: 'admin', kiosk: { location: { name: 'Quiosque Sunfood · Praia do Forte', address: 'Av. Beira-Mar, s/n, em frente ao posto 4', hours: '' } } });
  check('admin: painel "Localização do quiosque" aparece', (await text(page)).includes('Localização do quiosque'));
  check('admin: campos vêm preenchidos com a localização atual', await page.locator('#locAddressInp').inputValue() === 'Av. Beira-Mar, s/n, em frente ao posto 4', await page.locator('#locAddressInp').inputValue());
  const salvar = async () => { await click(page, 'Salvar localização', true); await page.waitForTimeout(400); };
  await page.locator('#locAddressInp').fill('  ');
  await salvar();
  check('admin: endereço vazio é recusado sem chamar a API', (await text(page)).includes('Digite o endereço completo.') && !called(page, '/kiosk-settings/location').length);
  await page.locator('#locNameInp').fill(FACUL.name);
  await page.locator('#locAddressInp').fill(FACUL.address);
  check('admin: "Conferir no Google Maps" já usa o endereço digitado', (await page.getByText('Conferir no Google Maps').getAttribute('href')).includes(encodeURIComponent(FACUL.address)));
  await page.locator('#locHoursInp').fill(FACUL.hours);
  await page.waitForTimeout(3500); // o admin recarrega as configurações a cada 3 s: não pode apagar o que foi digitado
  check('admin: atualização automática não apaga o que foi digitado', await page.locator('#locNameInp').inputValue() === FACUL.name);
  await salvar();
  const call = called(page, '/kiosk-settings/location')[0];
  check('admin: envia nome, endereço e horário com o token', call && JSON.stringify(call.body) === JSON.stringify(FACUL) && call.auth === 'Bearer tok', JSON.stringify(call));
  check('admin: confirma "Localização atualizada."', (await text(page)).includes('Localização atualizada.'));
  for (const [nome, viewport] of VIEWS) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const boxes = await Promise.all(['#locNameInp', '#locAddressInp', '#locHoursInp'].map(s => page.locator(s).boundingBox()));
    check(`admin ${nome}: campos cabem na tela`, boxes.every(b => b && b.width >= 150 && b.x + b.width <= viewport.width) && await noScroll(page), JSON.stringify(boxes));
    if (process.env.SHOTS) { await page.locator('#locNameInp').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/admin-localizacao-${nome}.png` }); }
  }
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Cliente vê a localização nova
await step('cliente localização', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=location', { role: 'cliente', kiosk: { location: FACUL } });
  const t = await text(page);
  check('cliente: mostra nome, endereço e horário', t.includes(FACUL.name) && t.includes(FACUL.address) && t.includes(FACUL.hours), t.slice(0, 400));
  check('cliente: texto antigo da praia sumiu', !t.includes('Praia do Forte'));
  const src = await page.locator('.locmap iframe').getAttribute('src');
  check('cliente: mapa do Google com o endereço', src.startsWith('https://maps.google.com/maps?q=' + encodeURIComponent(FACUL.address)) && src.includes('output=embed'), src);
  const href = await page.getByText('Abrir no mapa', { exact: true }).getAttribute('href');
  check('cliente: "Abrir no mapa" vai para o endereço no Google Maps', href === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(FACUL.address), href);
  for (const [nome, viewport] of VIEWS) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const map = await page.locator('.locmap').boundingBox();
    check(`cliente ${nome}: mapa aparece e cabe na tela`, map && map.width >= 250 && map.height >= 200 && map.x + map.width <= viewport.width && await noScroll(page), JSON.stringify(map));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cliente-localizacao-${nome}.png` });
  }
  check('cliente: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
