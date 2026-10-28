// Menu lateral (admin, cozinha e garçom): no computador cabe inteiro na altura
// da tela, sem rolar, e nenhum nome é cortado ("Cardápio e estoque", "Quiosque
// e mesas"), de 1024 × 680 até tela larga, inclusive notebook baixo. No
// celular e no tablet o menu aberto (botão Menu) mostra os nomes inteiros.
// Uso: node fluxo/layout/menu-lateral.mjs   (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CDN = process.env.CDN_DIR;
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
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function open(path, role, viewport) {
  const mobile = viewport.width < 768;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('http://localhost:8787/**', fakeApi(role));
  await page.addInitScript(r => { try { sessionStorage.setItem('sunfood_abertura', '1'); localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@sunfood.com', name: 'Teste', role: r } })); } catch (e) {} }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}
// Quanto o menu passa da própria altura (0 = cabe sem rolar), nomes cortados
// e o menor item (altura real na tela).
const medir = p => p.evaluate(() => {
  const s = document.querySelector('.adm-side');
  const itens = [...s.querySelectorAll('.adm-item')];
  return {
    sobra: s.scrollHeight - s.clientHeight,
    largura: Math.round(s.getBoundingClientRect().width),
    cortados: itens.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText),
    fora: itens.concat([...s.querySelectorAll('.adm-foot .kz-btn')]).filter(e => e.getBoundingClientRect().bottom > innerHeight + 1).map(e => e.innerText),
    menor: Math.round(Math.min(...itens.map(e => e.getBoundingClientRect().height)))
  };
});

const COMPUTADOR = [
  ['tablet deitado', { width: 1024, height: 680 }],
  ['notebook baixo', { width: 1280, height: 573 }],
  ['notebook', { width: 1366, height: 625 }],
  ['computador', { width: 1536, height: 730 }],
  ['tela larga', { width: 1920, height: 950 }],
  ['janela bem baixa', { width: 1100, height: 500 }]
];
const MODULOS = [['admin', 'admin&screen=dashboard', 'admin'], ['cozinha', 'cozinha&screen=kanban', 'cozinha'], ['garçom', 'garcom&screen=entregar', 'garcom']];

for (const [modulo, q, role] of MODULOS) {
  for (const [nome, vw] of COMPUTADOR) {
    await step(`${modulo} (${nome})`, async () => {
      const p = await open(`app-cliente.dc.html?module=${q}`, role, vw);
      const m = await medir(p);
      check(`${modulo} (${nome}): menu cabe sem rolar`, m.sobra <= 0 && !m.fora.length, JSON.stringify(m));
      check(`${modulo} (${nome}): nenhum nome cortado`, !m.cortados.length, m.cortados.join(', '));
      check(`${modulo} (${nome}): itens com pelo menos 28 px`, m.menor >= 28, String(m.menor));
      if (vw.height >= 700) check(`${modulo} (${nome}): itens com 44 px quando há altura`, m.menor >= 43, String(m.menor));
      check(`${modulo} (${nome}): sem erro de JavaScript`, !p.jsErrors.length, p.jsErrors.join(' | '));
      if (process.env.SHOTS && modulo === 'admin') await p.screenshot({ path: `${process.env.SHOTS}/menu-${nome.replace(/ /g, '-')}.png` });
      await p.context().close();
    });
  }
}

for (const [nome, vw] of [['celular', { width: 360, height: 640 }], ['tablet', { width: 768, height: 1000 }]]) {
  await step(`menu aberto (${nome})`, async () => {
    const p = await open('app-cliente.dc.html?module=admin&screen=dashboard', 'admin', vw);
    await p.locator('.adm-menubtn').click(); await p.waitForTimeout(400);
    const m = await medir(p);
    check(`menu aberto (${nome}): nenhum nome cortado`, !m.cortados.length, m.cortados.join(', '));
    check(`menu aberto (${nome}): sem rolagem lateral`, await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/menu-aberto-${nome}.png` });
    await p.context().close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
