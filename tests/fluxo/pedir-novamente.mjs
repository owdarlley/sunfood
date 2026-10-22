// "Pedir novamente" no detalhe do pedido: põe no carrinho os itens do pedido
// (quantidade e observação), abre o carrinho e avisa o item que acabou
// (celular, tablet, computador e tela larga).
// Uso: node fluxo/pedir-novamente.mjs (de dentro de tests)
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

const pedido = { id: 'a1b2c3d4-0000-4000-8000-000000000009', number: 9, tableNumber: 3, customerName: 'Teste', status: 'Entregue', subtotal: 80, total: 80, note: '',
  paymentMethod: 'entrega', paymentStatus: 'paid', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  items: [
    { productId: 'p1', name: 'Batata Frita', qty: 2, unitPrice: 25, note: 'sem sal' },
    { productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' },
    { productId: 'p5', name: 'Açaí', qty: 1, unitPrice: 18, note: '' },
  ] };

const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
for (const [nome, vp] of TELAS) {
  try {
    const mobile = vp.width < 700;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/accounts\.google|supabase/, r => r.abort());
    const api = fakeApi('cliente');
    api.db.orders.push(pedido);
    await ctx.route('http://localhost:8787/**', api);
    await ctx.addInitScript(() => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: 'cliente@teste', name: 'Teste', role: 'cliente' } })));
    const p = await ctx.newPage();
    const erros = [];
    p.on('pageerror', e => erros.push(e.message));
    await p.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=history');
    await p.waitForTimeout(1500);
    await p.getByText('#009').first().click();
    await p.waitForTimeout(400);
    await p.getByText('Pedir novamente', { exact: true }).click();
    await p.waitForTimeout(600);
    const t = await p.locator('body').innerText();
    const url = p.url();
    check(`${nome}: abre o carrinho`, /screen=cart(&|$)/.test(url), url);
    check(`${nome}: carrinho com Batata Frita e Água de Coco`, t.includes('Batata Frita') && t.includes('Água de Coco'), t.slice(0, 300));
    check(`${nome}: quantidade e observação do pedido`, /sem sal/.test(t) && /R\$\s?62,00/.test(t), t.slice(0, 300));
    check(`${nome}: avisa que o Açaí acabou e não põe no carrinho`, /Fora do cardápio agora: Açaí/.test(t), t.slice(0, 300));
    check(`${nome}: sem erro de JavaScript`, erros.length === 0, erros.join(' | '));
    await ctx.close();
  } catch (e) { check(`${nome}: rodou até o fim`, false, e.message.split('\n')[0]); }
}

await browser.close();
server.close();
const falhas = results.filter(r => !r).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
