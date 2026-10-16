// Teste de ingredientes e etiquetas no admin (Cardápio e estoque), num
// Chromium de verdade com a API falsa: marca etiquetas sugeridas, cria uma
// própria, preenche ingredientes, salva e confere no detalhe do produto.
// Uso: node tests/fluxo/etiquetas-produto.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, FAKE_PHOTO_BASE } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const SHOTS = process.env.SHOTS_DIR; // opcional: salva prints da tela em 3 tamanhos
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
const pfPanel = page => page.locator('.pf-dialog').first();

const api = fakeApi('admin');

await step('etiquetas: marcar, criar e salvar', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api });
  const form = pfPanel(page);
  // Caipirinha é o 3º item da lista (Editar índice 2 depois da ordem por categoria): procura pelo nome.
  await page.locator('.pgrid > *').filter({ hasText: 'Caipirinha' }).getByText('Editar').first().click(); await page.waitForTimeout(400);
  check('etiquetas: formulário tem Ingredientes e Etiquetas', (await form.innerText()).includes('Ingredientes') && (await form.innerText()).includes('Etiquetas'));
  check('etiquetas: edição abre com o nome do produto', (await page.getByPlaceholder('Nome do produto').inputValue()) === 'Caipirinha');
  await page.getByPlaceholder('Ex.: Cachaça, limão taiti, açúcar, gelo.').fill('Cachaça, limão taiti, açúcar, gelo.');
  await form.locator('.pf-tags .fpill', { hasText: /^Alcoólico$/ }).click();
  await form.locator('.pf-tags .fpill', { hasText: /^\+18$/ }).click();
  await form.locator('.pf-tags .fpill', { hasText: /^Gelado$/ }).click();
  await form.locator('.pf-tags .fpill', { hasText: /^Gelado$/ }).click(); // desmarca
  await page.getByPlaceholder('Outra etiqueta').fill('  Da casa ');
  await page.getByPlaceholder('Outra etiqueta').press('Enter'); await page.waitForTimeout(200);
  const on = await form.locator('.pf-tags .fpill.on').allInnerTexts();
  check('etiquetas: marcadas ficam destacadas (sem a desmarcada)', JSON.stringify(on) === JSON.stringify(['Alcoólico', '+18', 'Da casa']), JSON.stringify(on));
  check('etiquetas: campo de nova etiqueta limpa ao adicionar', (await page.getByPlaceholder('Outra etiqueta').inputValue()) === '');
  await click(page, 'Salvar produto', true);
  const b = api.db.lastProductBody;
  check('etiquetas: salvar manda os ingredientes', b.ingredients === 'Cachaça, limão taiti, açúcar, gelo.', JSON.stringify(b));
  check('etiquetas: salvar manda as etiquetas com cor', JSON.stringify(b.tags) === JSON.stringify([['Alcoólico', '#FDEBEA', '#E74C3C'], ['+18', '#FFF3DE', '#B0791A'], ['Da casa', '#EFEBFF', '#7C5CFF']]), JSON.stringify(b.tags));

  // Reabrir a edição traz o que foi salvo.
  await page.locator('.pgrid > *').filter({ hasText: 'Caipirinha' }).getByText('Editar').first().click(); await page.waitForTimeout(400);
  const on2 = await form.locator('.pf-tags .fpill.on').allInnerTexts();
  check('etiquetas: reabrir a edição mostra as etiquetas salvas', on2.length === 3 && on2.includes('Da casa'), JSON.stringify(on2));
  check('etiquetas: reabrir a edição mostra os ingredientes', (await page.getByPlaceholder('Ex.: Cachaça, limão taiti, açúcar, gelo.').inputValue()).startsWith('Cachaça'));
  // Limite de 8.
  for (const t of ['Feito na hora', 'Natural', 'Vegano', 'Vegetariano', 'Sem glúten', 'Picante'])
    await form.locator('.pf-tags .fpill', { hasText: new RegExp('^' + t + '$') }).click();
  check('etiquetas: não passa de 8', (await form.locator('.pf-tags .fpill.on').count()) === 8 && (await text(page)).includes('No máximo 8 etiquetas'));
  check('etiquetas: sem erro de JavaScript no admin', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

await step('etiquetas: aparecem no detalhe do produto', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { role: 'cliente', api });
  await page.getByText('Caipirinha', { exact: true }).first().click(); await page.waitForTimeout(500);
  const chips = await page.locator('.pd-chips').innerText();
  check('etiquetas: detalhe mostra as etiquetas', ['Alcoólico', '+18', 'Da casa'].every(t => chips.includes(t)), chips);
  check('etiquetas: detalhe mostra os ingredientes', (await page.locator('.pd-ingr').innerText()).includes('Cachaça, limão taiti'));
  check('etiquetas: sem erro de JavaScript no cardápio', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

for (const [nome, width] of [['celular', 390], ['tablet', 768], ['computador', 1280], ['tela-larga', 1920]]) {
  await step(`etiquetas: tela no ${nome}`, async () => {
    const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api, width });
    await page.getByText('+ Novo produto').first().click(); await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`etiquetas: sem rolagem lateral no ${nome}`, overflow <= 0, String(overflow));
    const box = await page.locator('.pf-tag-new').boundingBox();
    check(`etiquetas: campo de nova etiqueta cabe no ${nome}`, box && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    const pill = await page.locator('.pf-tags .fpill').first().boundingBox();
    check(`etiquetas: etiqueta com área de toque de 44px+ no ${nome}`, pill && pill.height >= 44, JSON.stringify(pill));
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.locator('.pf-tags').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `etiquetas-${nome}.png`) }); }
    await page.close();
  });
}

for (const [nome, width, height] of [['celular', 390, 844], ['computador', 1280, 720]]) {
  await step(`formulário: janela cabe na tela no ${nome}`, async () => {
    const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', width });
    await page.setViewportSize({ width, height });
    check(`formulário: fechado até tocar em Novo produto no ${nome}`, (await page.locator('.pf-dialog').count()) === 0);
    await page.getByText('+ Novo produto').first().click(); await page.waitForTimeout(400);
    const r = await page.evaluate(async () => {
      const d = document.querySelector('.pf-dialog').getBoundingClientRect();
      const salvar = [...document.querySelectorAll('.pf-dialog .btn')].find(e => e.textContent.trim() === 'Salvar produto').getBoundingClientRect();
      const body = document.querySelector('.pf-body'); body.scrollTop = body.scrollHeight; await new Promise(res => setTimeout(res, 200));
      const novo = document.querySelector('.pf-tag-new').getBoundingClientRect();
      return { cabe: d.top >= 0 && d.bottom <= innerHeight + 1 && d.right <= innerWidth, salvar: salvar.bottom <= innerHeight, fim: novo.bottom <= innerHeight };
    });
    check(`formulário: janela cabe na tela no ${nome}`, r.cabe, JSON.stringify(r));
    check(`formulário: Salvar produto à vista no ${nome}`, r.salvar, JSON.stringify(r));
    check(`formulário: fim do formulário alcançável rolando no ${nome}`, r.fim, JSON.stringify(r));
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
