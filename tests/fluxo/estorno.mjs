// Estorno e cancelamento pelo painel do admin num navegador de verdade
// (Chromium): estorno parcial escolhendo itens (o pedido continua), cancelar
// e estornar tudo, cancelar "pagar na entrega" sem estorno e motivo
// obrigatório, no celular, tablet, computador e tela larga.
// API falsa em memória: nada sai da máquina, nada vai pro banco nem pro Stripe.
// Uso: node tests/fluxo/estorno.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, viewport, session } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) seed(api.db);
  if (kiosk) Object.assign(api.db.kiosk, kiosk);
  api.db.calls = [];
  // Rotas de conta que a API falsa comum não tem.
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    return api(route);
  });
  page.api = api;
  if (role && (role !== 'cliente' || session)) await page.addInitScript(r => localStorage.setItem('sunfood_session',
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
  await page.getByLabel('E-mail', { exact: true }).first().fill('ana@email.com');
  await page.getByLabel('Senha', { exact: true }).fill('senha');
  await click(page, 'Entrar', true);
}




const at = () => new Date().toISOString();
const item = (name, qty, unitPrice) => ({ productId: 'p1', name, qty, unitPrice, note: '' });
// Três pedidos: cartão pago em preparo, PIX pago já entregue e um "pagar na entrega" na fila.
const pedidos = db => db.orders.push(
  { id: 'o1', number: 1, tableNumber: 3, customerName: 'Ana', status: 'Em Preparo', subtotal: 50, total: 50, note: '', paymentMethod: 'cartao',
    paymentStatus: 'approved', paymentProvider: 'stripe', refundedAmount: 0, createdAt: at(), updatedAt: at(),
    items: [item('Peixe Frito', 1, 38), item('Suco de Laranja', 1, 12)] },
  { id: 'o2', number: 2, tableNumber: 4, customerName: 'Bruno', status: 'Entregue', subtotal: 30, total: 30, note: '', paymentMethod: 'pix',
    paymentStatus: 'approved', paymentProvider: 'stripe', refundedAmount: 0, createdAt: at(), updatedAt: at(), items: [item('Açaí', 2, 15)] },
  { id: 'o3', number: 3, tableNumber: 5, customerName: 'Carla', status: 'Na Fila', subtotal: 20, total: 20, note: '', paymentMethod: 'entrega',
    paymentStatus: 'pending', refundedAmount: 0, createdAt: at(), updatedAt: at(), items: [item('Batata Frita', 1, 20)] });
const dialog = page => page.locator('.rf-dialog');
const row = (page, code) => page.locator('.tbl .tr').filter({ hasText: code }).first();

await step('estorno parcial e cancelamento pelo painel', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=orders', { role: 'admin', seed: pedidos });
  let t = await text(page);
  check('pedidos: botão Estornar no pago e Cancelar pedido no "na entrega"',
    await row(page, '#001').getByText('Estornar', { exact: true }).count() === 1 && await row(page, '#003').getByText('Cancelar pedido', { exact: true }).count() === 1, t.slice(0, 400));

  // Parcial: escolhe o suco, o valor é preenchido e o pedido continua.
  await row(page, '#001').getByText('Estornar', { exact: true }).click(); await page.waitForTimeout(400);
  t = await dialog(page).innerText();
  check('janela mostra pago, já estornado e o que dá para estornar', t.includes('Pago no app') && t.includes('R$ 50,00') && t.includes('Ainda dá para estornar'));
  check('pedido em preparo abre em "Cancelar e estornar tudo"', t.includes('Cancelar e estornar R$ 50,00') && t.includes('O pedido sai da cozinha'));
  await dialog(page).getByText('Estornar uma parte', { exact: true }).click(); await page.waitForTimeout(300);
  await dialog(page).getByText('1x Suco de Laranja').click(); await page.waitForTimeout(300);
  check('escolher o item preenche o valor', await page.getByLabel('Valor do estorno em reais').inputValue() === '12,00');
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(400);
  check('sem motivo, não estorna e pede o motivo', (await dialog(page).innerText()).includes('Escolha ou escreva o motivo') && !page.api.db.refundCalls);
  await dialog(page).getByText('Item em falta', { exact: true }).click(); await page.waitForTimeout(200);
  check('botão diz o valor do estorno', (await dialog(page).locator('.btn-danger').innerText()).includes('Estornar R$ 12,00'));

  for (const [nome, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const btn = await dialog(page).locator('.btn-danger').boundingBox();
    const inp = await page.getByLabel('Valor do estorno em reais').boundingBox();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`janela ${nome}: cabe na tela, botões e campo com altura de toque`, btn && btn.x >= 0 && btn.x + btn.width <= viewport.width && btn.y + btn.height <= viewport.height
      && btn.height >= 40 && inp.height >= 40 && scroll <= 0, JSON.stringify({ btn, inp, scroll }));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/estorno-${nome}.png` });
  }
  await page.setViewportSize({ width: 400, height: 860 }); await page.waitForTimeout(200);
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(800);
  const c1 = page.api.db.refundCalls?.[0];
  check('parcial: chama o servidor com valor e motivo, sem cancelar', c1 && c1.id === 'o1' && c1.amount === 12 && c1.reason === 'Item em falta' && !c1.cancel, JSON.stringify(c1));
  check('parcial: manda os itens marcados', JSON.stringify(c1?.items) === JSON.stringify([{ name: 'Suco de Laranja', qty: 1 }]), JSON.stringify(c1?.items));
  t = await text(page);
  check('parcial: avisa o estorno e o pedido continua em preparo', t.includes('Estorno de R$ 12,00 feito.') && (await row(page, '#001').innerText()).includes('Em Preparo')
    && (await row(page, '#001').innerText()).includes('estornado R$ 12,00'));

  // Valor maior do que falta: recusado na tela.
  await row(page, '#001').getByText('Estornar', { exact: true }).click(); await page.waitForTimeout(400);
  check('janela mostra o estorno já feito, com o item', (await dialog(page).innerText()).includes('Estornos já feitos') && (await dialog(page).innerText()).includes('Item em falta')
    && (await dialog(page).innerText()).includes('1x Suco de Laranja ·'));
  await dialog(page).getByText('Estornar uma parte', { exact: true }).click(); await page.waitForTimeout(200);
  await page.getByLabel('Valor do estorno em reais').fill('45'); await page.waitForTimeout(100);
  await dialog(page).getByText('Pedido errado', { exact: true }).click(); await page.waitForTimeout(100);
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(300);
  check('valor maior do que falta é recusado na tela', (await dialog(page).innerText()).includes('entre R$ 0,01 e R$ 38,00') && page.api.db.refundCalls.length === 1);

  // Cancelar e estornar o resto.
  await dialog(page).getByText('Cancelar e estornar tudo', { exact: true }).click(); await page.waitForTimeout(200);
  check('cancelar mostra o que falta devolver', (await dialog(page).locator('.btn-danger').innerText()).includes('Cancelar e estornar R$ 38,00'));
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(800);
  const c2 = page.api.db.refundCalls[1];
  check('cancelar: chama o servidor com cancel e motivo', c2 && c2.cancel === true && c2.reason === 'Pedido errado', JSON.stringify(c2));
  t = await text(page);
  check('cancelar: pedido sai da cozinha e o botão some', t.includes('Estorno de R$ 38,00 feito. O pedido saiu da cozinha.') && (await row(page, '#001').innerText()).includes('Cancelado')
    && await row(page, '#001').getByText('Estornar', { exact: true }).count() === 0);

  // "Pagar na entrega": só cancela, sem estorno.
  await row(page, '#003').getByText('Cancelar pedido', { exact: true }).click(); await page.waitForTimeout(400);
  t = await dialog(page).innerText();
  check('na entrega: avisa que não há estorno e devolve ao estoque', t.includes('não há nada a estornar') && t.includes('voltam para o estoque') && !t.includes('Estornar uma parte'));
  await page.getByLabel('Motivo').fill('Cliente foi embora'); await page.waitForTimeout(100);
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(800);
  check('na entrega: cancela', page.api.db.refundCalls[2]?.cancel === true && (await text(page)).includes('Pedido cancelado.'));
  check('sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await step('pedido entregue e tela de Pagamentos', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=payments', { role: 'admin', seed: pedidos });
  check('pagamentos: botão Estornar na coluna de recebimento e estorno', await row(page, '#002').getByText('Estornar', { exact: true }).count() === 1);
  await row(page, '#002').getByText('Estornar', { exact: true }).click(); await page.waitForTimeout(400);
  const t = await dialog(page).innerText();
  check('entregue: não oferece cancelar, só estornar', !t.includes('Cancelar e estornar') && t.includes('Valor do estorno'));
  await dialog(page).getByText('Tudo (R$ 30,00)').click(); await page.waitForTimeout(100);
  await dialog(page).getByText('Demora no preparo', { exact: true }).click(); await page.waitForTimeout(100);
  await dialog(page).locator('.btn-danger').click(); await page.waitForTimeout(800);
  check('entregue: estorno total sem cancelar', page.api.db.refundCalls[0]?.amount === 30 && !page.api.db.refundCalls[0]?.cancel);
  const kpi = await page.locator('.kpi').filter({ hasText: 'Estornado' }).innerText();
  check('pagamentos: total estornado soma o estorno', kpi.includes('R$ 30,00') && kpi.includes('1 pedido'), kpi);
  check('pagamentos: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// O cliente vê no app o que foi estornado de cada pedido.
const doCliente = db => {
  db.orders.push(
    { id: 'o4', number: 4, tableNumber: 3, status: 'Em Preparo', subtotal: 30, total: 30, note: '', paymentMethod: 'cartao',
      paymentStatus: 'approved', paymentProvider: 'stripe', refundedAmount: 5, createdAt: at(), updatedAt: at(),
      items: [item('Batata Frita', 1, 5), item('Peixe Frito', 1, 25)] },
    { id: 'o5', number: 5, tableNumber: 3, status: 'Entregue', subtotal: 50, total: 50, note: '', paymentMethod: 'pix',
      paymentStatus: 'approved', paymentProvider: 'stripe', refundedAmount: 12, createdAt: at(), updatedAt: at(),
      items: [item('Peixe Frito', 1, 38), item('Suco de Laranja', 1, 12)] },
    // Estornado antes do histórico de estornos existir: aparece com o total.
    { id: 'o6', number: 6, tableNumber: 3, status: 'Cancelado', subtotal: 20, total: 20, note: '', paymentMethod: 'cartao',
      paymentStatus: 'refunded', paymentProvider: 'stripe', refundedAmount: 0, createdAt: at(), updatedAt: at(), items: [item('Açaí', 1, 20)] });
  db.refunds = [
    { orderId: 'o4', amount: 5, reason: 'Item em falta', items: [{ name: 'Batata Frita', qty: 1 }], by: 'Admin Teste', at: at() },
    { orderId: 'o5', amount: 12, reason: 'Pedido errado', items: [{ name: 'Suco de Laranja', qty: 1 }], by: 'Admin Teste', at: at() }];
};
for (const [nome, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
  await step(`cliente vê os estornos (${nome})`, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=status', { role: 'cliente', session: true, seed: doCliente, viewport });
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0);
    let t = await text(page);
    check(`${nome}: acompanhamento mostra o estorno com motivo, item e valor final`, t.includes('Estornos') && t.includes('Item em falta') && t.includes('1x Batata Frita ·')
      && t.includes('− R$ 5,00') && t.includes('Valor final') && t.includes('R$ 25,00') && await noScroll(), t.slice(0, 600));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cliente-estorno-status-${nome}.png`, fullPage: true });
    await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=history'); await page.waitForTimeout(1200);
    t = await text(page);
    check(`${nome}: Meus pedidos marca os pedidos estornados`, t.includes('Estornado R$ 12,00') && t.includes('Estornado R$ 20,00') && t.includes('Estornado R$ 5,00') && await noScroll(), t.slice(0, 600));
    check(`${nome}: cliente não vê quem da equipe estornou`, !t.includes('Admin Teste'));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cliente-estorno-historico-${nome}.png`, fullPage: true });
    await page.locator('.orow').filter({ hasText: '#005' }).first().click(); await page.waitForTimeout(600);
    t = await text(page);
    check(`${nome}: detalhe do pedido mostra o que foi estornado`, t.includes('Pedido errado') && t.includes('1x Suco de Laranja ·') && t.includes('Total estornado')
      && t.includes('R$ 12,00') && t.includes('R$ 38,00') && !t.includes('Admin Teste') && await noScroll(), t.slice(0, 600));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cliente-estorno-detalhe-${nome}.png`, fullPage: true });
    await page.goBack(); await page.waitForTimeout(600);
    await page.locator('.orow').filter({ hasText: '#006' }).first().click(); await page.waitForTimeout(600);
    t = await text(page);
    check(`${nome}: pedido estornado sem histórico mostra o total como cancelado`, t.includes('Pedido cancelado') && t.includes('− R$ 20,00') && t.includes('R$ 0,00'), t.slice(0, 600));
    check(`${nome}: cliente sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
