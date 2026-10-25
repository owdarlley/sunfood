// Tira print de todas as telas do SunFood (celular e computador) com a API falsa.
const ROOT = process.env.SUNFOOD_DIR || '/home/user/sunfood';
const { chromium } = await import('file://' + ROOT.replace(/\\/g, '/') + '/tests/node_modules/playwright/index.mjs');
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import QRCode from 'qrcode';
const { fakeApi } = await import('file://' + ROOT.replace(/\\/g, '/') + '/tests/fluxo/fake-api.mjs');
import * as D from './dados.mjs';

const CDN = process.env.CDN_DIR; // só quando o unpkg.com estiver bloqueado
// REAL=1: cardápio, categorias e fotos de verdade (lidos da API de produção, só GET). O resto segue de exemplo.
const REAL = process.env.REAL === '1';
const PROD_API = 'https://sunfood-api-nine.vercel.app';
let PRODUCTS = D.PRODUCTS, CATEGORIES = D.CATEGORIES;
if (REAL) {
  const real = await fetch(PROD_API + '/products').then(r => r.json());
  CATEGORIES = await fetch(PROD_API + '/categories').then(r => r.json());
  for (const [k, name] of Object.entries(D.REAL_MAP)) { const p = real.find(x => x.name === name); if (p) p.id = k; }
  const acai = real.find(x => x.id === 'p5'); if (acai) Object.assign(acai, { soldOut: true, stockQty: 0 }); // tela de item esgotado
  PRODUCTS = real;
  console.log('cardápio real:', real.length, 'itens,', real.filter(p => p.imageUrl).length, 'com foto');
}
const OUT = process.env.OUT || 'png';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const SIZES = {
  celular: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  computador: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const ONLY_SIZE = process.env.SIZE;

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path === '/' ? 'index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const QR = await QRCode.toDataURL('00020101021226870014br.gov.bcb.pix2565pix.stripe.com/qr/v2/cobv/sunfood-exemplo520400005303986540530.805802BR5913QUIOSQUE SUNFOOD6008SANTOS62070503***6304ABCD', { margin: 1, width: 360 });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

function api(role, opts = {}) {
  const a = fakeApi(role, { stripe: true });
  const db = a.db;
  db.products = structuredClone(PRODUCTS);
  db.categories = structuredClone(CATEGORIES);
  db.tables = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, active: i + 1 !== 7, seats: (i + 1) % 3 === 0 ? 6 : 4 }));
  db.kiosk = { paused: !!opts.paused, dayClosed: false, cancelWindowMinutes: 5, minOrder: 10, minOrderEnabled: true, tableCount: 12,
    location: { name: 'Quiosque SunFood · Praia do Gonzaga', address: 'Av. Vicente de Carvalho, em frente ao posto 3, Santos - SP', hours: 'Aberto todos os dias, 9h às 18h.' } };
  db.orders = opts.noOrders ? [] : D.orders(PRODUCTS);
  db.contacts = structuredClone(D.CONTACTS);
  db.waiters = structuredClone(D.WAITERS);
  db.hasWaiters = true;
  a.user.name = { cliente: 'Ana Souza', admin: 'Dárlley', cozinha: 'Cozinha', garcom: 'Carlos Souza' }[role];
  a.user.email = { cliente: 'ana@email.com', admin: 'admin@sunfood.app.br', cozinha: 'cozinha@sunfood.app.br', garcom: 'carlos@sunfood.com' }[role];
  db.profile = { phone: '13999990000', birthDate: '1996-04-12', cpf: '529.***.***-25', hasPassword: true };
  const handler = async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (db.down) return route.abort('internetdisconnected');
    if (opts.catalogDown && (p === '/products' || p === '/categories')) return route.abort('connectionrefused');
    if (p === '/orders/mine') return json(db.orders.filter(o => o.mine));
    if (p === '/dashboard') return json(D.DASHBOARD);
    if (p === '/ops-metrics') return json(D.OPS);
    if (p === '/admin/stripe') return json(D.STRIPE);
    if (p === '/day-reports/latest') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' });
    return a(route);
  };
  handler.db = db;
  return handler;
}

