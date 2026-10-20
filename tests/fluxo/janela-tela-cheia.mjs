// Janelas de tela cheia do admin num Chromium de verdade com a API falsa:
// no celular ocupam a altura toda (o zoom de 83% do app encolhia o 100dvh e
// sobrava uma faixa do fundo embaixo); nas telas maiores cabem centralizadas.
// Uso: node tests/fluxo/janela-tela-cheia.mjs   (a partir da raiz do repositório)
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

// Janelas de tela cheia do admin (novo/editar produto e categorias): no
// celular ocupam a altura toda da tela, sem faixa do fundo embaixo, mesmo com
// o zoom do app; do tablet para cima ficam centralizadas e cabem na tela.
const TELAS = [['celular', 390, 844], ['tablet', 820, 1180], ['computador', 1366, 768], ['tela larga', 1920, 1080]];
const JANELAS = [
  ['editar produto', async p => click(p, 'Editar')],
  ['novo produto', async p => click(p, '+ Novo produto')],
  ['categorias', async p => click(p, 'Categorias', true)],
];
for (const [nome, width, height] of TELAS) for (const [janela, abrir] of JANELAS) {
  await step(`${janela} no ${nome}`, async () => {
    const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', width });
    await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
    await abrir(page);
    const box = await page.locator('.pf-dialog').first().boundingBox();
    const acts = await page.locator('.pf-dialog .pf-actions, .pf-dialog .pf-btns').last().boundingBox();
    if (width < 768) check(`${janela}: ocupa a tela toda no ${nome}`, box && box.y <= 1 && Math.abs(box.y + box.height - height) <= 1 && Math.abs(box.width - width) <= 1, JSON.stringify(box));
    else check(`${janela}: cabe na tela no ${nome}`, box && box.y >= 0 && box.y + box.height <= height && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    check(`${janela}: botões visíveis no ${nome}`, acts && acts.y + acts.height <= height + 1, JSON.stringify(acts));
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `janela-${janela.replace(' ', '-')}-${nome.replace(' ', '-')}.png`) }); }
    check(`${janela}: sem erro de JS no ${nome}`, page.jsErrors.length === 0, page.jsErrors.join(' | '));
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
