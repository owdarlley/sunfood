// Recarregar sem "tremer" e toques que respondem na hora.
// - A página é baixada uma vez só (antes o app baixava a si mesmo de novo).
// - Primeira visita: cartões vazios até o cardápio chegar (nada de itens de
//   exemplo trocados na frente da pessoa).
// - Recarregar: abre com o cardápio guardado e nada sai do lugar.
// - Cozinha/admin: o pedido muda de coluna no toque, antes do servidor responder.
// Celular, tablet e computador. Uso: node fluxo/desempenho.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const hits = {};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); hits[path] = (hits[path] || 0) + 1;
  try { const file = path === '/' ? 'index.html' : path; const b = await readFile(join(ROOT, file)); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(b); }
  catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };

async function context(vp, role, api) {
  const mobile = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(/accounts\.google|supabase/, r => r.abort());
  await ctx.route('http://localhost:8787/**', api);
  await ctx.addInitScript(r => {
    localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } }));
    window.__shift = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: 'layout-shift', buffered: true });
  }, role);
  return ctx;
}

for (const [nome, vp] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }]]) {
  // Cardápio demora a chegar (internet lenta / servidor acordando).
  const api = fakeApi('cliente');
  let segurar = true;
  const lenta = async route => { if (segurar && new URL(route.request().url()).pathname === '/products') await new Promise(r => setTimeout(r, 1500)); return api(route); };
  const ctx = await context(vp, 'cliente', lenta);
  const page = await ctx.newPage();
  for (const k in hits) delete hits[k];
  await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=menu');
  await page.waitForTimeout(700);
  const durante = await page.locator('body').innerText();
  check(`${nome}: primeira visita mostra cartões vazios, não itens de exemplo`, (await page.locator('.pcard.sk').count()) > 0 && !durante.includes('Camarão'), durante.slice(0, 120));
  await page.waitForTimeout(1600);
  check(`${nome}: cardápio de verdade aparece quando chega`, (await page.locator('.pcard.sk').count()) === 0 && (await page.locator('body').innerText()).includes('Batata Frita'));
  check(`${nome}: a página é baixada uma vez só`, hits['/app-cliente.dc.html'] === 1, JSON.stringify(hits));

  // Recarregar: abre com o cardápio guardado, sem nada pular.
  await page.reload();
  await page.waitForTimeout(400);
  check(`${nome}: ao recarregar o cardápio já aparece na hora`, (await page.locator('.pcard.sk').count()) === 0 && (await page.locator('body').innerText()).includes('Batata Frita'));
  await page.waitForTimeout(1800);
  const shift = await page.evaluate(() => window.__shift);
  check(`${nome}: ao recarregar nada sai do lugar`, shift < 0.01, 'deslocamento ' + shift.toFixed(3));
  check(`${nome}: sem rolagem para os lados`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  segurar = false;
  await ctx.close();

  // Cozinha: o cartão muda de coluna antes do servidor responder.
  const capi = fakeApi('cozinha'); capi.seed && capi.seed();
  let lento = false;
  const cozApi = async route => { if (lento && route.request().method() === 'PATCH') await new Promise(r => setTimeout(r, 2000)); return capi(route); };
  const cctx = await context(vp, 'cozinha', cozApi);
  const coz = await cctx.newPage();
  await coz.goto(BASE + 'app-cliente.dc.html?module=cozinha&screen=kanban');
  await coz.waitForTimeout(1500);
  const botao = coz.getByText(/^(Iniciar preparo|Começar|Preparar|Marcar como pronto|Pronto)/).first();
  if (await botao.count()) {
    const antes = await coz.locator('body').innerText();
    lento = true;
    await botao.click();
    await coz.waitForTimeout(250);
    const depois = await coz.locator('body').innerText();
    check(`${nome}: cozinha muda o pedido no toque, sem esperar o servidor`, antes !== depois);
    await coz.waitForTimeout(2500);
    lento = false;
  } else check(`${nome}: cozinha tem botão para avançar o pedido`, false, (await coz.locator('body').innerText()).slice(0, 200));
  await cctx.close();
}

await browser.close(); server.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok} de ${results.length} checagens passaram.`);
process.exit(ok === results.length ? 0 : 1);
