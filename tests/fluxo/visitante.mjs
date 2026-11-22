// Cardápio sem conta: o visitante abre o cardápio pela tela inicial, vê os
// produtos e monta o carrinho sem entrar. A conta só é pedida ao finalizar
// e, depois de entrar (e-mail ou Google), o app volta para a etapa da mesa
// com o mesmo carrinho. Confere também celular, tablet, computador e tela larga.
// Uso: node fluxo/visitante.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const SHOTS = process.env.SHOTS_DIR; // opcional: pasta para guardar prints
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const file = path === '/' ? 'index.html' : path;
    const b = await readFile(join(ROOT, file)); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(b);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const text = p => p.locator('body').innerText();
const renderError = p => p.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (p, t, exact = false) => { await p.getByText(t, { exact }).filter({ visible: true }).first().click({ timeout: 5000 }); await p.waitForTimeout(600); };
const store = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
const screen = p => new URL(p.url()).searchParams.get('screen');
const naEntrada = p => /\/(index\.html)?$/.test(new URL(p.url()).pathname);

async function open(path, { viewport = { width: 390, height: 844 }, user } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // Login com Google pelo Supabase (sem o ID do cliente do Google direto).
  await page.route(/\/app-cliente\.dc\.html(\?.*)?$/, async r => {
    const html = await readFile(join(ROOT, 'app-cliente.dc.html'), 'utf8');
    r.fulfill({ contentType: 'text/html', body: html.replace(/const GOOGLE_CLIENT_ID = '[^']*';/, "const GOOGLE_CLIENT_ID = '';") });
  });
  // Supabase falso: o /authorize do Google volta direto para o site com o token.
  await page.route(/supabase\.co/, route => {
    const u = new URL(route.request().url());
    route.fulfill({ status: 302, headers: { location: u.searchParams.get('redirect_to') + '#access_token=gtok&expires_in=3600&refresh_token=r1&token_type=bearer' } });
  });
  const api = fakeApi('cliente');
  page.api = api;
  await page.route('http://localhost:8787/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (user && (p === '/auth/me' || p === '/auth/login')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'tok', refreshToken: 'r0', user }) });
    return api(route);
  });
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}

// 1. Tela inicial: "Ver cardápio" abre o cardápio sem pedir conta
await step('visitante abre o cardápio', async () => {
  const page = await open('');
  await click(page, 'Ver cardápio', true);
  await page.waitForTimeout(800);
  check('Ver cardápio: abre o cardápio do app sem conta', /app-cliente\.dc\.html/.test(page.url()) && screen(page) === 'menu'
    && (await text(page)).includes('Batata Frita') && await store(page, 'sunfood_session') === null, page.url());
  check('visitante: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  const nav = await page.locator('.bottomnav').innerText();
  check('visitante: menu de baixo mostra Entrar no lugar de Perfil', nav.includes('Entrar') && !nav.includes('Perfil'), nav);

  // Cartão do cardápio da tela inicial também abre o cardápio.
  const ini = await open('');
  await ini.locator('.lp-cat').first().click(); await ini.waitForTimeout(1500);
  check('cartão da tela inicial: abre o cardápio sem conta', screen(ini) === 'menu' && (await text(ini)).includes('Batata Frita'), ini.url());
  await ini.context().close();

  // Produto e carrinho sem conta; o carrinho fica guardado no aparelho.
  await click(page, 'Batata Frita', true);
  check('visitante: abre o detalhe do produto', screen(page) === 'product' && (await text(page)).includes('Adicionar'), screen(page));
  await click(page, 'Adicionar');
  await page.getByLabel('Adicionar Água de Coco').or(page.locator('.addbtn').nth(1)).first().click().catch(() => {});
  await page.waitForTimeout(400);
  const salvo = await store(page, 'sunfood_cart');
  check('visitante: carrinho guardado no aparelho sem conta', salvo && salvo.user === null && salvo.cart.some(c => c.name === 'Batata Frita'), JSON.stringify(salvo));
  await page.reload(); await page.waitForTimeout(1500);
  await page.locator('.cartpill:visible, .mobilebar :text("carrinho")').first().click().catch(() => {});
  if (screen(page) !== 'cart') { await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=cart'); await page.waitForTimeout(1500); }
  check('visitante: recarregar mantém o carrinho', screen(page) === 'cart' && (await text(page)).includes('Batata Frita'), (await text(page)).slice(0, 200));
  check('carrinho do visitante: botão "Entrar e finalizar" com aviso', (await text(page)).includes('Entrar e finalizar')
    && (await text(page)).includes('Para finalizar, entre ou crie sua conta'), (await text(page)).slice(0, 400));

  // Finalizar pede a conta e volta para a etapa da mesa depois de entrar.
  await click(page, 'Entrar e finalizar', true);
  await page.waitForTimeout(800);
  check('finalizar sem conta: vai para a tela de entrada com o aviso', naEntrada(page)
    && (await text(page)).includes('Entre ou crie sua conta para finalizar o pedido'), page.url());
  check('finalizar sem conta (celular): e-mail, Google e Criar conta à vista', await page.locator('#com-email').isVisible()
    && await page.locator('#google').isVisible() && await page.locator('.login-foot').getByText('Criar conta', { exact: true }).isVisible());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/visitante-entrada-celular.png` });
  await page.locator('#com-email').click(); await page.waitForTimeout(300);
  await page.locator('#email').fill('cliente@teste');
  await page.locator('#pass').fill('senha');
  await page.locator('#entrar').click();
  await page.waitForTimeout(2000);
  check('depois de entrar: volta para a etapa da mesa', screen(page) === 'table', page.url());
  const t = await text(page);
  check('depois de entrar: mesmo carrinho na mesa', t.includes('Batata Frita') || (await store(page, 'sunfood_cart'))?.cart?.some(c => c.name === 'Batata Frita'), t.slice(0, 300));
  const depois = await store(page, 'sunfood_cart');
  check('depois de entrar: carrinho passa a ser da conta', depois && depois.user === 'u1', JSON.stringify(depois));
  check('depois de entrar: aviso de finalizar foi consumido', await page.evaluate(() => localStorage.getItem('sunfood_finalizar')) === null);
  await page.locator('input').first().fill('1');
  await click(page, 'Escolher pagamento', true);
  check('depois de entrar: segue para o pagamento', screen(page) === 'payment', page.url());
  check('fluxo do visitante: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.context().close();
});

// 2. Telas que precisam de conta mandam o visitante para o cardápio ou para a entrada
await step('visitante e telas da conta', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=profile');
  const t = await text(page);
  check('visitante no endereço do Perfil: vê o cardápio, sem perfil de exemplo', t.includes('Batata Frita') && !t.includes('Ana Souza') && !t.includes('ana@email.com'), t.slice(0, 200));
  await page.locator('.bottomnav').getByText('Meus pedidos').click(); await page.waitForTimeout(800);
  check('visitante em Meus pedidos: vai para a entrada com aviso', naEntrada(page) && (await text(page)).includes('Entre ou crie sua conta para ver seus pedidos'), page.url());
  await page.context().close();

  const sem = await open('app-cliente.dc.html');
  check('app sem endereço e sem conta: continua indo para a entrada', naEntrada(sem), sem.url());
  await sem.context().close();
});

// 3. Entrar sem estar finalizando continua abrindo o cardápio
await step('login normal', async () => {
  const page = await open('');
  await click(page, 'Entrar com e-mail', true);
  await page.locator('#email').fill('cliente@teste');
  await page.locator('#pass').fill('senha');
  await page.locator('#entrar').click(); await page.waitForTimeout(2000);
  check('login sem carrinho: abre o cardápio', screen(page) === 'menu', page.url());
  const nav = await page.locator('.bottomnav').innerText();
  check('logado: menu de baixo volta a mostrar Perfil', nav.includes('Perfil') && !nav.includes('Entrar'), nav);
  await page.context().close();
});

// 4. Google: visitante finaliza, entra com Google e volta para a mesa
await step('finalizar com Google', async () => {
  const user = { id: 'g1', email: 'bia@gmail.com', name: 'Bia', role: 'cliente', profileComplete: true };
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { user });
  await page.locator('.addbtn').first().click(); await page.waitForTimeout(300);
  await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=cart'); await page.waitForTimeout(1500);
  await click(page, 'Entrar e finalizar', true);
  await page.waitForTimeout(800);
  await page.locator('#google').click({timeout:5000});
  await page.waitForTimeout(2500);
  check('Google: volta para a etapa da mesa com o carrinho', screen(page) === 'table' && (await store(page, 'sunfood_cart'))?.cart?.length > 0, page.url());
  await page.context().close();

  // Primeiro acesso pelo Google (cadastro incompleto): completa e cai no carrinho.
  const novo = await open('app-cliente.dc.html?module=cliente&screen=menu', { user: { ...user, profileComplete: false } });
  await novo.locator('.addbtn').first().click(); await novo.waitForTimeout(300);
  await novo.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=cart'); await novo.waitForTimeout(1500);
  await click(novo, 'Entrar e finalizar', true);
  await novo.locator('#google').click();
  await novo.waitForTimeout(2500);
  check('Google primeiro acesso: pede o cadastro antes, com o carrinho guardado', (await text(novo)).includes('Falta pouco') || (await text(novo)).includes('CPF'), (await text(novo)).slice(0, 200));
  check('Google primeiro acesso: carrinho continua', (await store(novo, 'sunfood_cart'))?.cart?.length > 0);
  await novo.context().close();
});

// 5. Medidas no celular, tablet, computador e tela larga
const TAMANHOS = [['celular', 390, 844], ['tablet', 820, 1180], ['computador', 1366, 768], ['tela larga', 1920, 1080]];
for (const [nome, w, h] of TAMANHOS) {
  await step('medidas ' + nome, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { viewport: { width: w, height: h } });
    await page.locator('.addbtn').first().click(); await page.waitForTimeout(300);
    const lateral = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`cardápio do visitante (${nome}): sem rolagem lateral`, !(await lateral()));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/visitante-cardapio-${nome.replace(' ', '-')}.png` });
    await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=cart'); await page.waitForTimeout(1500);
    const btn = page.locator('.btn', { hasText: 'Entrar e finalizar' }).filter({ visible: true }).first();
    const real = await btn.boundingBox();
    check(`carrinho do visitante (${nome}): botão de finalizar com ${w < 768 ? 48 : 40} px ou mais`, real && real.height >= (w < 768 ? 48 : 40) - 0.5, String(real && real.height));
    const aviso = await page.locator('.cart-conta').filter({ visible: true }).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize) * (e.currentCSSZoom || 1));
    check(`carrinho do visitante (${nome}): aviso com 12 px ou mais na tela`, aviso >= 12, String(aviso));
    check(`carrinho do visitante (${nome}): sem rolagem lateral`, !(await lateral()));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/visitante-carrinho-${nome.replace(' ', '-')}.png` });
    check(`visitante (${nome}): sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.context().close();
  });
}

await browser.close();
server.close();
const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} ok`);
process.exit(fails.length ? 1 : 0);
