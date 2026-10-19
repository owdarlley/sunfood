// Escala do app conforme a tela: no computador (mouse e janela com mais de
// 1024 px) tudo encolhe junto com a janela, de 100% (1760 x 990 ou maior) até
// 85% (notebook de 1366 x 768 ou menor). Celular, tablet e tela de toque
// ficam em 100%. O tamanho final na tela segue o design system: botões e
// campos de 44 px no computador (48 no celular e tablet), texto 16 px, H1 32
// px, legenda 12 px, nada de texto abaixo de 12 px e sem rolagem para os
// lados. Cliente, cozinha e admin.
// Uso: node fluxo/escala.mjs (de dentro de tests)
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
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function open(vw, role, screen, touch) {
  const ctx = await browser.newContext({ viewport: vw, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role); api.seed();
  await page.route('http://localhost:8787/**', api);
  await page.addInitScript(r => { try { sessionStorage.setItem('sunfood_abertura', '1'); } catch (e) {}
    localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); }, role);
  await page.goto(BASE + `app-cliente.dc.html?module=${role}&screen=${screen}`);
  await page.waitForTimeout(1500);
  return page;
}
// Fator de zoom, tamanho final dos tokens, menor texto visível e rolagem lateral.
const medir = page => page.evaluate(() => {
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sfz')) || 1;
  const px = k => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;height:var(' + k + ')'; document.body.appendChild(d); const v = Math.round(d.getBoundingClientRect().height); d.remove(); return v; };
  let menor = 99, qual = '';
  for (const el of document.querySelectorAll('#dc-root *')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
    const f = parseFloat(getComputedStyle(el).fontSize) * z;
    if (f < menor) { menor = Math.round(f * 10) / 10; qual = el.textContent.trim().slice(0, 20); }
  }
  const btn = [...document.querySelectorAll('.btn,.inp')].filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().height));
  return { z, ctl: px('--ctl'), body: px('--fs-body'), h1: px('--fs-h1'), cap: px('--fs-cap'), menor, qual, btnMin: btn.length ? Math.min(...btn) : null,
    lado: document.documentElement.scrollWidth * z - innerWidth };
});

const TELAS = [
  ['celular', { width: 390, height: 844 }, true, 1, 48],
  ['tablet', { width: 820, height: 1180 }, true, 1, 48],
  ['tablet deitado', { width: 1366, height: 1024 }, true, 1, 44],
  ['notebook', { width: 1280, height: 720 }, false, .85, 44],
  ['computador', { width: 1366, height: 768 }, false, .85, 44],
  ['notebook 125%', { width: 1536, height: 864 }, false, .873, 44],
  ['tela larga', { width: 1920, height: 1080 }, false, 1, 44]
];
for (const [role, screen] of [['cliente', 'menu'], ['admin', 'dashboard'], ['admin', 'orders'], ['cozinha', 'kanban']]) {
  for (const [nome, vw, touch, zEsperado, ctl] of TELAS) {
    await step(`${role} ${nome}`, async () => {
      const page = await open(vw, role, screen, touch);
      const m = await medir(page);
      check(`${role} ${screen} ${nome}: escala ${zEsperado}`, Math.abs(m.z - zEsperado) < .005, JSON.stringify(m));
      check(`${role} ${screen} ${nome}: controles de ${ctl} px (menores com 44), texto ${vw.width > 1024 ? '16, H1 32' : 15}, legenda 12`, m.ctl === ctl && m.cap === 12 && m.body === (vw.width > 1024 ? 16 : 15) && (m.btnMin === null || m.btnMin >= 43) && (vw.width <= 1024 || m.h1 === 32), JSON.stringify(m));
      check(`${role} ${screen} ${nome}: nenhum texto abaixo de 12 px e sem rolagem lateral`, m.menor >= 11.95 && m.lado <= 1, JSON.stringify(m));
      check(`${role} ${screen} ${nome}: sem erro de JavaScript`, page.jsErrors.length === 0, page.jsErrors.join(' | '));
      await page.context().close();
    });
  }
}
// Redimensionar a janela no computador muda a escala na hora.
await step('redimensionar', async () => {
  const page = await open({ width: 1920, height: 1080 }, 'cliente', 'menu', false);
  await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(300);
  const z = (await medir(page)).z;
  check('janela diminuída: escala acompanha (1 -> 0,85)', Math.abs(z - .85) < .005, String(z));
  await page.context().close();
});

await browser.close(); server.close();
const ok = results.filter(r => r.ok).length;
console.log(`\n${ok} de ${results.length} checagens passaram.`);
process.exit(ok === results.length ? 0 : 1);
