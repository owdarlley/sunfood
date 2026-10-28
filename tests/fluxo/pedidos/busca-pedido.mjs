// Busca de pedidos do admin pelo número da tela (#005, 005), data na lista
// para pedidos de outro dia, e os contadores de atrasados e entregues iguais
// na cozinha e no painel (celular, tablet, computador e tela larga).
// Uso: node fluxo/pedidos/busca-pedido.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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


// Pedidos de hoje (#005 na mesa 2, #012 na mesa 5) e um de 3 dias atrás (#001) que ficou aberto.
const agora = new Date();
const velho = new Date(Date.now() - 3 * 86400000);
const ddmm = d => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
const pedido = (id, number, table, extra) => ({ id, number, tableNumber: table, customerName: 'Ana Teste', status: 'Na Fila', subtotal: 5, total: 5, note: '',
  paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: agora.toISOString(), updatedAt: agora.toISOString(),
  items: [{ productId: 'p1', name: 'Água Mineral', qty: 1, unitPrice: 5, note: '' }], ...extra });
const PEDIDOS = () => [
  pedido('11111111-aaaa-4aaa-8aaa-000000000005', 5, 2),
  pedido('11111111-aaaa-4aaa-8aaa-000000000012', 12, 5, { status: 'Entregue' }),
  pedido('11111111-aaaa-4aaa-8aaa-000000000001', 1, 1, { status: 'Em Preparo', createdAt: velho.toISOString(), updatedAt: velho.toISOString() }),
  // Cancelado sem pagar: nada a cobrar. Cartão com estorno parcial da água: a cozinha vê o que foi devolvido.
  pedido('11111111-aaaa-4aaa-8aaa-000000000006', 6, 4, { status: 'Cancelado' }),
  pedido('11111111-aaaa-4aaa-8aaa-000000000007', 7, 6, { paymentMethod: 'cartao', paymentStatus: 'approved', paymentProvider: 'stripe', refundedAmount: 5,
    refunds: [{ amount: 5, reason: 'Item em falta', items: [{ name: 'Água Mineral', qty: 1 }], at: agora.toISOString() }] }),
  // PIX não pago: a cozinha não vê, então não conta como atrasado em lugar nenhum.
  pedido('11111111-aaaa-4aaa-8aaa-000000000009', 9, 3, { paymentMethod: 'pix', createdAt: velho.toISOString(), updatedAt: velho.toISOString() })
];

async function open(vp, role, path) {
  const mobile = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role);
  api.db.orders.push(...PEDIDOS());
  await ctx.route('http://localhost:8787/**', api);
  await ctx.addInitScript(r => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  await page.goto(BASE + 'app-cliente.dc.html?' + path);
  await page.waitForTimeout(1500);
  return page;
}
const text = p => p.locator('body').innerText();
const buscar = async (p, q) => { const i = p.locator('input[aria-label^="Buscar por mesa"]').first(); await i.fill(q); await p.waitForTimeout(300); return text(p); };
const lista = t => (t.match(/#0\d\d/g) || []).filter((v, i, a) => a.indexOf(v) === i);

const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
for (const [nome, vp] of TELAS) {
  try {
    let p = await open(vp, 'admin', 'module=admin&screen=orders');
    let t = await buscar(p, '005');
    check(`${nome}: admin acha "005" pelo número da tela`, lista(t).join() === '#005', lista(t).join());
    t = await buscar(p, '#012');
    check(`${nome}: admin acha "#012"`, lista(t).join() === '#012', lista(t).join());
    t = await buscar(p, '1');
    check(`${nome}: "1" acha a mesa 1 e o pedido #001`, lista(t).join() === '#001', lista(t).join());
    t = await buscar(p, '006');
    check(`${nome}: pedido cancelado sem pagar não pede para cobrar`, t.includes('Na entrega · nada a cobrar') && !t.includes('Cobrar na entrega'), t.slice(0, 400));
    t = await buscar(p, '');
    check(`${nome}: pedido de outro dia mostra a data na lista`, t.includes(ddmm(velho)), t.slice(0, 300));
    await p.goto(BASE + 'app-cliente.dc.html?module=admin&screen=dashboard'); await p.waitForTimeout(1200);
    t = await text(p);
    check(`${nome}: painel conta 1 atrasado (o PIX não pago fica de fora)`, /Pedidos atrasados\s*1\b/.test(t), (t.match(/Pedidos atrasados[^\n]*\n?[^\n]*/) || [''])[0]);
    await p.goto(BASE + 'app-cliente.dc.html?module=admin&screen=performance'); await p.waitForTimeout(1200);
    check(`${nome}: endereço com tela que não existe abre o painel, não o login`, (await text(p)).includes('Faturamento hoje'), p.url());
    check(`${nome}: admin sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();

    p = await open(vp, 'cozinha', 'module=cozinha&screen=kanban');
    // Celular: uma coluna por vez; o pedido antigo está em "Em preparo".
    if (vp.width < 700) { await p.locator('.kz-tab').nth(1).click(); await p.waitForTimeout(300); }
    t = await text(p);
    check(`${nome}: cozinha mostra a data do pedido antigo, não milhares de minutos`, t.includes('desde ' + ddmm(velho)) && !/\d{4} min/.test(t), t.slice(0, 300));
    check(`${nome}: cozinha conta 1 atrasado, igual ao painel`, /Atrasados\s*1\b/.test(t), (t.match(/Atrasados[^\n]*/) || [''])[0]);
    check(`${nome}: "Entregues hoje" conta só os de hoje`, /Entregues hoje\s*1\b/.test(t), (t.match(/Entregues hoje[^\n]*/) || [''])[0]);
    if (vp.width < 700) { await p.locator('.kz-tab').nth(0).click(); await p.waitForTimeout(300); }
    t = await text(p);
    check(`${nome}: cozinha avisa o item devolvido no estorno parcial`, t.includes('Devolvido ao cliente, não preparar: 1x Água Mineral'), t.slice(0, 400));
    await p.locator('input[aria-label="Buscar pedido por mesa ou número"]').fill('5');
    await p.waitForTimeout(300);
    t = await text(p);
    check(`${nome}: cozinha busca pelo número do pedido`, t.includes('#005') && !t.includes('#007'), t.slice(0, 300));
    check(`${nome}: cozinha sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  } catch (e) { check(`${nome}: rodou até o fim`, false, e.message.split('\n')[0]); }
}

await browser.close();
server.close();
const falhas = results.filter(ok => !ok).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
