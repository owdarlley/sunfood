// Teste da foto do produto no admin (Cardápio e estoque), num Chromium de
// verdade com a API falsa: escolhe foto, confere que foi reduzida antes de
// enviar, salva, aparece no cardápio do cliente e pode ser removida.
// Uso: node tests/fluxo/foto-produto.mjs   (a partir da raiz do repositório)
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
const previewStyle = page => page.evaluate(() => document.querySelector('.pf-photo [role=img]')?.getAttribute('style') || '');

// Foto "de celular": PNG de 3000 x 2000 (gradiente com quadradinhos
// coloridos), bem maior que o que deve ser enviado.
async function bigPhoto(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 3000, 2000); g.addColorStop(0, '#FFB21E'); g.addColorStop(1, '#0B6670');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 3000, 2000);
    for (let i = 0; i < 4000; i++) { ctx.fillStyle = `hsl(${i % 360},70%,50%)`; ctx.fillRect((i * 7919) % 3000, (i * 104729) % 2000, 24, 24); }
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

const api = fakeApi('admin');

await step('foto: enviar e salvar', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api });
  check('foto: formulário mostra "Adicionar foto"', (await text(page)).includes('Adicionar foto'));
  await page.getByText('Editar').first().click(); await page.waitForTimeout(400);
  const png = await bigPhoto(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.body.innerText.includes('Foto pronta'), null, { timeout: 15000 });
  const up = api.db.uploads[0];
  check('foto: foi convertida para JPEG menor antes de enviar', up.type === 'image/jpeg' && up.jpeg && up.size < Math.min(png.length, 1.8 * 1024 * 1024), JSON.stringify(up) + ' png=' + png.length);
  check('foto: prévia mostra a foto enviada', (await previewStyle(page)).includes(FAKE_PHOTO_BASE + 'foto1.jpg'));
  check('foto: botão vira "Trocar foto"', (await text(page)).includes('Trocar foto'));
  await click(page, 'Salvar produto', true);
  await page.waitForTimeout(400);
  check('foto: salvar manda o endereço da foto', api.db.lastProductBody.imageUrl === FAKE_PHOTO_BASE + 'foto1.jpg', JSON.stringify(api.db.lastProductBody));
  const thumb = await page.evaluate(u => [...document.querySelectorAll('.pgrid span[aria-hidden]')].some(s => (s.getAttribute('style') || '').includes(u)), FAKE_PHOTO_BASE + 'foto1.jpg');
  check('foto: lista do admin mostra a miniatura', thumb);

  await page.getByText('Editar').first().click(); await page.waitForTimeout(400);
  await page.locator('[placeholder="Ex.: 24.90"]').fill('26');
  await click(page, 'Salvar produto', true);
  check('foto: editar outra coisa não mexe na foto', !('imageUrl' in api.db.lastProductBody), JSON.stringify(api.db.lastProductBody));

  await page.locator('input[type=file]').setInputFiles({ name: 'nota.txt', mimeType: 'text/plain', buffer: Buffer.from('oi') });
  await page.waitForTimeout(300);
  check('foto: recusa arquivo que não é imagem', (await text(page)).includes('Escolha um arquivo de imagem'));
  check('foto: sem erro de JavaScript no admin', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

await step('foto: aparece no cardápio', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { role: 'cliente', api });
  const used = await page.evaluate(u => [...document.querySelectorAll('[style]')].some(e => e.getAttribute('style').includes(u)), FAKE_PHOTO_BASE + 'foto1.jpg');
  check('foto: cardápio do cliente usa a foto enviada', used);
  check('foto: sem erro de JavaScript no cardápio', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

await step('foto: remover', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api });
  await page.getByText('Editar').first().click(); await page.waitForTimeout(400);
  await click(page, 'Remover', true);
  check('foto: depois de remover volta a "Adicionar foto"', (await text(page)).includes('Adicionar foto'));
  await click(page, 'Salvar produto', true);
  check('foto: salvar depois de remover manda imageUrl null', api.db.lastProductBody.imageUrl === null, JSON.stringify(api.db.lastProductBody));
  await page.close();
});

await step('foto: produto novo com foto', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api });
  await page.getByPlaceholder('Nome do produto').fill('Pastel de Queijo');
  await page.locator('[placeholder="Ex.: 24.90"]').fill('15');
  await page.locator('input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: await bigPhoto(page) });
  await page.waitForFunction(() => document.body.innerText.includes('Foto pronta'), null, { timeout: 15000 });
  await click(page, 'Salvar produto', true);
  check('foto: produto novo é criado com a foto', api.db.lastProductBody.imageUrl === FAKE_PHOTO_BASE + 'foto2.jpg' && (await text(page)).includes('Produto criado'), JSON.stringify(api.db.lastProductBody));
  await page.close();
});

// Formulário com foto em celular, tablet e computador: nada sai da tela.
for (const [nome, width] of [['celular', 390], ['tablet', 768], ['computador', 1280]]) {
  await step(`foto: tela no ${nome}`, async () => {
    const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', api, width });
    await page.getByText('Editar').nth(1).click(); await page.waitForTimeout(300);
    await page.locator('input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: await bigPhoto(page) });
    await page.waitForFunction(() => document.body.innerText.includes('Foto pronta'), null, { timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`foto: sem rolagem lateral no ${nome}`, overflow <= 0, String(overflow));
    const box = await page.locator('.pf-photo').boundingBox();
    check(`foto: prévia cabe na tela no ${nome}`, box && box.width > 150 && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.locator('.pf-photo').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `foto-produto-${nome}.png`) }); }
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
