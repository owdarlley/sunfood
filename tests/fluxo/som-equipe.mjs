// Teste do som da equipe (Cozinha e Garçom) num navegador de verdade: o som
// vem ligado, a escolha fica salva no aparelho (sobrevive a recarregar/entrar
// de novo) e o primeiro toque na tela libera o áudio sozinho.
// Uso: node tests/fluxo/som-equipe.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, viewport, init } = {}) {
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
  if (init) await page.addInitScript(init);
  if (role && role !== 'cliente') await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const BANNER = 'O som de novos pedidos está desligado';
const fakeAudio = () => {
  window.__beeps = 0; window.__resumes = 0;
  window.AudioContext = class { constructor(){ this.currentTime = 0; this.destination = {}; this.state = 'suspended'; }
    resume(){ window.__resumes++; this.state = 'running'; return Promise.resolve(); }
    createBuffer(){ return {}; }
    createBufferSource(){ return { connect(){}, start(){} }; }
    createOscillator(){ window.__beeps++; return { frequency: {}, connect(){}, start(){}, stop(){} }; }
    createGain(){ return { gain: { setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){}, disconnect(){} }; }
    createDelay(){ return { delayTime: {}, connect(){}, disconnect(){} }; } };
};
const KZ = 'app-cliente.dc.html?module=cozinha&screen=kanban';
const DESK = { width: 1280, height: 860 };

await step('cozinha: som ligado por padrão e salvo no aparelho', async () => {
  const page = await open(KZ, { role: 'cozinha', viewport: DESK, init: fakeAudio });
  let t = await text(page);
  check('cozinha: entra com o som ligado', !t.includes(BANNER) && t.includes('Som ligado'));
  await page.mouse.click(640, 400); await page.waitForTimeout(300);
  check('cozinha: primeiro toque libera o áudio', await page.evaluate(() => window.__resumes) > 0);
  await page.getByText('Som ligado', { exact: true }).first().click(); await page.waitForTimeout(400);
  t = await text(page);
  check('cozinha: desligar mostra o aviso', t.includes(BANNER) && t.includes('Som desligado'));
  await page.reload(); await page.waitForTimeout(1200);
  t = await text(page);
  check('cozinha: desligado continua desligado ao entrar de novo', t.includes(BANNER));
  await page.getByText('Ativar som', { exact: true }).first().click(); await page.waitForTimeout(400);
  check('cozinha: ativar toca o aviso', await page.evaluate(() => window.__beeps) > 0);
  await page.reload(); await page.waitForTimeout(1200);
  t = await text(page);
  check('cozinha: ligado continua ligado ao entrar de novo', !t.includes(BANNER) && t.includes('Som ligado'));
  check('cozinha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
