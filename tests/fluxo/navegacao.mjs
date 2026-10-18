// Navegação e falhas: voltar do navegador/celular troca de tela, o carrinho
// sobrevive à recarga, telas sem pedido não mostram dados falsos, cardápio fora
// do ar mostra erro (não um cardápio de exemplo) e o teclado alcança os botões.
// Uso: node tests/fluxo/navegacao.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
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

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function open(path, { role = 'cliente', seed, width = 390, height = 844, api, context } = {}) {
  const ctx = context || await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  page.api = api || fakeApi(role);
  if (seed) page.api.seed();
  await page.route('http://localhost:8787/**', page.api);
  if (!context) await page.addInitScript(r => {
    try { sessionStorage.setItem('sunfood_abertura', '1'); } catch {}
    if (!localStorage.getItem('sunfood_session')) localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } }));
  }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const screen = page => new URL(page.url()).searchParams.get('screen');
const addFirst = async page => { await page.locator('.addbtn:visible').first().click(); await page.waitForTimeout(300); };

// 1. Voltar do navegador (e do Android no APK) volta uma tela, sem perder o carrinho
await step('voltar', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu');
  await addFirst(page);
  await page.getByText('item no carrinho').first().click(); await page.waitForTimeout(400);
  check('voltar: carrinho entra no endereço', screen(page) === 'cart', page.url());
  await page.getByText('Escolher a mesa').click(); await page.waitForTimeout(400);
  check('voltar: tela da mesa entra no endereço', screen(page) === 'table', page.url());
  await page.goBack(); await page.waitForTimeout(600);
  let t = await text(page);
  check('voltar: da mesa volta para o carrinho com o item', screen(page) === 'cart' && t.includes('Batata Frita') && t.includes('R$ 25,00'), screen(page) + ' | ' + t.slice(0, 120));
  await page.goBack(); await page.waitForTimeout(600);
  check('voltar: do carrinho volta para o cardápio', screen(page) === 'menu' && (await text(page)).includes('1 item no carrinho'), screen(page));
  await page.goForward(); await page.waitForTimeout(600);
  check('voltar: avançar volta ao carrinho', screen(page) === 'cart', screen(page));
  check('voltar: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.context().close();
});

// 2. Recarregar não perde o carrinho (nem a mesa); outra conta não vê o carrinho
await step('recarregar', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu');
  await addFirst(page);
  await page.getByText('item no carrinho').first().click(); await page.waitForTimeout(400);
  await page.getByText('Escolher a mesa').click(); await page.waitForTimeout(400);
  await page.getByLabel('Número da mesa', { exact: true }).fill('3');
  await page.getByText('Escolher pagamento').click(); await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(1500);
  const t = await text(page);
  check('recarregar: continua no Pagamento com o item e a mesa', screen(page) === 'payment' && t.includes('Batata Frita') && t.includes('Mesa 3') && t.includes('Pagar R$ 25,00'), t.slice(0, 200));
  await page.evaluate(() => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u2', email: 'outra@teste', name: 'Outra', role: 'cliente' } })));
  await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=menu'); await page.waitForTimeout(1500);
  check('recarregar: outra conta no aparelho não herda o carrinho', !(await text(page)).includes('no carrinho'));
  await page.context().close();
});

// 3. Telas abertas sem pedido ou sem itens não mostram dados falsos
await step('telas sem pedido', async () => {
  for (const sc of ['status', 'confirm', 'pix']) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=' + sc);
    const t = await text(page);
    check(`sem pedido: ${sc} mostra Meus pedidos`, t.includes('Meus pedidos') && !t.includes('Pagamento aprovado') && !t.includes('R$ 0,00'), t.slice(0, 160));
    await page.context().close();
  }
  for (const sc of ['cart', 'table', 'payment']) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=' + sc);
    const t = await text(page);
    check(`sem itens: ${sc} mostra o carrinho vazio`, !t.includes('R$ 0,00') && !t.includes('Escolher a mesa') && !t.includes('Escolher pagamento'), t.slice(0, 160));
    await page.context().close();
  }
});

// 4. Servidor fora do ar na primeira visita: aviso de erro, nada de cardápio de exemplo
await step('cardápio fora do ar', async () => {
  let fora = true;
  const api = fakeApi('cliente');
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { api: r => fora ? r.abort() : api(r) });
  let t = await text(page);
  check('fora do ar: mostra aviso de erro', t.includes('Não conseguimos carregar o cardápio') && t.includes('Tentar de novo'), t.slice(0, 200));
  check('fora do ar: não mostra o cardápio de exemplo', !t.includes('Água de Coco Gelada') && !t.includes('R$ 8,00'));
  fora = false;
  await page.getByText('Tentar de novo', { exact: true }).click(); await page.waitForTimeout(1200);
  t = await text(page);
  check('fora do ar: Tentar de novo carrega o cardápio de verdade', t.includes('Batata Frita') && !t.includes('Não conseguimos carregar'), t.slice(0, 200));
  await page.context().close();
});

// 5. Teclado: Tab alcança os produtos e Enter adiciona; o admin também tem foco
await step('teclado', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { width: 1280, height: 800 });
  let achou = false;
  for (let i = 0; i < 20 && !achou; i++) {
    await page.keyboard.press('Tab');
    achou = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('addbtn'));
  }
  check('teclado: Tab chega ao botão de adicionar', achou);
  check('teclado: botão anunciado como botão', await page.evaluate(() => document.activeElement.getAttribute('role')) === 'button');
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  { const t = await text(page); check('teclado: Enter adiciona o item', /Fechar pedido\s*·\s*R\$ 25,00/.test(t), t.slice(t.indexOf('Seu pedido'), t.indexOf('Seu pedido') + 200)); }
  check('teclado: idioma da página é pt-BR', await page.evaluate(() => document.documentElement.lang) === 'pt-BR');
  await page.context().close();
  const admin = await open('app-cliente.dc.html?module=admin&screen=dashboard', { role: 'admin', seed: true, width: 1280, height: 800 });
  await admin.keyboard.press('Tab'); await admin.keyboard.press('Tab');
  const foco = await admin.evaluate(() => (document.activeElement.innerText || '').trim());
  check('teclado: no admin o Tab passa pelo menu', foco === 'Pedidos' || foco === 'Painel', foco);
  await admin.keyboard.press('Enter'); await admin.waitForTimeout(600);
  check('teclado: Enter no menu do admin troca de tela', ['orders', 'dashboard'].includes(screen(admin)), admin.url());
  await admin.context().close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