async function open(path, size, { role, opts = {}, session = true } = {}) {
  const ctx = await browser.newContext({ ...SIZES[size], serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/js\.stripe\.com|accounts\.google|supabase\.co\/(auth|rest)|maps\.google|google\.com\/maps/, r => r.abort());
  const h = api(role || 'cliente', opts);
  await page.route('http://localhost:8787/**', h);
  page.api = h;
  if (role && session) await page.addInitScript(r => { try { localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); } catch (e) {} }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}

// Acha o componente do app (React) e mexe no estado, para chegar em telas que dependem de pedido, carrinho etc.
const S = (page, patch) => page.evaluate(patch => {
  const el = document.querySelector('[data-dc-root], #root, body > div');
  const all = document.querySelectorAll('*');
  let inst = null;
  for (const n of all) {
    const k = Object.keys(n).find(k => k.startsWith('__reactFiber'));
    if (!k) continue;
    let f = n[k];
    while (f) { const L = f.stateNode && f.stateNode.logic; if (L && L.state && 'module' in L.state) { inst = L; break; } f = f.return; }
    if (inst) break;
  }
  if (!inst) throw new Error('componente não achado');
  window.__sf = inst;
  if (patch) inst.setState(patch);
  return true;
}, patch);
const call = (page, fn, arg) => page.evaluate(([fn, arg]) => new Function('inst', 'arg', fn)(window.__sf, arg), [fn, arg]);
const fillCart = async page => {
  await S(page);
  await call(page, `const P = id => inst.state.products.find(p => p.id === id);
    inst.addToCart(P('p1'), 1, 'sem bacon'); inst.addToCart(P('p3'), 2, ''); inst.addToCart(P('p6'), 1, '');`);
  await page.waitForTimeout(300);
};
const click = async (page, t, exact = true) => { await page.getByText(t, { exact }).filter({ visible: true }).first().click({ timeout: 5000 }); await page.waitForTimeout(600); };

const APP = 'app-cliente.dc.html';
const scr = (m, s) => `${APP}?module=${m}&screen=${s}`;

// [seção, arquivo, título, caminho, opções, preparo]
const SHOTS = [
  // Entrada e site
  ['01-entrada', '01-login', 'Tela inicial (login)', '', {}],
  ['01-entrada', '02-login-email', 'Entrar com e-mail', '', { onlySize: 'celular' }, async p => { if (await p.getByText('Entrar com e-mail', { exact: true }).filter({ visible: true }).count()) await click(p, 'Entrar com e-mail'); }],
  ['01-entrada', '03-login-erros', 'Entrar com e-mail: campos vazios', '', {}, async p => { if (await p.getByText('Entrar com e-mail', { exact: true }).filter({ visible: true }).count()) await click(p, 'Entrar com e-mail'); await click(p, 'Entrar'); }],
  ['01-entrada', '04-cadastro', 'Criar conta', scr('cliente', 'signup'), {}],
  ['01-entrada', '05-recuperar-senha', 'Recuperar senha', scr('cliente', 'forgot'), {}],
  ['01-entrada', '06-recuperar-senha-enviado', 'Recuperar senha: link enviado', scr('cliente', 'forgot'), {}, async p => { await S(p, { fpSent: true, fpSentTo: 'ana@email.com' }); }],
  ['01-entrada', '07-completar-cadastro', 'Completar cadastro (entrada pelo Google)', scr('cliente', 'signup'), {}, async p => { await S(p, { screen: 'completeProfile' }); }],
  ['01-entrada', '08-redefinir-senha', 'Redefinir senha (link do e-mail)', 'redefinir-senha.html#access_token=tok&type=recovery', {}],
  ['01-entrada', '09-redefinir-senha-expirado', 'Redefinir senha: link expirado', 'redefinir-senha.html#error=access_denied&error_code=otp_expired', {}],
  ['01-entrada', '10-sem-internet', 'Sem internet (app instalado)', 'offline.html', {}],
  // Painéis do rodapé
  ['02-site', '01-conheca', 'Conheça o SunFood', '#conheca', {}],
  ['02-site', '02-fale-conosco', 'Fale conosco', '#fale-conosco', {}],
  ['02-site', '03-fale-conosco-enviado', 'Fale conosco: mensagem enviada', '#fale-conosco', {}, async p => {
    await p.fill('#c-nome', 'Bruna Lima'); await p.fill('#c-contato', 'bruna@email.com'); await p.fill('#c-msg', 'Quero reservar uma mesa para 6 pessoas no sábado.');
    await click(p, 'Enviar mensagem'); }],
  ['02-site', '04-termos', 'Termos de uso', '#termos', {}],
  ['02-site', '05-privacidade', 'Política de privacidade', '#privacidade', {}],
  ['02-site', '06-baixar-app', 'Baixe o app', '#baixar-app', {}],
  // Cliente
  ['03-cliente', '01-cardapio', 'Cardápio', scr('cliente', 'menu'), { role: 'cliente' }],
  ['03-cliente', '02-cardapio-categoria', 'Cardápio filtrado por categoria', scr('cliente', 'menu'), { role: 'cliente' }, async p => S(p, { cat: 'Bebidas' })],
  ['03-cliente', '03-cardapio-busca-vazia', 'Cardápio: busca sem resultado', scr('cliente', 'menu'), { role: 'cliente' }, async p => S(p, { menuSearch: 'lagosta' })],
  ['03-cliente', '04-cardapio-fora-do-ar', 'Cardápio: servidor fora do ar', scr('cliente', 'menu'), { role: 'cliente', opts: { catalogDown: true }, clearCache: true }],
  ['03-cliente', '05-produto', 'Detalhe do produto', scr('cliente', 'menu'), { role: 'cliente' }, async p => S(p, { selId: 'p4', screen: 'product' })],
  ['03-cliente', '06-produto-esgotado', 'Detalhe do produto esgotado', scr('cliente', 'menu'), { role: 'cliente' }, async p => S(p, { selId: 'p5', screen: 'product' })],
  ['03-cliente', '07-carrinho', 'Carrinho', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await fillCart(p); await S(p, { screen: 'cart' }); }],
  ['03-cliente', '08-carrinho-limpar', 'Carrinho: confirmar limpar', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await fillCart(p); await S(p, { screen: 'cart', clearCartAsk: true }); }],
  ['03-cliente', '09-carrinho-vazio', 'Carrinho vazio', scr('cliente', 'cartEmpty'), { role: 'cliente' }],
  ['03-cliente', '10-mesa', 'Informar a mesa (etapa 1 de 2)', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await fillCart(p); await S(p, { screen: 'table', tableInput: '3' }); }],
  ['03-cliente', '11-pagamento', 'Escolha de pagamento (etapa 2 de 2)', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await fillCart(p); await S(p, { screen: 'payment', table: 3 }); }],
  ['03-cliente', '12-pix', 'Pagamento via PIX', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'pix', pixQrCode: '00020101021226870014br.gov.bcb.pix2565pix.stripe.com', pixQrImg: QR, pixExpiresAt: Date.now() + 29 * 60000 + 12000 }); }],
  ['03-cliente', '13-pix-expirado', 'PIX expirado', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'pix', pixQrCode: '000201', pixQrImg: QR, pixExpiresAt: Date.now() - 1000 }); }],
  ['03-cliente', '14-cartao', 'Pagamento via cartão', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'card' }); }],
  ['03-cliente', '15-confirmacao', 'Pedido confirmado', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'confirm' }); }],
  ['03-cliente', '16-falha-pagamento', 'Falha no pagamento', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'payFail' }); }],
  ['03-cliente', '17-acompanhar-pedido', 'Acompanhar pedido (tempo real)', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'status' }); }],
  ['03-cliente', '18-cancelar-pedido', 'Cancelar pedido: confirmação', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'cancelAsk' }); }],
  ['03-cliente', '19-cancelado', 'Cancelamento confirmado', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'cancelDone' }); }],
  ['03-cliente', '20-cancelamento-bloqueado', 'Cancelamento bloqueado', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await S(p); await S(p, { screen: 'cancelBlocked' }); }],
  ['03-cliente', '21-meus-pedidos', 'Meus pedidos (histórico)', scr('cliente', 'history'), { role: 'cliente' }],
  ['03-cliente', '22-meus-pedidos-vazio', 'Meus pedidos vazio', scr('cliente', 'history'), { role: 'cliente', opts: { noOrders: true } }, async p => S(p, { screen: 'historyEmpty' })],
  ['03-cliente', '23-detalhe-pedido', 'Detalhe de um pedido', scr('cliente', 'history'), { role: 'cliente' }, async p => { await S(p, { histSel: 1, screen: 'orderDetail' }); }],
  ['03-cliente', '24-perfil', 'Perfil', scr('cliente', 'profile'), { role: 'cliente' }],
  ['03-cliente', '25-editar-perfil', 'Editar perfil', scr('cliente', 'editProfile'), { role: 'cliente' }],
  ['03-cliente', '26-trocar-senha', 'Trocar senha', scr('cliente', 'changePassword'), { role: 'cliente' }],
  ['03-cliente', '27-excluir-conta', 'Excluir conta', scr('cliente', 'deleteAccount'), { role: 'cliente' }],
  ['03-cliente', '28-localizacao', 'Onde estamos (localização)', scr('cliente', 'location'), { role: 'cliente' }],
  ['03-cliente', '29-sem-conexao', 'Sem conexão', scr('cliente', 'offline'), { role: 'cliente' }],
  ['03-cliente', '30-pagamento-sem-internet', 'Pagamento sem internet', scr('cliente', 'menu'), { role: 'cliente' }, async p => { await fillCart(p); await S(p, { screen: 'payment', table: 3, netDown: true }); }],
  ['03-cliente', '31-rodape-janela', 'Termos abertos por cima do app (rodapé)', scr('cliente', 'menu'), { role: 'cliente' }, async p => {
    await p.locator('a:visible, button:visible').filter({ hasText: /^Termos( de uso)?$/ }).first().click({ timeout: 4000 }); await p.waitForTimeout(800); }],
  // Admin
  ['04-admin', '01-painel', 'Painel', scr('admin', 'dashboard'), { role: 'admin' }],
  ['04-admin', '02-pedidos', 'Pedidos', scr('admin', 'orders'), { role: 'admin' }],
  ['04-admin', '03-estorno', 'Estornar pedido', scr('admin', 'orders'), { role: 'admin' }, async p => { await S(p); await call(p, `inst.openRefund ? inst.openRefund('o12','total') : null`); await p.waitForTimeout(500); }],
  ['04-admin', '04-pagamentos', 'Pagamentos', scr('admin', 'payments'), { role: 'admin' }],
  ['04-admin', '05-mensagens', 'Mensagens (Fale conosco)', scr('admin', 'messages'), { role: 'admin' }],
  ['04-admin', '06-cardapio-estoque', 'Cardápio e estoque', scr('admin', 'productForm'), { role: 'admin' }],
  ['04-admin', '07-novo-produto', 'Novo item do cardápio', scr('admin', 'productForm'), { role: 'admin' }, async p => S(p, { pfOpen: true })],
  ['04-admin', '08-categorias', 'Categorias do cardápio', scr('admin', 'productForm'), { role: 'admin' }, async p => S(p, { catOpen: true })],
  ['04-admin', '09-excluir-item', 'Excluir item do cardápio', scr('admin', 'productForm'), { role: 'admin' }, async p => S(p, { pfDeleting: 'p10' })],
  ['04-admin', '10-quiosque-mesas', 'Quiosque e mesas', scr('admin', 'tables'), { role: 'admin' }],
  ['04-admin', '11-quiosque-pausado', 'Quiosque pausado', scr('admin', 'pause'), { role: 'admin', opts: { paused: true } }],
  ['04-admin', '12-relatorios', 'Relatórios', scr('admin', 'reports'), { role: 'admin' }],
  ['04-admin', '13-desempenho', 'Desempenho da operação', scr('admin', 'perfOps'), { role: 'admin' }],
  ['04-admin', '14-garcons', 'Garçons', scr('admin', 'waiters'), { role: 'admin' }],
  ['04-admin', '15-garcom-detalhe', 'Página de um garçom', scr('admin', 'waiters'), { role: 'admin' }, async p => { await click(p, 'Carlos Souza'); await p.waitForTimeout(600); }],
  ['04-admin', '16-stripe', 'Stripe (pagamentos online)', scr('admin', 'stripe'), { role: 'admin' }],
  ['04-admin', '17-encerrar-dia', 'Encerrar o dia', scr('admin', 'closeDay'), { role: 'admin' }],
  ['04-admin', '18-sem-conexao', 'Admin sem conexão', scr('admin', 'dashboard'), { role: 'admin' }, async p => S(p, { netDown: true, netLastOk: Date.now() - 4 * 60000 })],
  ['04-admin', '19-menu-celular', 'Menu lateral aberto', scr('admin', 'dashboard'), { role: 'admin', onlySize: 'celular' }, async p => { await click(p, 'Menu', false); }],
  // Cozinha
  ['05-cozinha', '01-kanban', 'Kanban de pedidos', scr('cozinha', 'kanban'), { role: 'cozinha' }],
  ['05-cozinha', '02-indisponivel', 'Sinalizar item indisponível', scr('cozinha', 'unavailable'), { role: 'cozinha' }],
  ['05-cozinha', '03-fila-vazia', 'Fila vazia', scr('cozinha', 'queueEmpty'), { role: 'cozinha', opts: { noOrders: true } }],
  ['05-cozinha', '04-sem-conexao', 'Cozinha sem conexão', scr('cozinha', 'kanban'), { role: 'cozinha' }, async p => S(p, { netDown: true, netLastOk: Date.now() - 3 * 60000 })],
  // Garçom
  ['06-garcom', '01-para-entregar', 'Para entregar', scr('garcom', 'entregar'), { role: 'garcom' }],
  ['06-garcom', '02-lancar-pedido', 'Lançar pedido na mesa', scr('garcom', 'novoPedido'), { role: 'garcom' }],
  ['06-garcom', '03-meu-desempenho', 'Meu desempenho', scr('garcom', 'desempenho'), { role: 'garcom' }],
];

