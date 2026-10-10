// Teste das telas de conta do Sunfood num navegador de verdade (Chromium):
// cadastro, login com e-mail não confirmado, pedido mínimo, dia encerrado e
// excluir conta. API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/conta.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, kiosk, login } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
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
  api.db.calls = [];
  // Rotas de conta que a API falsa comum não tem.
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    if (p === '/auth/signup') return json(201, { requiresEmailConfirmation: true, message: 'ok' });
    if (p === '/auth/resend-confirmation') return json(200, { message: 'ok' });
    if (p === '/auth/delete-account') return json(200, { message: 'Conta excluída.' });
    if (p === '/auth/login' && login) return json(login.status, login.body);
    return api(route);
  });
  page.api = api;
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

const called = (page, p) => page.api.db.calls.filter(c => c.p === p);
async function login(page) {
  await page.getByPlaceholder('voce@email.com').first().fill('ana@email.com');
  await page.locator('input[type=password]').first().fill('senha');
  await click(page, 'Entrar', true);
}

// 1. Cadastro manda os dados certos e volta pro login pedindo confirmação
await step('cadastro', async () => {
  const page = await open('app-cliente.dc.html');
  await click(page, 'Cadastre-se');
  await page.getByPlaceholder('Ana Souza').fill('Ana Teste');
  await page.getByPlaceholder('voce@email.com').fill('ana@teste.com');
  await page.getByPlaceholder('(11) 91234-5678').fill('11 91234-5678');
  await page.getByPlaceholder('dd/mm/aaaa').fill('01/01/2000');
  await page.getByPlaceholder('Mínimo 6 caracteres').fill('senha123');
  await page.getByPlaceholder('Repita a senha').fill('senha123');
  await page.locator('input[type=checkbox]').check();
  const cpf = page.getByPlaceholder('000.000.000-00');
  await cpf.pressSequentially('12345678900');
  check('cadastro: pontua o CPF enquanto digita', await cpf.inputValue() === '123.456.789-00', await cpf.inputValue());
  check('cadastro: avisa na hora que o CPF é inválido', (await text(page)).includes('CPF inválido'));
  await click(page, 'Criar minha conta');
  check('cadastro: não envia com CPF inválido', called(page, '/auth/signup').length === 0);
  await cpf.fill('');
  await cpf.pressSequentially('52998224725');
  check('cadastro: CPF válido tira o aviso', !(await text(page)).includes('CPF inválido'));
  await click(page, 'Criar minha conta');
  const sent = called(page, '/auth/signup')[0]?.body;
  check('cadastro: envia nome, e-mail, telefone, CPF (só números), nascimento e aceite', sent && sent.name === 'Ana Teste' && sent.email === 'ana@teste.com'
    && sent.cpf === '52998224725' && sent.birthDate === '2000-01-01' && sent.termsAccepted === true, JSON.stringify(sent));
  const t = await text(page);
  check('cadastro: avisa para confirmar o e-mail', /confirme seu e-mail/i.test(t));
  check('cadastro: volta para o login', t.includes('Esqueci minha senha'));
  check('cadastro: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 2. Login com e-mail não confirmado mostra o aviso e o botão de reenviar
await step('e-mail não confirmado', async () => {
  const page = await open('app-cliente.dc.html', { login: { status: 403, body: { error: 'Confirme seu e-mail antes de entrar.', code: 'email_not_confirmed' } } });
  await login(page);
  let t = await text(page);
  check('login: mostra "Confirme seu e-mail"', t.includes('Confirme seu e-mail antes de entrar.'));
  check('login: não entra no cardápio', !t.includes('Batata Frita'));
  await click(page, 'Reenviar e-mail de confirmação');
  check('login: reenviar chama a API com o e-mail digitado', called(page, '/auth/resend-confirmation')[0]?.body?.email === 'ana@email.com');
  t = await text(page);
  check('login: avisa que reenviou', t.includes('novo link de confirmação'));
  check('login: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 3. Pedido mínimo configurado pelo admin trava o carrinho
await step('pedido mínimo', async () => {
  const page = await open('app-cliente.dc.html', { kiosk: { minOrder: 30 } });
  await login(page);
  await click(page, '+', true);
  await click(page, 'no carrinho');
  let t = await text(page);
  check('mínimo: carrinho avisa "Pedido mínimo de R$ 30,00"', t.includes('Pedido mínimo de R$ 30,00'));
  await click(page, 'Ir para pagamento');
  t = await text(page);
  check('mínimo: não deixa ir para a mesa', !t.includes('Confirmar mesa'));
  check('mínimo: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 4. Dia encerrado: cardápio avisa e não deixa fechar pedido
await step('dia encerrado', async () => {
  const page = await open('app-cliente.dc.html', { kiosk: { dayClosed: true } });
  await login(page);
  let t = await text(page);
  check('dia encerrado: cardápio mostra o aviso', t.includes('encerrou o dia'));
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Ir para pagamento');
  t = await text(page);
  check('dia encerrado: não deixa ir para a mesa', !t.includes('Confirmar mesa'));
  check('dia encerrado: nenhum pedido enviado', page.api.db.orders.length === 0);
  await page.close();
});

// 5. Excluir conta chama a API, apaga a sessão e volta pro login
await step('excluir conta', async () => {
  const page = await open('app-cliente.dc.html');
  await login(page);
  await click(page, 'Perfil');
  await click(page, 'Excluir minha conta');
  check('excluir: pede confirmação', (await text(page)).includes('Excluir sua conta?'));
  await click(page, 'Sim, excluir conta');
  const call = called(page, '/auth/delete-account')[0];
  check('excluir: chama a API com o token do cliente', call && call.auth === 'Bearer tok', JSON.stringify(call));
  const t = await text(page);
  check('excluir: volta para o login', t.includes('Esqueci minha senha'));
  check('excluir: apaga a sessão salva', await page.evaluate(() => localStorage.getItem('sunfood_session')) === null);
  check('excluir: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
