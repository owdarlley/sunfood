// Teste de fluxo das telas do SunFood num navegador de verdade (Chromium),
// com uma API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/conexao.mjs   (a partir da raiz do repositório)
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


// Estados de falha da auditoria de design e UX (2026-10-21): faixa "Sem
// conexão" na equipe e no cliente (D-01/D-04), prazo e expiração do PIX
// (D-02), erros que ficam na tela (D-03) e o pedido anterior cancelado antes
// do novo (D-05). Celular, tablet, computador e tela larga.
const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }],
  ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]];

async function open(path, { role, seed, session, viewport = { width: 390, height: 844 }, setup } = {}) {
  const page = await browser.newPage({ viewport, serviceWorkers: 'block' });
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) api.seed();
  if (setup) setup(api.db);
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  if ((role && role !== 'cliente') || session) await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role || 'cliente');
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split("\n")[0]); } }
const semErro = async (page, nome) => check(`${nome}: sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
const semRolagem = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// Tamanho real na tela (o app tem zoom de 83%: getBoundingClientRect já mostra o tamanho final).
const caixa = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; }, sel);

// O caminho até o pagamento é feito no tamanho de celular; depois a tela
// volta ao tamanho do teste.
async function ateOPagamento(page) {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Escolher a mesa');
  await page.getByLabel('Número da mesa', { exact: true }).fill('1');
  await click(page, 'Escolher pagamento');
  await page.setViewportSize(vp); await page.waitForTimeout(400);
}

for (const [tela, viewport] of TELAS) {
  await step(`cozinha ${tela}: faixa de conexão`, async () => {
    const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true, viewport });
    check(`cozinha ${tela}: sem faixa com a API respondendo`, !(await page.locator('.netbar').count()));
    // Uma falha solta não assusta ninguém; a partir da segunda, a faixa aparece.
    page.api.db.down = true;
    await page.waitForTimeout(3300);
    check(`cozinha ${tela}: uma falha só não mostra a faixa`, !(await page.locator('.netbar').count()));
    await page.waitForTimeout(4000);
    const t = await text(page);
    check(`cozinha ${tela}: faixa "Sem conexão" com a hora da última atualização`, /Sem conexão · última atualização às \d\d:\d\d/.test(t), t.slice(0, 200));
    check(`cozinha ${tela}: faixa é um alerta (leitor de tela)`, (await page.locator('.netbar[role="alert"]').count()) === 1);
    const btn = await caixa(page, '.netbar-btn');
    check(`cozinha ${tela}: "Tentar agora" com altura de toque`, btn && btn.h >= (viewport.width <= 1024 ? 47 : 43) && btn.x + btn.w <= viewport.width, JSON.stringify(btn));
    check(`cozinha ${tela}: sem rolagem lateral com a faixa`, (await semRolagem(page)) <= 0);
    // Espera crescente: com a API fora, as consultas ficam mais espaçadas.
    const antes = page.api.db.log.length;
    await page.waitForTimeout(6000);
    check(`cozinha ${tela}: a faixa continua enquanto a API não volta`, (await page.locator('.netbar').count()) === 1);
    page.api.db.down = false;
    await page.getByRole('button', { name: 'Tentar agora' }).click();
    await page.waitForTimeout(800);
    check(`cozinha ${tela}: "Tentar agora" tira a faixa quando a API volta`, !(await page.locator('.netbar').count()));
    check(`cozinha ${tela}: avisa que a conexão voltou`, (await text(page)).includes('Conexão de volta'));
    check(`cozinha ${tela}: voltou a atualizar os pedidos`, page.api.db.log.length > antes);
    await semErro(page, `cozinha ${tela}`);
    await page.close();
  });
}

await step('cozinha: espera crescente sem conexão', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  let tentativas = 0;
  await page.route('http://localhost:8787/orders', r => { tentativas++; r.abort('internetdisconnected'); });
  await page.waitForTimeout(25000);
  // Sem espera crescente seriam ~8 tentativas em 25 s (uma a cada 3 s).
  check('cozinha: tenta menos vezes com a API fora (3, 6, 12 s...)', tentativas >= 2 && tentativas <= 5, String(tentativas));
  await page.close();
});

await step('cozinha: som quando a conexão cai e volta', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  await page.evaluate(() => {
    window.__tons = 0;
    const AC = window.AudioContext;
    const orig = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function(){ const o = orig.call(this); if (o.type !== undefined) { const set = Object.getOwnPropertyDescriptor(OscillatorNode.prototype, 'type').set; Object.defineProperty(o, 'type', { set(v){ if (v === 'triangle') window.__tons++; set.call(this, v); }, get(){ return 'triangle'; } }); } return o; };
  });
  await page.mouse.click(5, 5);
  page.api.db.down = true;
  await page.waitForTimeout(7500);
  const caiu = await page.evaluate(() => window.__tons);
  page.api.db.down = false;
  await page.getByRole('button', { name: 'Tentar agora' }).click();
  await page.waitForTimeout(800);
  const voltou = await page.evaluate(() => window.__tons);
  check('cozinha: toca ao cair e ao voltar a conexão', caiu >= 2 && voltou >= caiu + 2, JSON.stringify({ caiu, voltou }));
  await page.close();
});

await step('admin: aba em segundo plano atualiza menos', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=dashboard', { role: 'admin', seed: true });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const n0 = page.api.db.log.filter(l => l === 'GET /orders').length;
  await page.waitForTimeout(10000);
  const n1 = page.api.db.log.filter(l => l === 'GET /orders').length;
  check('admin: com a aba escondida não consulta a cada 3 s', n1 - n0 <= 1, String(n1 - n0));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  const n2 = page.api.db.log.filter(l => l === 'GET /orders').length;
  check('admin: ao voltar para a aba atualiza na hora', n2 > n1, String(n2 - n1));
  await page.close();
});

for (const [tela, viewport] of TELAS) {
  await step(`cliente ${tela}: sem internet`, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { session: true, viewport });
    await ateOPagamento(page);
    await page.context().setOffline(true);
    await page.waitForTimeout(500);
    let t = await text(page);
    check(`cliente ${tela}: sem faixa "Sem conexão" no app do cliente`, !(await page.locator('.netbar').count()) && !t.includes('Tentar agora'), t.slice(0, 200));
    check(`cliente ${tela}: explica no pagamento por que não dá para pagar`, t.includes('o pagamento volta a funcionar quando a internet voltar'));
    check(`cliente ${tela}: botão Pagar desligado`, (await page.locator('.btn[aria-disabled="true"]', { hasText: 'Pagar' }).count()) === 1);
    check(`cliente ${tela}: sem rolagem lateral`, (await semRolagem(page)) <= 0);
    await page.context().setOffline(false);
    await page.waitForTimeout(1200);
    t = await text(page);
    check(`cliente ${tela}: sem aviso "Conexão de volta" para o cliente`, !t.includes('Conexão de volta'));
    check(`cliente ${tela}: Pagar volta a funcionar`, (await page.locator('.btn[aria-disabled="true"]', { hasText: 'Pagar' }).count()) === 0);
    await semErro(page, `cliente ${tela}`);
    await page.close();
  });
}

for (const [tela, viewport] of TELAS) {
  await step(`PIX ${tela}: prazo e expiração`, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { session: true, viewport, setup: db => { db.pixTtlMs = 30 * 60 * 1000; } });
    await ateOPagamento(page);
    await click(page, 'Pagar R$');
    let t = await text(page);
    check(`PIX ${tela}: mostra a contagem regressiva`, /Este PIX expira em (30:00|29:5\d)/.test(t), t.slice(0, 300));
    const t1 = await page.locator('.pixtimer').innerText();
    await page.waitForTimeout(2100);
    const t2 = await page.locator('.pixtimer').innerText();
    check(`PIX ${tela}: a contagem anda`, t1 !== t2, t1 + ' / ' + t2);
    check(`PIX ${tela}: sem rolagem lateral`, (await semRolagem(page)) <= 0);
    // Voltar e tocar em Pagar de novo, sem mudar nada: mostra o mesmo QR, sem outra cobrança.
    const cobrancas = page.api.db.pixCount;
    await page.locator('.backbtn').first().click(); await page.waitForTimeout(600);
    check(`PIX ${tela}: voltar leva à forma de pagamento`, (await text(page)).includes('Forma de pagamento'));
    await click(page, 'Pagar R$');
    check(`PIX ${tela}: mesmo pedido reaproveita o QR guardado (sem nova cobrança)`, page.api.db.pixCount === cobrancas && page.api.db.orders.length === 1, JSON.stringify({ antes: cobrancas, depois: page.api.db.pixCount, pedidos: page.api.db.orders.length }));
    // Faz o QR vencer (o relógio do aparelho anda 31 min).
    await page.evaluate(() => { const n = Date.now; Date.now = () => n() + 31 * 60 * 1000; });
    await page.waitForTimeout(1300);
    t = await text(page);
    check(`PIX ${tela}: PIX vencido mostra "Este PIX expirou"`, t.includes('Este PIX expirou') && !t.includes('Copiar código PIX'), t.slice(0, 300));
    const btn = await caixa(page, '.btn.btn-sun');
    check(`PIX ${tela}: "Gerar novo PIX" com altura de toque`, btn && btn.h >= (viewport.width <= 1024 ? 47 : 43), JSON.stringify(btn));
    // O relógio do aparelho continua 31 min à frente: o QR novo vale 40 min (sobram ~9).
    page.api.db.pixTtlMs = 40 * 60 * 1000;
    await click(page, 'Gerar novo PIX', true);
    t = await text(page);
    check(`PIX ${tela}: gera outro QR para o mesmo pedido`, page.api.db.pixCount === cobrancas + 1 && page.api.db.orders.length === 1 && /Este PIX expira em/.test(t), JSON.stringify({ pix: page.api.db.pixCount, pedidos: page.api.db.orders.length }));
    await semErro(page, `PIX ${tela}`);
    await page.close();
  });
}

await step('PIX: pedido cancelado pelo servidor volta ao pagamento', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { session: true });
  await ateOPagamento(page);
  await click(page, 'Pagar R$');
  Object.assign(page.api.db.orders[0], { status: 'Cancelado', paymentStatus: 'cancelled' });
  await page.waitForTimeout(3800);
  const t = await text(page);
  check('PIX cancelado: volta para a forma de pagamento', t.includes('Forma de pagamento'), t.slice(0, 200));
  check('PIX cancelado: explica e mantém o carrinho', t.includes('O PIX expirou e o pedido foi cancelado') && t.includes('Seu carrinho continua aqui'));
  await page.waitForTimeout(3000);
  check('PIX cancelado: a explicação não some sozinha', (await text(page)).includes('O PIX expirou e o pedido foi cancelado'));
  await click(page, 'Pagar R$');
  check('PIX cancelado: pagar de novo cria outro pedido', page.api.db.orders.length === 2 && (await text(page)).includes('Este PIX expira em'), String(page.api.db.orders.length));
  await semErro(page, 'PIX cancelado');
  await page.close();
});

for (const [tela, viewport] of TELAS) {
  await step(`erro ${tela}: fica na tela`, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { session: true, viewport, setup: db => { db.pixFail = 503; } });
    await ateOPagamento(page);
    await click(page, 'Pagar R$');
    await page.waitForTimeout(3500);
    const t = await text(page);
    check(`erro ${tela}: erro do PIX continua na tela depois de 3 s`, t.includes('Pagamento online indisponível'), t.slice(0, 300));
    check(`erro ${tela}: é um alerta (role=alert)`, (await page.locator('.payalert[role="alert"]').count()) === 1);
    check(`erro ${tela}: sem rolagem lateral`, (await semRolagem(page)) <= 0);
    await click(page, 'Mudar para pagar na entrega');
    await click(page, 'Fazer pedido');
    const o = page.api.db.orders;
    const pix = o.find(x => x.paymentMethod === 'pix'), entrega = o.find(x => x.paymentMethod === 'entrega');
    check(`erro ${tela}: troca para pagar na entrega e faz o pedido`, o.length === 2 && pix.status === 'Cancelado' && entrega && entrega.status === 'Na Fila', JSON.stringify(o.map(x => [x.status, x.paymentMethod])));
    await semErro(page, `erro ${tela}`);
    await page.close();
  });
}

await step('trocar o carrinho espera cancelar o pedido anterior', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { session: true });
  await ateOPagamento(page);
  await click(page, 'Pagar R$');
  // Cancelamento sem resposta (rede caiu): não cria outro pedido e avisa.
  await page.route('http://localhost:8787/orders/*/cancel', r => r.abort('internetdisconnected'));
  await click(page, 'Pagar na entrega', true).catch(() => {});
  if (!(await text(page)).includes('Forma de pagamento')) { await page.evaluate(() => history.back()); await page.waitForTimeout(600); }
  await click(page, 'Pagar na entrega', true);
  await click(page, 'Fazer pedido');
  let t = await text(page);
  check('D-05: sem resposta do cancelamento, não cria outro pedido', page.api.db.orders.length === 1, String(page.api.db.orders.length));
  check('D-05: avisa na tela', t.includes('Não conseguimos trocar o pedido anterior'), t.slice(0, 300));
  await page.unroute('http://localhost:8787/orders/*/cancel');
  await click(page, 'Fazer pedido');
  const log = page.api.db.log.filter(l => /^POST \/orders/.test(l));
  check('D-05: cancela o anterior antes de criar o novo', page.api.db.orders.length === 2 && /cancel$/.test(log[log.length - 2]) && log[log.length - 1] === 'POST /orders', JSON.stringify(log));
  await semErro(page, 'D-05');
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
