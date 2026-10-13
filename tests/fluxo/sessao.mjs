// Sessão que não cai sozinha: o token do Supabase vence em 1 hora e o app
// precisa renovar sozinho (POST /auth/refresh), sem mandar o cliente para o
// login. Também confere que o app não abre na tela de login quem já entrou.
// Uso: node fluxo/sessao.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const file = path === '/' ? 'index.html' : path;
    const b = await readFile(join(ROOT, file)); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(b);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});

// JWT de mentira (só o "exp" importa para o app).
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (name, expSec) => b64({ alg: 'none' }) + '.' + b64({ sub: 'u1', exp: expSec, n: name }) + '.x';
const agora = () => Math.floor(Date.now() / 1000);

// API falsa que só aceita os tokens da lista "validos" e renova com /auth/refresh.
function apiComSessao(role, { refreshOk = true } = {}) {
  const base = fakeApi(role); base.seed();
  const st = { validos: new Set(), refreshes: [], negados: 0, n: 0 };
  const handler = async route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/auth/refresh') {
      const body = JSON.parse(req.postData() || '{}');
      st.refreshes.push(body.refreshToken);
      if (!refreshOk || body.refreshToken !== 'r' + st.n) return json(401, { error: 'Sessão expirada. Faça login novamente.' });
      st.n++; const token = jwt('t' + st.n, agora() + 3600); st.validos.add(token);
      return json(200, { token, refreshToken: 'r' + st.n });
    }
    if (p === '/auth/login') { const token = jwt('login', agora() + 3600); st.validos.add(token);
      return json(200, { token, refreshToken: 'r0', user: { id: 'u1', email: role + '@teste', name: 'Teste', role } }); }
    const auth = req.headers()['authorization'];
    if (auth && !st.validos.has(auth.replace(/^Bearer /, ''))) { st.negados++; return json(401, { error: 'Token inválido ou expirado.' }); }
    return base(route);
  };
  handler.st = st;
  return handler;
}

async function open(path, role, session, opts) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  const api = apiComSessao(role, opts); page.api = api;
  if (session && session.valid) api.st.validos.add(session.token);
  await page.route('http://localhost:8787/**', api);
  if (session) await page.addInitScript(([s, r]) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1');
    localStorage.setItem('sunfood_session', JSON.stringify({ token: s.token, refreshToken: s.refreshToken, user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); } }, [session, role]);
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
const text = p => p.locator('body').innerText();
const salvo = p => p.evaluate(() => JSON.parse(localStorage.getItem('sunfood_session') || 'null'));
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

await step('token vencido ao abrir', async () => {
  // Abriu o app depois de mais de 1 hora: renova antes de chamar a API.
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { token: jwt('velho', agora() - 60), refreshToken: 'r0' });
  const s = await salvo(p);
  check('token vencido: renova sozinho com o refreshToken', p.api.st.refreshes[0] === 'r0' && s && s.refreshToken === 'r1', JSON.stringify(p.api.st.refreshes));
  check('token vencido: continua no cardápio, sem voltar ao login', !(await text(p)).includes('Esqueci minha senha') && (await text(p)).includes('Batata Frita'));
  await p.getByText('Pedido', { exact: true }).first().click(); await p.waitForTimeout(600);
  check('token vencido: pedido em andamento carregado com o token novo', (await text(p)).includes('#o9'));
  check('token vencido: nenhum erro de JavaScript', p.jsErrors.length === 0, p.jsErrors.join(' | '));
  await p.context().close();
});

await step('401 no meio do uso', async () => {
  // Token que o servidor já não aceita (sem "exp" legível): 401 → renova → repete.
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { token: 'tok-recusado', refreshToken: 'r0' });
  check('401: renova e repete a chamada', p.api.st.negados >= 1 && p.api.st.refreshes.length === 1, `negados=${p.api.st.negados} refreshes=${p.api.st.refreshes.length}`);
  await p.getByText('Pedido', { exact: true }).first().click(); await p.waitForTimeout(600);
  check('401: cliente continua logado e vê o pedido', (await text(p)).includes('#o9'));
  await p.context().close();
});

await step('sessão acabou de vez', async () => {
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { token: jwt('velho', agora() - 60), refreshToken: 'r0' }, { refreshOk: false });
  await p.waitForTimeout(300);
  const t = await text(p);
  check('refresh recusado: volta ao login avisando que a sessão expirou', t.includes('Sua sessão expirou') && t.includes('Esqueci minha senha'), t.slice(0, 200));
  check('refresh recusado: apaga a sessão salva', (await salvo(p)) === null);
  await p.context().close();
});

await step('admin com token vencido', async () => {
  // A cozinha/admin fica com a tela aberta horas: a lista de pedidos não pode parar.
  const p = await open('app-cliente.dc.html?module=cozinha&screen=kanban', 'cozinha', { token: jwt('velho', agora() - 60), refreshToken: 'r0' });
  check('cozinha: renova o token e segue mostrando os pedidos', p.api.st.refreshes.length === 1 && (await text(p)).includes('#o9'), (await text(p)).slice(0, 200));
  await p.context().close();
});

await step('app sem rota na URL', async () => {
  // Volta do Google / "Voltar ao login" / celular recarregando: abre sem ?module=…
  const p = await open('app-cliente.dc.html', 'cliente', { token: jwt('ok', agora() + 3600), refreshToken: 'r0', valid: true });
  const t = await text(p);
  check('sem ?module na URL: quem já entrou vai ao cardápio, não ao login', !t.includes('Esqueci minha senha') && t.includes('Batata Frita'), t.slice(0, 200));
  await p.context().close();
});

await step('login guarda o refreshToken', async () => {
  const p = await open('index.html', 'cliente', null);
  await p.click('#com-email'); await p.fill('#email', 'cliente@teste'); await p.fill('#pass', 'x12345678');
  await p.click('#entrar'); await p.waitForTimeout(2000);
  const s = await salvo(p);
  check('login (index.html): guarda o refreshToken junto com o token', s && s.refreshToken === 'r0', JSON.stringify(s));
  await p.context().close();
  const q = await open('app-cliente.dc.html?module=cliente&screen=login', 'cliente', null);
  await q.locator('input[type=email]').first().fill('cliente@teste'); await q.locator('input[type=password]').first().fill('x12345678');
  await q.getByText('Entrar', { exact: true }).first().click(); await q.waitForTimeout(1200);
  const s2 = await salvo(q);
  check('login (app): guarda o refreshToken junto com o token', s2 && s2.refreshToken === 'r0', JSON.stringify(s2));
  await q.context().close();
});

await browser.close(); server.close();
const falhas = results.filter(r => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} ok`);
process.exit(falhas.length ? 1 : 0);
