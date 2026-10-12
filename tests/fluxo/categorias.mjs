// Teste das categorias do cardápio e do cardápio sem as fotos padrão, num
// Chromium de verdade com a API falsa: o admin cria, renomeia, troca a cor,
// reordena e exclui categorias, e o cliente vê as abas na ordem certa.
// Uso: node tests/fluxo/categorias.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, FAKE_PHOTO_BASE } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const SHOTS = process.env.SHOTS_DIR; // opcional: salva prints da tela em 4 tamanhos
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };
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

async function open(path, { role, api, width = 400 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 860 }, serviceWorkers: 'block' });
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // As fotos "do Storage" viram um quadrado laranja servido aqui mesmo.
  await page.route(FAKE_PHOTO_BASE + '**', r => r.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#E8742C"/></svg>' }));
  api = api || fakeApi(role);
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  if (role !== 'cliente') await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(400); };
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const catRow = (page, nome) => page.locator('.catrow').filter({ has: page.locator('.catname b', { hasText: new RegExp('^' + nome + '$') }) });
const catOrder = page => page.locator('.catrow .catname b').allInnerTexts();
const tabs = page => page.locator('.cats .fpill').allInnerTexts();
const calls = (page, re) => page.api.db.log.filter(l => re.test(l));
const SIZES = [['celular', 390, 844], ['tablet', 820, 1180], ['computador', 1280, 800], ['tela-larga', 1920, 1080]];

