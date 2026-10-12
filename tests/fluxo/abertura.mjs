// Abertura "Sol na areia" da tela de login: aparece na primeira abertura da
// sessão, some sozinha com o logo no lugar, pula com toque, fica curta com
// "reduzir movimento" e não aparece ao recarregar, em painel do rodapé nem
// para quem já entrou. Celular, tablet, computador e tela larga.
// Uso: node fluxo/abertura.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

// A abertura não roda em navegador automatizado (os outros testes não
// esperam por ela); aqui o navegador se passa por um comum.
async function open(path, { viewport = { width: 390, height: 844 }, reducedMotion = 'no-preference', session = false } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion, serviceWorkers: 'block' });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  if (session) await ctx.addInitScript(() => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: 'c@teste', name: 'Teste', role: 'cliente' } })));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|unpkg\.com|localhost:8787/, r => r.abort());
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  await page.goto(BASE + path);
  return page;
}
const tem = p => p.locator('.sfb').count();

for (const [nome, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 800 }], ['tela larga', { width: 1920, height: 1080 }]]) {
  await step(`${nome}: abertura`, async () => {
    const p = await open('index.html', { viewport });
    await p.waitForTimeout(300);
    check(`${nome}: abertura cobre a tela ao abrir`, await tem(p) === 1);
    await p.waitForTimeout(2000);
    check(`${nome}: abertura some sozinha em menos de 2,3 s`, await tem(p) === 0);
    const vis = await p.locator('.lp-logo').evaluate(e => getComputedStyle(e).visibility);
    check(`${nome}: logo do topo fica visível no fim`, vis === 'visible', vis);
    check(`${nome}: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.reload(); await p.waitForTimeout(200);
    check(`${nome}: não repete ao recarregar na mesma sessão`, await tem(p) === 0);
    await p.context().close();
  });
}

await step('toque pula a abertura', async () => {
  const p = await open('index.html');
  await p.waitForTimeout(200);
  await p.mouse.click(195, 420);
  await p.waitForTimeout(700);
  check('toque pula a abertura', await tem(p) === 0);
  await p.context().close();
});

await step('reduzir movimento', async () => {
  const p = await open('index.html', { reducedMotion: 'reduce' });
  await p.waitForTimeout(200);
  const antes = await tem(p);
  await p.waitForTimeout(700);
  check('reduzir movimento: só o logo parado e some em menos de 1 s', antes === 1 && await tem(p) === 0);
  await p.context().close();
});

await step('painel do rodapé', async () => {
  const p = await open('index.html#termos');
  await p.waitForTimeout(200);
  check('link direto para painel do rodapé abre sem abertura', await tem(p) === 0);
  await p.context().close();
});

await step('quem já entrou', async () => {
  const p = await open('index.html', { session: true });
  await p.waitForURL(/app-cliente/);
  check('quem já entrou vai direto para o app, sem abertura', await tem(p) === 0);
  await p.context().close();
});

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
