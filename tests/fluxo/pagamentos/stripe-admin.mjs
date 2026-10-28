// Teste da aba Stripe do painel admin num navegador de verdade (Chromium): o
// admin vê a conta conectada (sem a chave secreta), cola as chaves, salva,
// troca e desconecta. Confere também que a tela cabe no celular, tablet,
// computador e tela larga. API falsa em memória: nada sai da máquina.
// Uso: node fluxo/pagamentos/stripe-admin.mjs   (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

async function open(path, { role, viewport, stripeCfg } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  api.db.calls = [];
    await page.route('http://localhost:8787/**', route => api(route));
  // Aba Stripe (GET/PUT/DELETE /admin/stripe), como a API de verdade.
  const cfg = stripeCfg || { source: 'ambiente', configured: true, mode: 'test', secretKeyHint: 'sk_test_…a1b2', publishableKey: 'pk_test_51Abcdefghijklmn',
    webhook: { configured: true, url: 'https://api.teste/payments/stripe/webhook' }, account: { id: 'acct_1Teste', name: 'Quiosque SunFood' }, connection: { ok: true }, updatedAt: null, updatedBy: null };
  await page.route('http://localhost:8787/admin/stripe', route => {
    const req = route.request();
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p: '/admin/stripe', m: req.method(), body, auth: req.headers()['authorization'] });
    if (req.method() === 'GET') return json(200, cfg);
    if (req.method() === 'PUT') {
      if (body.secretKey.includes('recusada')) return json(400, { error: 'O Stripe recusou a chave secreta. Confira se copiou a chave inteira.' });
      const live = body.secretKey.startsWith('sk_live_');
      Object.assign(cfg, { source: 'painel', configured: true, mode: live ? 'live' : 'test', secretKeyHint: body.secretKey.slice(0, 8) + '…' + body.secretKey.slice(-4),
        publishableKey: body.publishableKey, account: { id: 'acct_2Novo', name: 'SunFood Ltda' }, updatedAt: new Date().toISOString(), updatedBy: 'Teste' });
      return json(200, { ok: true, account: cfg.account, mode: cfg.mode });
    }
    if (req.method() === 'DELETE') { Object.assign(cfg, { source: 'nenhum', configured: false, mode: null, secretKeyHint: null, publishableKey: null, account: null, connection: null, webhook: { configured: false } }); return json(200, { ok: true }); }
  });
  page.api = api;
  if (role) await page.addInitScript(r => { try { localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); } catch (e) {} }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const calls = (page, m) => page.api.db.calls.filter(c => c.p === '/admin/stripe' && c.m === m);
const VIEWS = [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]];
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

await step('aba stripe', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=stripe', { role: 'admin' });
  const t = await text(page);
  check('menu do admin tem a aba Stripe', await page.locator('.adm-item', { hasText: 'Stripe' }).count() > 0);
  check('mostra a conta, o modo teste e a chave mascarada', t.includes('Quiosque SunFood') && t.includes('Modo teste') && t.includes('sk_test_…a1b2'), t.slice(0, 600));
  check('diz que a configuração vem da Vercel', t.includes('variáveis do servidor'));
  check('sem botão Desconectar quando vem da Vercel', !(await page.getByText('Desconectar', { exact: true }).count()));
  check('campo da chave secreta é de senha', await page.locator('#sxSkInp').getAttribute('type') === 'password');

  for (const [nome, viewport] of VIEWS) {
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    const boxes = await Promise.all(['#sxPkInp', '#sxSkInp'].map(s => page.locator(s).boundingBox()));
    const h = boxes[0] && boxes[0].height;
    const want = viewport.width < 1025 ? [47, 49] : [43, 45];
    check(`${nome}: campos cabem na tela, sem rolagem lateral`, boxes.every(b => b && b.width >= 200 && b.x + b.width <= viewport.width) && await noScroll(page), JSON.stringify(boxes));
    check(`${nome}: campo com altura do design system (${want.join('-')}px)`, h >= want[0] && h <= want[1], String(h));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-stripe-${nome}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1366, height: 900 });

  await click(page, 'Salvar e conectar', true);
  check('chave errada é recusada sem chamar a API', (await text(page)).includes('pk_test_ ou pk_live_') && !calls(page, 'PUT').length);
  await page.locator('#sxPkInp').fill('pk_test_51Abcdefghijklmn');
  await page.locator('#sxSkInp').fill('sk_test_recusadaABCDEF');
  await click(page, 'Salvar e conectar', true);
  check('erro do Stripe aparece', (await text(page)).includes('recusou a chave secreta'));
  await page.locator('#sxSkInp').fill('sk_live_51NovaChave1234');
  await page.locator('#sxPkInp').fill('pk_live_51NovaChave1234');
  await page.waitForTimeout(300);
  check('avisa que chave de produção cobra de verdade', (await text(page)).includes('os clientes pagam de verdade'));
  await click(page, 'Salvar e conectar', true);
  await page.waitForTimeout(500);
  const put = calls(page, 'PUT').at(-1);
  check('envia as duas chaves com o token', put && put.body.secretKey === 'sk_live_51NovaChave1234' && put.body.publishableKey === 'pk_live_51NovaChave1234' && put.auth === 'Bearer tok', JSON.stringify(put));
  const t2 = await text(page);
  check('confirma a conta conectada e mostra Produção', t2.includes('SunFood Ltda conectada') && t2.includes('Produção') && t2.includes('Recebendo pagamentos de verdade'), t2.slice(0, 800));
  check('campos são limpos depois de salvar', await page.locator('#sxSkInp').inputValue() === '');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-stripe-producao.png`, fullPage: true });

  await click(page, 'Desconectar', true);
  check('pede confirmação antes de desconectar', (await text(page)).includes('Desconectar esta conta?') && !calls(page, 'DELETE').length);
  await page.locator('.sf-dialog .btn-danger').click(); await page.waitForTimeout(800);
  check('desconecta e mostra "Não conectado"', calls(page, 'DELETE').length === 1 && (await text(page)).includes('Não conectado'));
  check('sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await step('quiosque e mesas sem o card de pagamentos online', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=tables', { role: 'admin' });
  const t = await text(page);
  check('"Quiosque e mesas" não mostra mais o card de pagamentos online', t.includes('Recebendo pedidos') && !t.includes('Pagamentos online') && !t.includes('configurar na aba Stripe') && !t.includes('4242'), t.slice(0, 300));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
