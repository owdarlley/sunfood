// Design system na tela de verdade: o app usa zoom de 83%, então o tamanho
// final de cada texto, título e campo é medido já com o zoom. Confere cliente,
// cozinha, garçom e admin no celular, tablet, computador e tela larga.
// Uso: node fluxo/medidas.mjs (de dentro de tests)
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


// Tamanho final na tela (com o zoom de 83% do app): nenhum texto abaixo de
// 12 px, títulos (H1) e campos dentro do design system.
const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
const H1 = { celular: [24, 28], tablet: [24, 32], computador: [32, 40], 'tela larga': [32, 40] };
const CAMPO = { celular: 48, tablet: 44, computador: 40, 'tela larga': 40 };
const PAGINAS = [
  ['cliente', 'module=cliente&screen=menu'], ['cliente', 'module=cliente&screen=cart'], ['cliente', 'module=cliente&screen=history'], ['cliente', 'module=cliente&screen=profile'],
  ['cozinha', 'module=cozinha&screen=kanban'], ['garcom', 'module=garcom&screen=entregar'], ['garcom', 'module=garcom&screen=novoPedido'], ['garcom', 'module=garcom&screen=desempenho'],
  ['admin', 'module=admin&screen=dashboard'], ['admin', 'module=admin&screen=orders'], ['admin', 'module=admin&screen=payments'], ['admin', 'module=admin&screen=messages'],
  ['admin', 'module=admin&screen=productForm'], ['admin', 'module=admin&screen=reports'], ['admin', 'module=admin&screen=perfOps'], ['admin', 'module=admin&screen=tables'], ['admin', 'module=admin&screen=waiters']
];
const pedido = (n, st) => ({ id: 'ped-' + n, number: n, tableNumber: 3, customerName: 'Ana Teste', status: st, subtotal: 25, total: 25, note: 'sem gelo',
  paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  items: [{ productId: 'p1', name: 'Batata Frita', qty: 1, unitPrice: 25, note: '' }] });

async function open(vp, role, path) {
  const mobile = vp.width < 768;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role);
  api.db.orders.push(pedido(1, 'Na Fila'), pedido(2, 'Em Preparo'), pedido(3, 'Pronto'), pedido(4, 'Entregue'));
  await ctx.route('http://localhost:8787/**', api);
  await ctx.addInitScript(r => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  await page.goto(BASE + 'app-cliente.dc.html?' + path);
  await page.waitForTimeout(1500);
  return page;
}

// Mede no navegador: tamanho efetivo = font-size x zoom de todos os pais.
const medir = () => {
  const zoomOf = el => { let z = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1; return z; };
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const small = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || !Array.from(e.childNodes).some(c => c.nodeType === 3 && c.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize) * zoomOf(e);
    if (fs < 11.95) small.push(fs.toFixed(1) + ' "' + e.textContent.trim().slice(0, 30) + '"');
  }
  const h1 = Array.from(document.querySelectorAll('h1')).filter(vis).map(e => +(parseFloat(getComputedStyle(e).fontSize) * zoomOf(e)).toFixed(1));
  const campos = Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]),select')).filter(vis)
    // Campo dentro de uma caixa com borda (busca, mesa): mede a caixa.
    .map(e => +(e.closest('.sf-search,.mesafield') || e).getBoundingClientRect().height.toFixed(1));
  return { small, h1, campos };
};

for (const [nome, vp] of TELAS) {
  for (const [role, path] of PAGINAS) {
    const tela = path.split('screen=')[1];
    try {
      const p = await open(vp, role, path);
      const m = await p.evaluate(medir);
      check(`${nome} ${role}/${tela}: nenhum texto abaixo de 12 px`, m.small.length === 0, m.small.length + ' textos, ex.: ' + m.small.slice(0, 4).join(' | '));
      const [a, b] = H1[nome];
      check(`${nome} ${role}/${tela}: título entre ${a} e ${b} px`, m.h1.length === 0 || m.h1.every(h => h >= a - 0.5 && h <= b + 0.5), m.h1.join(', '));
      check(`${nome} ${role}/${tela}: campos com pelo menos ${CAMPO[nome]} px`, m.campos.every(h => h >= CAMPO[nome] - 0.5), m.campos.join(', '));
      check(`${nome} ${role}/${tela}: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
      await p.context().close();
    } catch (e) { check(`${nome} ${role}/${tela}: rodou até o fim`, false, e.message.split('\n')[0]); }
  }
}

await browser.close();
server.close();
const falhas = results.filter(ok => !ok).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
