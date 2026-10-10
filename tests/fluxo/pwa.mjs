// Teste do app instalável (PWA): manifesto, ícones, service worker e modo
// sem internet, num Chromium de verdade. Nada sai da máquina.
// Uso: node tests/fluxo/pwa.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// "Sem internet" = servidor do site desligado.
let online = true;
// Servidor estático numa subpasta /sunfood/, igual ao GitHub Pages.
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    if (!online) return req.socket.destroy();
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith('/sunfood/')) throw 0;
    path = path.slice('/sunfood'.length);
    const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'text/html' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/sunfood/`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

// Perfil de verdade (não anônimo): o Chrome não oferece instalar em janela anônima.
const PROFILE = mkdtempSync(join(tmpdir(), 'sunfood-pwa-'));
const context = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 400, height: 860 }, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
// Sem acesso ao unpkg (rede bloqueada) usa a cópia local das bibliotecas.
if (CDN) await context.route('https://unpkg.com/**', r => {
  const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
  r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
});
await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
const page = context.pages()[0] || await context.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
const apiCalls = [];
await context.route('http://localhost:8787/**', r => { apiCalls.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });

await page.goto(BASE + 'index.html');
const cdp = await context.newCDPSession(page);

await step('manifesto é lido sem erro', async () => {
  const m = await cdp.send('Page.getAppManifest');
  check('manifesto é lido sem erro', m.errors.length === 0 && /manifest\.json$/.test(m.url), JSON.stringify(m.errors));
  const json = JSON.parse(m.data);
  check('manifesto: modo standalone', json.display === 'standalone');
  check('manifesto: tem ícones 192 e 512', ['192x192', '512x512'].every(s => json.icons.some(i => i.sizes === s && i.purpose === 'any')));
});

for (const icon of ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon.svg']) {
  await step(`ícone ${icon} existe`, async () => {
    const r = await page.request.get(BASE + 'icons/' + icon);
    check(`ícone ${icon} existe`, r.ok());
  });
}

await step('service worker controla a página', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const scope = await page.evaluate(async () => navigator.serviceWorker.controller && (await navigator.serviceWorker.ready).scope);
  check('service worker controla a página', scope === BASE, String(scope));
});

await step('Chrome considera o app instalável', async () => {
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  check('Chrome considera o app instalável', installabilityErrors.length === 0, JSON.stringify(installabilityErrors));
});

await step('chamadas da API não passam pelo cache', async () => {
  await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=menu');
  await page.waitForTimeout(1500);
  const cached = await page.evaluate(async () => (await caches.keys()).length && (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).map(r => r.url)))).flat());
  check('chamadas da API não passam pelo cache', apiCalls.length > 0 && !cached.some(u => u.includes(':8787') || u.includes('vercel.app') || u.includes('supabase')), `api=${apiCalls.length} cache=${cached.join(',')}`);
});

await step('sem internet: página já visitada abre do cache', async () => {
  online = false;
  await page.goto(BASE);
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  check('sem internet: página já visitada abre do cache', body.includes('Fome na praia?'), body.slice(0, 120));
});

await step('sem internet: página nunca visitada mostra aviso', async () => {
  await page.goto(BASE + 'termos.html');
  const body = await page.locator('body').innerText();
  check('sem internet: página nunca visitada mostra aviso', body.includes('sem internet'), body.slice(0, 120));
  online = true;
});

check('sem erro de JavaScript', jsErrors.length === 0, jsErrors.join(' | '));

await context.close();
rmSync(PROFILE, { recursive: true, force: true });
server.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} de ${results.length} checagens passaram.`);
process.exit(failed ? 1 : 0);
