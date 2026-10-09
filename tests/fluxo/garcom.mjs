// Teste do perfil Garçom num navegador de verdade (Chromium): login leva ao
// módulo do garçom, pedidos prontos com "Marcar como entregue" e recebimento
// na mesa, lançar pedido escolhendo a mesa, "Meu desempenho" e a tela Garçons
// do admin. API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/garcom.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) seed(api);
  if (kiosk) Object.assign(api.db.kiosk, kiosk);
  api.db.calls = [];
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    return api(route);
  });
  page.api = api;
  if (role && role !== 'cliente') await page.addInitScript(r => localStorage.setItem('sunfood_session',
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
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0);
const SIZES = [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1280, height: 860 }], ['tela-larga', { width: 1920, height: 1080 }]];
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const order = (id, table, status, extra = {}) => ({ id, tableNumber: table, status, subtotal: 30, total: 33, note: '', paymentStatus: 'pending',
  paymentMethod: 'entrega', createdAt: ago(12), updatedAt: ago(3), items: [{ productId: 'p3', name: 'Caipirinha', qty: 1, unitPrice: 22, note: '' }, { productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' }], ...extra });
const seedOrders = api => api.db.orders.push(
  order('o21', 4, 'Pronto', { waiterId: 'u1', note: 'sem gelo' }),
  order('o22', 5, 'Pronto', { paymentMethod: 'pix', paymentStatus: 'approved' }),
  order('o23', 1, 'Em Preparo'),
  order('o24', 3, 'Na Fila', { paymentMethod: 'pix', paymentStatus: 'pending' })  // PIX não pago: não aparece
);

// 1. Quem é garçom e já entrou vai direto para "Para entregar"
await step('garçom login', async () => {
  const page = await open('index.html', { role: 'garcom', viewport: { width: 1280, height: 860 } });
  check('login: garçom abre o módulo do garçom', page.url().includes('module=garcom&screen=entregar'), page.url());
  const t = await text(page);
  check('login: menu com Para entregar, Lançar pedido e Meu desempenho', ['Para entregar', 'Lançar pedido', 'Meu desempenho'].every(x => t.includes(x)));
  check('login: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Para entregar: prontos com botão, recebimento na mesa, e o que ainda está na cozinha
await step('garçom para entregar', async () => {
  const page = await open('app-cliente.dc.html?module=garcom&screen=entregar', { role: 'garcom', seed: seedOrders });
  let t = await text(page);
  check('entregar: mostra os 2 prontos', t.includes('Mesa 4') && t.includes('Mesa 5') && /Prontos\s*2/.test(t), (t.match(/Prontos\s*\d+/) || [])[0]);
  check('entregar: observação do pedido', t.includes('Obs: sem gelo'));
  check('entregar: marca o que o garçom lançou', t.includes('Você lançou'));
  check('entregar: mostra o que ainda está na cozinha', t.includes('Ainda na cozinha') && t.includes('Mesa 1') && t.includes('Em preparo'));
  check('entregar: PIX ainda não pago não aparece', !t.includes('Mesa 3'));
  check('entregar: botões de recebimento só no pedido "na entrega"', await page.getByText('Dinheiro', { exact: true }).count() === 1);
  await click(page, 'Dinheiro', true);
  const recv = called(page, '/orders/o21/payment-received')[0];
  check('entregar: anota o recebimento em dinheiro', recv && recv.body.receivedWith === 'dinheiro' && recv.auth === 'Bearer tok', JSON.stringify(recv));
  t = await text(page);
  check('entregar: cartão passa a mostrar "Recebido na entrega (dinheiro)"', t.includes('Recebido na entrega (dinheiro)'));
  await page.getByText('Marcar como entregue').first().click(); await page.waitForTimeout(800);
  const st = called(page, '/orders/o21/status')[0];
  check('entregar: "Marcar como entregue" manda status Entregue', st && st.body.status === 'Entregue', JSON.stringify(st));
  t = await text(page);
  check('entregar: o pedido entregue sai da lista', !t.includes('Mesa 4') && /Prontos\s*1/.test(t), (t.match(/Prontos\s*\d+/) || [])[0]);
  for (const [nome, viewport] of SIZES) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const btn = await page.getByText('Marcar como entregue').first().boundingBox();
    check(`entregar ${nome}: sem rolagem lateral e botão de 48 px`, (await noScroll(page)) && btn && btn.height >= 48, JSON.stringify(btn));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/garcom-entregar-${nome}.png`, fullPage: true });
  }
  check('entregar: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 3. Lançar pedido: mesa, itens, observação e envio
await step('garçom lançar pedido', async () => {
  const page = await open('app-cliente.dc.html?module=garcom&screen=novoPedido', { role: 'garcom' });
  let t = await text(page);
  check('lançar: mostra as mesas e o cardápio', t.includes('Mesa') && t.includes('Caipirinha') && t.includes('Água de Coco'));
  check('lançar: item esgotado aparece indisponível', t.includes('indisponível'));
  await click(page, 'Enviar para a cozinha');
  check('lançar: pede a mesa antes de enviar', (await text(page)).includes('Escolha a mesa do cliente.') && !called(page, '/orders/manual').length);
  await page.getByRole('button', { name: 'Mesa 2 (inativa)' }).click(); await page.waitForTimeout(400);
  check('lançar: mesa inativa não é escolhida', (await text(page)).includes('Mesa 2 está inativa.'));
  await page.getByRole('button', { name: 'Mesa 3', exact: true }).click(); await page.waitForTimeout(300);
  await click(page, 'Enviar para a cozinha');
  check('lançar: pede ao menos um item', (await text(page)).includes('Adicione pelo menos um item.'));
  await page.getByRole('button', { name: 'Adicionar um Caipirinha' }).click();
  await page.getByRole('button', { name: 'Adicionar um Caipirinha' }).click();
  await page.getByRole('button', { name: 'Adicionar um Água de Coco' }).click();
  await page.getByRole('button', { name: 'Tirar um Água de Coco' }).click();
  await page.waitForTimeout(300);
  t = await text(page);
  check('lançar: resumo com a mesa, itens e total com taxa', t.includes('Pedido da mesa 3') && t.includes('2× Caipirinha') && t.includes('R$ 48,40') && !t.includes('× Água de Coco'), (t.match(/Total[^\n]*\n?[^\n]*/) || [])[0]);
  await page.getByPlaceholder('Ex.: sem gelo, guarda-sol azul').fill('guarda-sol azul');
  for (const [nome, viewport] of SIZES) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const tile = await page.getByRole('button', { name: 'Mesa 3', exact: true }).boundingBox();
    const plus = await page.getByRole('button', { name: 'Adicionar um Caipirinha' }).boundingBox();
    const min = viewport.width > 1024 ? 64 : 56;
    check(`lançar ${nome}: sem rolagem lateral, mesa de ${min} px e + com 40 px`, (await noScroll(page)) && tile && tile.height >= min && plus && plus.height >= 40, JSON.stringify({ tile, plus }));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/garcom-lancar-${nome}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await click(page, 'Enviar para a cozinha');
  const sent = page.api.db.manual;
  check('lançar: envia mesa, itens e observação', sent && sent.tableNumber === 3 && JSON.stringify(sent.items) === JSON.stringify([{ productId: 'p3', qty: 2 }]) && sent.note === 'guarda-sol azul', JSON.stringify(sent));
  t = await text(page);
  check('lançar: volta para "Para entregar" com aviso', page.url().includes('garcom') && t.includes('Pedido da mesa 3 enviado para a cozinha.'));
  check('lançar: pedido aparece na cozinha como "Você lançou"', t.includes('Ainda na cozinha') && t.includes('Mesa 3') && t.includes('Você lançou'));
  check('lançar: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 4. Quiosque pausado: avisa e o servidor recusa
await step('garçom quiosque pausado', async () => {
  const page = await open('app-cliente.dc.html?module=garcom&screen=novoPedido', { role: 'garcom', kiosk: { paused: true } });
  check('pausado: avisa no topo', (await text(page)).includes('Quiosque pausado: não dá para lançar pedidos agora.'));
  await page.getByRole('button', { name: 'Mesa 1', exact: true }).click();
  await page.getByRole('button', { name: 'Adicionar um Caipirinha' }).click();
  await click(page, 'Enviar para a cozinha');
  check('pausado: mostra o erro do servidor', (await text(page)).includes('Quiosque pausado no momento'));
  await page.close();
});

// 5. Meu desempenho: números do período e entregas por dia
await step('garçom desempenho', async () => {
  const page = await open('app-cliente.dc.html?module=garcom&screen=desempenho', { role: 'garcom' });
  let t = await text(page);
  check('desempenho: carrega o dia de hoje', page.api.db.lastWaiterPeriod === 'hoje' && t.includes('Pedidos entregues') && t.includes('3,5 min') && t.includes('R$ 27,50'), page.api.db.lastWaiterPeriod);
  check('desempenho: hoje não mostra a lista por dia', !t.includes('Entregas por dia'));
  await click(page, '7 dias', true);
  t = await text(page);
  check('desempenho: 7 dias pede o período certo', page.api.db.lastWaiterPeriod === '7d' && t.includes('28') && t.includes('R$ 231,00'));
  check('desempenho: lista as entregas por dia', t.includes('Entregas por dia') && t.includes('09/10') && t.includes('03/10'));
  for (const [nome, viewport] of SIZES) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    check(`desempenho ${nome}: sem rolagem lateral`, await noScroll(page));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/garcom-desempenho-${nome}.png`, fullPage: true });
  }
  check('desempenho: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 6. Admin: tela Garçons cadastra, lista e desativa
await step('admin garçons', async () => {
  let page = await open('app-cliente.dc.html?module=admin&screen=dashboard', { role: 'admin', viewport: { width: 1280, height: 860 } });
  await click(page, 'Garçons', true);
  check('admin: "Garçons" no menu abre a tela', page.url().includes('module=admin') && (await text(page)).includes('Cadastrar garçom'));
  await page.close();
  page = await open('app-cliente.dc.html?module=admin&screen=waiters', { role: 'admin' });
  const cadastrar = page.locator('.btn', { hasText: 'Cadastrar garçom' });
  const enviar = async () => { await cadastrar.click(); await page.waitForTimeout(600); };
  let t = await text(page);
  check('admin: menu tem "Garçons" e lista o garçom', t.includes('Carlos Souza') && t.includes('carlos@sunfood.com') && t.includes('Hoje: 4 entregue(s) · 2 lançado(s)'));
  await enviar();
  check('admin: pede o nome antes de enviar', (await text(page)).includes('Informe o nome do garçom.'));
  await page.getByPlaceholder('Ex.: Carlos Souza').fill('Bruna Lima');
  await page.getByPlaceholder('garcom@sunfood.com').fill('garcom@sunfood.com');
  await page.getByPlaceholder('Mínimo de 6 caracteres').fill('Sunfood@123');
  await enviar();
  const post = called(page, '/waiters').find(c => c.body.name);
  check('admin: envia nome, e-mail e senha', post && post.body.email === 'garcom@sunfood.com' && post.body.password === 'Sunfood@123', JSON.stringify(post));
  t = await text(page);
  check('admin: confirma e mostra na lista', t.includes('Bruna Lima já pode entrar com garcom@sunfood.com') && t.includes('Bruna Lima'));
  await page.getByText('Desativar', { exact: true }).first().click(); await page.waitForTimeout(600);
  t = await text(page);
  check('admin: desativa o garçom', page.api.db.waiters[0].active === false && t.includes('Desativado') && t.includes('Reativar'));
  for (const [nome, viewport] of SIZES) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const btn = await cadastrar.boundingBox();
    check(`admin ${nome}: sem rolagem lateral e botão de 44 px ou mais`, (await noScroll(page)) && btn && btn.height >= 44, JSON.stringify(btn));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-garcons-${nome}.png`, fullPage: true });
  }
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