const manifest = [];
for (const [sec, file, title, path, o, prep] of SHOTS) {
  if (ONLY && !ONLY.test(sec + '/' + file)) continue;
  for (const size of Object.keys(SIZES)) {
    if (ONLY_SIZE && size !== ONLY_SIZE) continue;
    if (o.onlySize && o.onlySize !== size) continue;
    const page = await open(path, size, { role: o.role, opts: o.opts || {} });
    try {
      if (o.clearCache) { await page.evaluate(() => localStorage.removeItem('sunfood_catalog')); await page.reload(); await page.waitForTimeout(1500); }
      if (prep) await prep(page);
      await page.waitForTimeout(900);
      await mkdir(join(OUT, sec), { recursive: true });
      const name = `${file}-${size}.png`;
      await page.screenshot({ path: join(OUT, sec, name) });
      const tall = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 40);
      if (tall) await page.screenshot({ path: join(OUT, sec, `${file}-${size}-inteira.png`), fullPage: true });
      manifest.push({ sec, file, title, size, name, full: tall ? `${file}-${size}-inteira.png` : null, url: page.url().replace(BASE, '/'), errors: page.errors });
      console.log('ok', sec, file, size, tall ? '(+inteira)' : '', page.errors.length ? 'ERROS: ' + page.errors.join(' | ') : '');
    } catch (e) {
      console.log('FALHA', sec, file, size, e.message.split('\n')[0]);
    }
    await page.context().close();
  }
}
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
await browser.close(); server.close();