// 1. Cardápio do cliente: nenhum item mostra foto (só a cor da categoria + ícone).
await step('cardápio sem fotos', async () => {
  const page = await open('app-cliente.dc.html', { role: 'cliente' });
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('.pcard .pimg span')].filter(s => /background-image:\s*url\("?[^")]/.test(s.getAttribute('style') || '')).length);
  const icons = await page.locator('.pcard .pimg svg').count();
  check('cliente: nenhum prato com foto padrão', imgs === 0, String(imgs));
  check('cliente: cada prato mostra o ícone na cor da categoria', icons === 5, String(icons));
  check('cliente: abas na ordem das categorias', JSON.stringify(await tabs(page)) === JSON.stringify(['Todos', 'Petiscos', 'Bebidas', 'Pratos', 'Sobremesas']), JSON.stringify(await tabs(page)));
  check('cliente: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Admin: painel de categorias em Cardápio e estoque.
await step('admin gerencia categorias', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin' });
  await click(page, 'Categorias', true);
  check('admin: abre o painel com as 4 categorias', JSON.stringify(await catOrder(page)) === JSON.stringify(['Petiscos', 'Bebidas', 'Pratos', 'Sobremesas']), JSON.stringify(await catOrder(page)));
  check('admin: mostra quantos itens cada uma tem', (await catRow(page, 'Bebidas').innerText()).includes('2 itens'));

  // Criar
  await page.locator('#catNewInp').fill('Porções');
  await page.locator('.catnew .swatch[aria-label="Verde"]').click();
  await click(page, 'Adicionar', true);
  await page.waitForTimeout(300);
  const nova = page.api.db.categories.find(c => c.name === 'Porções');
  check('admin: cria categoria com a cor escolhida', nova && nova.color === 'verde', JSON.stringify(nova));
  check('admin: nova categoria entra no fim da lista', (await catOrder(page)).at(-1) === 'Porções');
  check('admin: nova categoria aparece no filtro e no formulário', (await page.locator('.pills .fpill', { hasText: 'Porções' }).count()) === 1 && (await page.locator('.col-side .fpill', { hasText: 'Porções' }).count()) === 1);
  await page.locator('#catNewInp').fill('porções');
  await click(page, 'Adicionar', true);
  check('admin: avisa nome repetido', (await page.locator('.catpanel').innerText()).includes('Já existe uma categoria com esse nome.'));

  // Renomear e trocar cor
  await catRow(page, 'Petiscos').locator('[aria-label="Editar Petiscos"]').click(); await page.waitForTimeout(300);
  await catRow(page, 'Petiscos').locator('input').fill('Petiscos do Mar');
  await catRow(page, 'Petiscos').locator('.swatch[aria-label="Coral"]').click();
  await catRow(page, 'Petiscos').getByText('Salvar', { exact: true }).click(); await page.waitForTimeout(500);
  const ren = page.api.db.categories.find(c => c.name === 'Petiscos do Mar');
  check('admin: renomeia e troca a cor', ren && ren.color === 'coral', JSON.stringify(page.api.db.categories));
  check('admin: itens vão junto para o nome novo', (await page.locator('.pgrid .card', { hasText: 'Batata Frita' }).innerText()).includes('Petiscos do Mar'.toUpperCase()) || (await page.locator('.pgrid .card', { hasText: 'Batata Frita' }).innerText()).includes('Petiscos do Mar'));

  // Reordenar
  await catRow(page, 'Petiscos do Mar').locator('[aria-label="Descer Petiscos do Mar"]').click(); await page.waitForTimeout(400);
  check('admin: descer muda a ordem na tela e na API', (await catOrder(page))[1] === 'Petiscos do Mar' && page.api.db.categories.find(c => c.name === 'Petiscos do Mar').position === 2, JSON.stringify(await catOrder(page)));
  check('admin: primeira não sobe', await page.locator('.catrow').first().locator('.iconbtn').first().evaluate(e => e.classList.contains('off')));

  // Excluir: com itens não deixa; vazia sai.
  await catRow(page, 'Bebidas').locator('[aria-label="Editar Bebidas"]').click(); await page.waitForTimeout(300);
  await catRow(page, 'Bebidas').getByText('Excluir', { exact: true }).click(); await page.waitForTimeout(300);
  check('admin: categoria com itens explica o que fazer e não apaga', (await catRow(page, 'Bebidas').innerText()).includes('Mude esses itens de categoria') && !calls(page, /^DELETE \/categories/).length);
  await catRow(page, 'Bebidas').getByText('Cancelar', { exact: true }).click(); await page.waitForTimeout(300);
  await catRow(page, 'Porções').locator('[aria-label="Editar Porções"]').click(); await page.waitForTimeout(300);
  await catRow(page, 'Porções').getByText('Excluir', { exact: true }).click(); await page.waitForTimeout(300);
  check('admin: pede confirmação antes de excluir', (await catRow(page, 'Porções').innerText()).includes('Excluir Porções?'));

  for (const [nome, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const btn = await page.locator('.catrow .iconbtn').first().boundingBox();
    check(`admin ${nome}: painel cabe sem rolagem lateral`, scroll <= 0, String(scroll));
    check(`admin ${nome}: botões de ordem com área de toque boa`, btn && btn.width >= 40 && btn.height >= 40, JSON.stringify(btn));
    if (SHOTS) { await page.locator('.catpanel').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/admin-categorias-${nome}.png`, fullPage: true }); }
  }
  await catRow(page, 'Porções').getByText('Sim, excluir').click(); await page.waitForTimeout(500);
  check('admin: exclui a categoria vazia', !page.api.db.categories.some(c => c.name === 'Porções') && !(await catOrder(page)).includes('Porções'));
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 3. Cliente vê o que o admin mudou: só abas com itens, na ordem nova.
await step('cliente vê categorias novas', async () => {
  const api = fakeApi('cliente');
  api.db.categories = [['Bebidas', 'mar'], ['Porções', 'verde'], ['Petiscos', 'sol'], ['Pratos', 'coral'], ['Sobremesas', 'uva'], ['Drinks', 'uva']]
    .map(([name, color], i) => ({ name, color, position: i + 1 }));
  api.db.products.find(p => p.id === 'p4').category = 'Porções';
  const page = await open('app-cliente.dc.html', { role: 'cliente', api });
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  check('cliente: abas seguem a ordem e escondem categoria vazia', JSON.stringify(await tabs(page)) === JSON.stringify(['Todos', 'Bebidas', 'Porções', 'Petiscos', 'Sobremesas']), JSON.stringify(await tabs(page)));
  await click(page, 'Porções', true);
  const t = await page.locator('.grid').innerText();
  check('cliente: aba nova filtra os itens', t.includes('Peixe Frito') && !t.includes('Batata Frita'));
  const tile = await page.locator('.pcard .pimg').first().getAttribute('style');
  check('cliente: cartão sem foto usa a cor da categoria', /#E5F7EA|229,\s*247,\s*234/i.test(tile || ''), tile);
  for (const [nome, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`cliente ${nome}: sem rolagem lateral`, scroll <= 0, String(scroll));
    if (SHOTS) { await click(page, 'Todos', true); await page.screenshot({ path: `${SHOTS}/cardapio-${nome}.png` }); await click(page, 'Porções', true); }
  }
  check('cliente: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
