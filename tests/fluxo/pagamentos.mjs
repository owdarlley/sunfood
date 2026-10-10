// Teste de fluxo das telas do Sunfood num navegador de verdade (Chromium),
// com uma API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/pagamentos.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, FAKE_CHECKOUT_URL } from './fake-api.mjs';

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

async function open(path, { role, seed, session, paymentsConfigured = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente', { paymentsConfigured });
  if (seed) api.seed();
  await page.route('http://localhost:8787/**', api);
  await page.route(FAKE_CHECKOUT_URL, r => r.fulfill({ contentType: 'text/html', body: '<h1>Checkout Mercado Pago (teste)</h1>' }));
  page.api = api;
  if ((role && role !== 'cliente') || session) await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split("\n")[0]); } }

async function ateOPagamento(page) {
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Ir para pagamento');
  await page.getByPlaceholder('00').fill('1');
  await click(page, 'Confirmar mesa');
}

await step('pagar na entrega', async () => {
  const page = await open('app-cliente.dc.html');
  await ateOPagamento(page);
  let t = await text(page);
  check('opções: PIX, cartão e na entrega (sem Apple/Google Pay)', t.includes('PIX') && t.includes('Cartão de crédito') && t.includes('Pagar na entrega') && !t.includes('Apple'));
  await click(page, 'Pagar na entrega', true);
  await click(page, 'Fazer pedido');
  const o = page.api.db.orders[0];
  check('entrega: pedido enviado com paymentMethod=entrega', o && o.paymentMethod === 'entrega', JSON.stringify(o?.paymentMethod));
  t = await text(page);
  check('entrega: confirmação diz para pagar ao garçom', t.includes('Pague ao garçom') && t.includes('A pagar na entrega'));
  await click(page, 'Acompanhar pedido');
  await click(page, 'Cancelar pedido');
  t = await text(page);
  check('entrega: cancelar não promete estorno', t.includes('Nada a estornar'));
  check('entrega: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('cartão', async () => {
  const page = await open('app-cliente.dc.html');
  await ateOPagamento(page);
  await click(page, 'Cartão de crédito', true);
  await click(page, 'Pagar R$');
  const o = page.api.db.orders[0];
  check('cartão: pedido enviado com paymentMethod=cartao', o && o.paymentMethod === 'cartao');
  check('cartão: pede checkout com volta pro próprio app', /app-cliente\.dc\.html\?module=cliente&screen=card$/.test(page.api.db.cardReturnUrl || ''), page.api.db.cardReturnUrl);
  check('cartão: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.waitForURL(FAKE_CHECKOUT_URL, { timeout: 5000 }).catch(() => {});
  check('cartão: leva pro checkout do Mercado Pago (cartão digitado lá, não no app)', page.url() === FAKE_CHECKOUT_URL, page.url());
  await page.close();
});

await step('volta do Mercado Pago', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=approved', { role: 'cliente', seed: true, session: true });
  await page.waitForTimeout(1500);
  check('volta aprovada: vai para a confirmação', (await text(page)).toLowerCase().includes('pedido confirmado'), (await text(page)).slice(0, 200));
  check('volta: limpa os parâmetros da URL', !page.url().includes('pedido='));
  await page.close();
  const p2 = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=null', { role: 'cliente', seed: true, session: true });
  p2.api.db.orders[0].paymentStatus = 'pending';
  await p2.waitForTimeout(800);
  check('volta sem pagar: mostra pagamento não concluído', (await text(p2)).includes('não foi concluído'));
  check('volta: sem erro de JavaScript', p2.jsErrors.length === 0 && !(await renderError(p2)), p2.jsErrors.join(' | ') || await renderError(p2));
  await p2.close();
});

await step('cozinha vê se está pago', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  const now = new Date().toISOString();
  const item = [{ productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' }];
  page.api.db.orders.push(
    { id: 'o10', tableNumber: 1, status: 'Na Fila', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o11', tableNumber: 1, status: 'Na Fila', total: 99.99, note: 'NAOPAGO', paymentMethod: 'pix', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item });
  await page.waitForTimeout(3800);
  const t = await text(page);
  check('cozinha: selo "Pago no app (PIX)"', t.includes('Pago no app (PIX)'));
  check('cozinha: selo "Cobrar na entrega"', t.includes('Cobrar na entrega · R$ 13,20'));
  check('cozinha: PIX não pago não aparece', !t.includes('NAOPAGO'));
  check('cozinha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('sem Mercado Pago', async () => {
  const page = await open('app-cliente.dc.html', { paymentsConfigured: false });
  await ateOPagamento(page);
  let t = await text(page);
  check('sem MP: mostra PIX, cartão e na entrega', t.includes('Pagar na entrega') && t.includes('Cartão de crédito') && t.includes('Pague agora pelo app do banco'), t.slice(0, 300));
  await click(page, 'Cartão de crédito', true);
  await click(page, 'Pagar R$');
  await page.waitForTimeout(3500);
  const o = page.api.db.orders[0];
  check('sem MP: cartão aprovado na hora como provisório', o && o.paymentMethod === 'cartao' && o.paymentStatus === 'approved' && o.paymentProvider === 'provisorio', JSON.stringify(o));
  t = await text(page);
  check('sem MP: cliente vai direto para a confirmação', t.toLowerCase().includes('pedido confirmado'), t.slice(0, 200));
  await click(page, 'Acompanhar pedido');
  await click(page, 'Cancelar pedido');
  check('sem MP: cancelar cartão provisório não promete estorno', (await text(page)).includes('Nada a estornar'));
  check('sem MP: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('PIX sem Mercado Pago', async () => {
  const page = await open('app-cliente.dc.html', { paymentsConfigured: false });
  await ateOPagamento(page);
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$');
  await page.waitForTimeout(3500);
  const o = page.api.db.orders[0];
  check('sem MP: PIX aprovado na hora como provisório', o && o.paymentMethod === 'pix' && o.paymentStatus === 'approved' && o.paymentProvider === 'provisorio', JSON.stringify(o));
  const t = await text(page);
  check('sem MP: PIX vai direto para a confirmação', t.toLowerCase().includes('pedido confirmado'), t.slice(0, 200));
  check('sem MP (PIX): sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('tela de Pagamentos do admin', async () => {
  const admin = await open('app-cliente.dc.html?module=admin&screen=payments', { role: 'admin', paymentsConfigured: false });
  const now = new Date().toISOString();
  const item = [{ productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' }];
  admin.api.db.orders.push(
    { id: 'o20', tableNumber: 3, status: 'Entregue', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o21', tableNumber: 4, status: 'Cancelado', total: 50, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o23', tableNumber: 5, status: 'Na Fila', total: 22, note: '', paymentMethod: 'cartao', paymentStatus: 'approved', paymentProvider: 'provisorio', createdAt: now, updatedAt: now, items: item });
  await admin.reload(); await admin.waitForTimeout(1500);
  let t = await text(admin);
  check('admin: menu tem "Pagamentos"', t.includes('Pagamentos'));
  check('admin: avisa que o Mercado Pago não está configurado', t.includes('Mercado Pago ainda não configurado'));
  check('admin: cartão provisório aparece separado', t.includes('Cartão provisório (sem cobrança) · R$ 22,00') && /Provisório hoje \(PIX\/cartão\)\s*R\$ 22,00/.test(t));
  check('admin: lista todos os pedidos, inclusive cancelado', t.includes('#o20') && t.includes('#o21'));
  check('admin: "A receber na entrega" soma R$ 13,20', /A receber na entrega\s*R\$ 13,20/.test(t), t.slice(0, 400));
  check('admin: cancelado não tem botão de receber', (await admin.getByText('Dinheiro', { exact: true }).count()) === 1);
  await click(admin, 'Dinheiro', true);
  await admin.waitForTimeout(500);
  t = await text(admin);
  const o = admin.api.db.orders.find(o => o.id === 'o20');
  check('admin: marca recebido em dinheiro', o.paymentStatus === 'approved' && o.receivedWith === 'dinheiro');
  check('admin: mostra "Recebido na entrega (dinheiro)"', t.includes('Recebido na entrega (dinheiro)'));
  check('admin: "Recebido hoje" passa a R$ 13,20', /Recebido hoje\s*R\$ 13,20/.test(t));
  await click(admin, 'Desfazer', true);
  await admin.waitForTimeout(500);
  check('admin: desfazer volta para "a receber"', o.paymentStatus === 'pending' && !o.receivedWith && (await text(admin)).includes('Cobrar na entrega'));
  check('admin: sem erro de JavaScript', admin.jsErrors.length === 0 && !(await renderError(admin)), admin.jsErrors.join(' | ') || await renderError(admin));
  await admin.close();

  const kitchen = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha' });
  kitchen.api.db.orders.push({ id: 'o22', tableNumber: 1, status: 'Na Fila', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'approved', receivedWith: 'cartao', createdAt: now, updatedAt: now, items: item });
  await kitchen.waitForTimeout(3800);
  check('cozinha: selo "Recebido na entrega (cartão)"', (await text(kitchen)).includes('Recebido na entrega (cartão)'));
  await kitchen.close();
});

await step('prazo de cancelamento', async () => {
  const admin = await open('app-cliente.dc.html?module=admin&screen=pause', { role: 'admin' });
  let t = await text(admin);
  check('admin: mostra o prazo atual (sem prazo)', t.includes('Prazo para o cliente cancelar') && t.includes('sem prazo'));
  await admin.getByPlaceholder('Minutos (ex: 5)').fill('5');
  await click(admin, 'Salvar', true);
  t = await text(admin);
  check('admin: salva 5 minutos', admin.api.db.kiosk.cancelWindowMinutes === 5 && t.includes('5 min depois do pedido'), String(admin.api.db.kiosk.cancelWindowMinutes));
  await admin.getByPlaceholder('Minutos (ex: 5)').fill('abc');
  await click(admin, 'Salvar', true);
  check('admin: recusa valor inválido', (await text(admin)).includes('número inteiro de minutos'));
  check('admin: sem erro de JavaScript', admin.jsErrors.length === 0 && !(await renderError(admin)), admin.jsErrors.join(' | '));
  await admin.close();

  for (const [nome, offsetMin, deveCancelar] of [['dentro do prazo', 4, true], ['prazo vencido', -1, false]]) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=approved', { role: 'cliente', seed: true, session: true });
    page.api.db.orders[0].cancelDeadline = new Date(Date.now() + offsetMin * 60000).toISOString();
    await page.waitForTimeout(3500);
    await click(page, 'Acompanhar pedido');
    t = await text(page);
    check(`cliente ${nome}: botão Cancelar ${deveCancelar ? 'aparece' : 'some'}`, t.includes('Cancelar pedido') === deveCancelar);
    check(`cliente ${nome}: aviso "até HH:MM" ${deveCancelar ? 'aparece' : 'some'}`, /Você pode cancelar até \d\d:\d\d/.test(t) === deveCancelar);
    await page.close();
  }
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
