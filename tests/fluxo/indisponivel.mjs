// Teste de item indisponível num navegador de verdade (Chromium): o que o
// admin/cozinha marca como indisponível (ou com estoque zerado) some do
// cardápio do cliente, sai do carrinho com um aviso e volta quando reativado.
// API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/indisponivel.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' });
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  if (role) await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
// Simula o cliente voltando para a aba: o app busca o cardápio de novo na hora.
const voltaParaAba = async page => { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(700); };
const item = (page, nome) => page.locator('.pbody').filter({ hasText: nome });
const setSoldOut = (page, id, v) => { page.api.db.products.find(p => p.id === id).soldOut = v; };

await step('cliente: indisponível some do cardápio', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { role: 'cliente' });
  let t = await text(page);
  check('cliente: item esgotado (Açaí) não aparece no cardápio', !t.includes('Açaí') && t.includes('Caipirinha') && t.includes('Batata Frita'));
  check('cliente: sem aviso "Esgotado"/"Indisponível" no cardápio', !/Esgotado|Indispon/i.test(t), t.slice(0, 300));

  // Coloca a Caipirinha no carrinho e a cozinha marca como indisponível.
  await item(page, 'Caipirinha').locator('.addbtn').click();
  await page.waitForTimeout(400);
  check('cliente: Caipirinha foi pro carrinho', await item(page, 'Caipirinha').locator('.stepper').count() === 1);
  setSoldOut(page, 'p3', true);
  await voltaParaAba(page);
  t = await text(page);
  check('cliente: Caipirinha some do cardápio sem recarregar', await item(page, 'Caipirinha').count() === 0);
  check('cliente: aviso curto de que saiu do carrinho', t.includes('Caipirinha acabou e saiu do seu carrinho.'), t.slice(0, 300));
  check('cliente: carrinho ficou vazio', !t.includes('no carrinho') && !t.replace('Caipirinha acabou e saiu do seu carrinho.', '').includes('Caipirinha'));

  // Reativou: volta pro cardápio.
  setSoldOut(page, 'p3', false);
  await voltaParaAba(page);
  check('cliente: Caipirinha volta quando reativada', await item(page, 'Caipirinha').count() === 1);

  // Estava olhando o detalhe do produto quando ele acabou: volta pro cardápio.
  await item(page, 'Peixe Frito').locator('div').first().click();
  await page.waitForTimeout(500);
  setSoldOut(page, 'p4', true);
  await voltaParaAba(page);
  t = await text(page);
  check('cliente: detalhe de item que acabou volta pro cardápio', t.includes('Esse item acabou e saiu do cardápio.') && await item(page, 'Peixe Frito').count() === 0, t.slice(0, 300));

  for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t = await text(page);
    check(`cliente ${nome}: cardápio sem itens indisponíveis e sem rolagem lateral`, scroll <= 0 && !t.includes('Açaí') && t.includes('Água de Coco'), String(scroll));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/indisponivel-${nome}.png` });
  }
  check('cliente: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await step('admin e cozinha continuam vendo o item', async () => {
  for (const [role, path] of [['admin', 'app-cliente.dc.html?module=admin&screen=productForm'], ['cozinha', 'app-cliente.dc.html?module=cozinha&screen=unavailable']]) {
    const page = await open(path, { role });
    const t = await text(page);
    check(`${role}: Açaí esgotado continua na lista para reativar`, t.includes('Açaí'), t.slice(0, 300));
    await page.close();
  }
});

await browser.close();
server.close();
if (results.some(r => !r.ok)) process.exit(1);
