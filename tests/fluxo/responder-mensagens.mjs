// Teste de responder o Fale conosco pela tela Mensagens do admin, num
// navegador de verdade (Chromium): e-mail sai pela API, telefone abre o
// WhatsApp com o texto pronto, e a resposta fica salva no cartão.
// API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/responder-mensagens.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) api.seed();
  if (kiosk) Object.assign(api.db.kiosk, kiosk);
  api.db.contacts = [
    { id: 'c1', protocol: 'SF-100001', name: 'Carla Souza', contact: 'carla@email.com', reason: 'Tirar dúvida sobre o cardápio', message: 'Vocês têm opção sem glúten?', status: 'novo', createdAt: new Date().toISOString() },
    { id: 'c2', protocol: 'SF-100002', name: 'Davi Reis', contact: '(13) 97777-6666', reason: 'Reservar mesa ou guarda-sol', message: 'Quero reservar uma mesa para 6 no sábado.', status: 'novo', createdAt: new Date().toISOString() },
  ];
  api.db.calls = [];
  // Registra cada chamada para conferir o que o app mandou.
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    return api(route);
  });
  page.api = api;
  // Guarda o que o app tentaria abrir (WhatsApp) em vez de abrir de verdade.
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  if (role && role !== 'cliente') await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

const replies = page => page.api.db.calls.filter(c => /^\/contact\/[^/]+\/reply$/.test(c.p));
const card = (page, nome) => page.locator('.card').filter({ hasText: nome }).last();
const URL_MSG = 'app-cliente.dc.html?module=admin&screen=messages';

await step('admin responde por e-mail', async () => {
  const page = await open(URL_MSG, { role: 'admin' });
  let t = await text(page);
  check('admin: botões Responder por e-mail e Responder no WhatsApp', t.includes('Responder por e-mail') && t.includes('Responder no WhatsApp'));

  // Sem a chave da Resend no servidor: avisa e não marca como respondida.
  page.api.db.emailOff = true;
  await card(page, 'Carla Souza').getByText('Responder por e-mail').click(); await page.waitForTimeout(300);
  t = await text(page);
  check('admin: diz para onde vai a resposta', t.includes('A resposta vai para carla@email.com'));
  await click(page, 'Enviar e-mail', true);
  t = await text(page);
  check('admin: pede texto antes de enviar', t.includes('Escreva a resposta antes de enviar.') && !replies(page).length);
  await card(page, 'Carla Souza').locator('textarea').fill('Temos sim!\nO pão sem glúten sai na hora.');
  await click(page, 'Enviar e-mail', true);
  t = await text(page);
  check('admin: e-mail não configurado aparece como erro', t.includes('ainda não foi configurado') && page.api.db.contacts[0].status === 'novo');
  page.api.db.emailOff = false;

  for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const c = card(page, 'Carla Souza');
    const ta = await c.locator('textarea').boundingBox();
    const btn = await c.locator('.btn', { hasText: 'Enviar e-mail' }).boundingBox();
    const cancel = await c.locator('.btn', { hasText: 'Cancelar' }).boundingBox();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const inside = b => b && b.x >= 0 && b.x + b.width <= viewport.width;
    check(`admin ${nome}: caixa de resposta e botões cabem na tela`, inside(ta) && inside(btn) && inside(cancel) && btn.height >= 40 && scroll <= 0, JSON.stringify({ ta, btn, scroll }));
    if (process.env.SHOTS) { await c.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/responder-${nome}.png` }); }
  }

  await click(page, 'Enviar e-mail', true); await page.waitForTimeout(300);
  const call = replies(page).at(-1);
  check('admin: chama POST /contact/c1/reply com o texto e o token', call && call.p === '/contact/c1/reply' && call.body.reply === 'Temos sim!\nO pão sem glúten sai na hora.' && call.auth === 'Bearer tok', JSON.stringify(call));
  t = await text(page);
  check('admin: avisa "Resposta enviada por e-mail."', t.includes('Resposta enviada por e-mail.'));
  check('admin: mensagem sai das Novas', !t.includes('Carla Souza') && t.includes('Novas (1)'));
  await click(page, 'Respondidas', true);
  t = await text(page);
  check('admin: resposta aparece salva no cartão', t.includes('Sua resposta · por e-mail') && t.includes('O pão sem glúten sai na hora.') && !(await card(page, 'Carla Souza').getByText('Responder por e-mail').count()));
  check('admin: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  if (process.env.SHOTS) for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.SHOTS}/respondida-${nome}.png` });
  }
  await page.close();
});

await step('admin responde no WhatsApp', async () => {
  const page = await open(URL_MSG, { role: 'admin', viewport: { width: 375, height: 800 } });
  await card(page, 'Davi Reis').getByText('Responder no WhatsApp').click(); await page.waitForTimeout(300);
  await card(page, 'Davi Reis').locator('textarea').fill('Reserva feita para sábado, mesa 4!');
  await click(page, 'Abrir WhatsApp e enviar', true); await page.waitForTimeout(300);
  const opened = await page.evaluate(() => window.__opened);
  check('admin: abre o WhatsApp do cliente com o texto pronto', opened.length === 1 && opened[0] === 'https://wa.me/5513977776666?text=' + encodeURIComponent('Reserva feita para sábado, mesa 4!'), JSON.stringify(opened));
  check('admin: registra a resposta na API', replies(page).length === 1 && replies(page)[0].p === '/contact/c2/reply');
  const t = await text(page);
  check('admin: avisa para enviar no WhatsApp', t.includes('Resposta registrada. Envie pelo WhatsApp que abriu.'));
  check('admin: sem erro de JavaScript (WhatsApp)', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
