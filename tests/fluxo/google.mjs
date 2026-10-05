// Teste do "Entrar com Google" num navegador de verdade (Chromium): ida ao
// Supabase, volta com o token, tela "Falta pouco" (telefone, CPF, nascimento e
// termos) e pedido recusado por cadastro incompleto. Supabase e API falsos:
// nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/google.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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

async function open(path, { me, orderRefused, saved, clientId = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // Escolhe o fluxo do Google: ID do cliente vazio = pelo Supabase (/authorize);
  // preenchido = direto no Google, trocando o id_token no Supabase.
  await page.route(/\/app-cliente\.dc\.html(\?.*)?$/, async r => {
    const html = await readFile(join(ROOT, 'app-cliente.dc.html'), 'utf8');
    r.fulfill({ contentType: 'text/html', body: html.replace(/const GOOGLE_CLIENT_ID = '[^']*';/, `const GOOGLE_CLIENT_ID = '${clientId}';`) });
  });
  // Google falso (fluxo direto): devolve um id_token no #fragmento.
  page.googleUrls = [];
  await page.route('https://accounts.google.com/**', route => {
    const u = new URL(route.request().url());
    page.googleUrls.push(u);
    const hash = page.googleCancels ? '#error=access_denied'
      : '#state=' + u.searchParams.get('state') + '&id_token=gid&authuser=0';
    route.fulfill({ status: 302, headers: { location: u.searchParams.get('redirect_uri') + hash } });
  });
  // Supabase + Google falsos: o /authorize devolve direto pro site com um
  // token no #fragmento, como o Supabase faz depois da tela do Google.
  page.authorizeUrls = [];
  page.tokenCalls = [];
  await page.route('https://gsbjffbbcxerucmvfjvh.supabase.co/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/auth/v1/token') {
      const body = JSON.parse(route.request().postData());
      page.tokenCalls.push({ url: u, body, apikey: route.request().headers()['apikey'] });
      const ok = body.provider === 'google' && body.id_token === 'gid' && !page.supabaseRefuses;
      return route.fulfill({ status: ok ? 200 : 400, contentType: 'application/json',
        body: JSON.stringify(ok ? { access_token: 'gtok', refresh_token: 'r1', token_type: 'bearer' } : { error: 'invalid' }) });
    }
    page.authorizeUrls.push(u.href);
    const back = u.searchParams.get('redirect_to');
    const hash = page.googleCancels ? '#error=access_denied&error_description=cancelado'
      : '#access_token=gtok&expires_in=3600&refresh_token=r1&token_type=bearer';
    route.fulfill({ status: 302, headers: { location: back + hash } });
  });
  const api = fakeApi('cliente');
  api.db.calls = [];
  const user = { id: 'g1', email: 'bia@gmail.com', name: 'Bia Google', role: 'cliente', profileComplete: false, ...me };
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    api.db.calls.push({ p, body, auth: req.headers()['authorization'] });
    if (p === '/auth/me') return json(200, { user });
    if (p === '/auth/complete-profile') { page.completed = true; Object.assign(user, { name: body.name, profileComplete: true }); return json(200, { user }); }
    if (p === '/orders' && req.method() === 'POST' && orderRefused && !page.completed)
      return json(403, { error: 'Complete seu cadastro.', code: 'profile_incomplete' });
    return api(route);
  });
  page.api = api;
  if (saved) await page.addInitScript(u => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'gtok', user: u })), { ...user, ...saved });
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const called = (page, p) => page.api.db.calls.filter(c => c.p === p);
const noErrors = async (name, page) => check(name + ': sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));

// 1. Primeiro acesso pelo Google: volta logado e pede telefone, nascimento e termos
await step('Google primeiro acesso', async () => {
  const page = await open('app-cliente.dc.html');
  await click(page, 'Entrar com Google');
  await page.waitForTimeout(1500);
  const auth = new URL(page.authorizeUrls[0] || 'http://x');
  check('Google: manda para o Supabase com provider=google', auth.pathname === '/auth/v1/authorize' && auth.searchParams.get('provider') === 'google', auth.href);
  check('Google: pede para voltar ao app', /app-cliente\.dc\.html$/.test(auth.searchParams.get('redirect_to') || ''), auth.href);
  check('Google: troca o token pelo perfil em /auth/me', called(page, '/auth/me')[0]?.auth === 'Bearer gtok');
  check('Google: tira o token da barra de endereço', !page.url().includes('access_token'), page.url());
  let t = await text(page);
  check('Google: mostra "Falta pouco" em vez do cardápio', t.includes('Falta pouco') && !t.includes('Batata Frita'));
  check('Google: nome já vem preenchido', await page.getByPlaceholder('Ana Souza').inputValue() === 'Bia Google');
  await page.getByPlaceholder('(11) 91234-5678').fill('11 98888-7777');
  await page.getByPlaceholder('000.000.000-00').fill('111.111.111-11');
  await page.locator('input[type=date]').fill('1999-05-05');
  await page.locator('input[type=checkbox]').check();
  await click(page, 'Salvar e continuar');
  t = await text(page);
  check('completar: recusa CPF inválido', t.includes('CPF inválido') && called(page, '/auth/complete-profile').length === 0);
  await page.getByPlaceholder('000.000.000-00').fill('111.444.777-35');
  await page.locator('input[type=date]').fill('2012-01-01');
  await page.locator('input[type=checkbox]').check();
  await click(page, 'Salvar e continuar');
  t = await text(page);
  check('completar: recusa menor de 18', t.includes('18 anos') && called(page, '/auth/complete-profile').length === 0);
  await page.locator('input[type=date]').fill('1999-05-05');
  await page.locator('input[type=checkbox]').uncheck();
  await click(page, 'Salvar e continuar');
  t = await text(page);
  check('completar: exige aceitar os termos', t.includes('aceitar os termos') && called(page, '/auth/complete-profile').length === 0);
  await page.locator('input[type=checkbox]').check();
  await click(page, 'Salvar e continuar');
  const sent = called(page, '/auth/complete-profile')[0];
  check('completar: envia nome, telefone, CPF, nascimento e aceite com o token', sent && sent.auth === 'Bearer gtok' && sent.body.name === 'Bia Google'
    && sent.body.phone === '11 98888-7777' && sent.body.cpf === '11144477735' && sent.body.birthDate === '1999-05-05' && sent.body.termsAccepted === true, JSON.stringify(sent));
  t = await text(page);
  check('completar: vai para o cardápio', t.includes('Batata Frita') && !t.includes('Falta pouco'));
  const savedUser = await page.evaluate(() => JSON.parse(localStorage.getItem('sunfood_session')).user);
  check('completar: sessão salva como completa', savedUser.profileComplete === true, JSON.stringify(savedUser));
  await noErrors('Google primeiro acesso', page);
  await page.close();
});

// 2. Quem já completou entra direto no cardápio
await step('Google cadastro completo', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=signup', { me: { profileComplete: true } });
  await click(page, 'Cadastrar com Google');
  await page.waitForTimeout(1500);
  const t = await text(page);
  check('Google completo: entra direto no cardápio', t.includes('Batata Frita') && !t.includes('Falta pouco'));
  await noErrors('Google completo', page);
  await page.close();
});

// 3. Cancelou na tela do Google: volta pro login com aviso
await step('Google cancelado', async () => {
  const p2 = await open('app-cliente.dc.html');
  p2.googleCancels = true;
  await click(p2, 'Entrar com Google');
  await p2.waitForTimeout(1500);
  const t = await text(p2);
  check('Google cancelado: avisa e fica no login', t.includes('Não foi possível entrar') && t.includes('Esqueci minha senha'));
  check('Google cancelado: não chama /auth/me', called(p2, '/auth/me').length === 0);
  check('Google cancelado: limpa o erro da barra de endereço', !p2.url().includes('error='), p2.url());
  await noErrors('Google cancelado', p2);
  await p2.close();
});

// 4. Sessão salva incompleta (fechou o app no meio) volta para completar
await step('sessão incompleta', async () => {
  const page = await open('app-cliente.dc.html', { saved: { profileComplete: false } });
  check('sessão incompleta: abre em "Falta pouco"', (await text(page)).includes('Falta pouco'));
  await noErrors('sessão incompleta', page);
  await page.close();
});

// 5. Servidor recusa o pedido por cadastro incompleto: leva para completar e volta ao carrinho
await step('pedido recusado', async () => {
  // /auth/me diz que está completo, mas o servidor recusa o pedido (ex.: conta antiga sem telefone ou sem CPF).
  const page = await open('app-cliente.dc.html', { me: { profileComplete: true }, orderRefused: true });
  await click(page, 'Entrar com Google');
  await page.waitForTimeout(1500);
  page.api.db.calls.length = 0;
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Ir para pagamento');
  await page.getByPlaceholder('00').fill('1');
  await click(page, 'Confirmar mesa');
  await click(page, 'Pagar na entrega', true);
  await click(page, 'Fazer pedido');
  let t = await text(page);
  check('pedido recusado: leva para "Falta pouco"', t.includes('Falta pouco'), t.slice(0, 200));
  await page.getByPlaceholder('(11) 91234-5678').fill('11 98888-7777');
  await page.getByPlaceholder('000.000.000-00').fill('529.982.247-25');
  await page.locator('input[type=date]').fill('1999-05-05');
  await page.locator('input[type=checkbox]').check();
  await click(page, 'Salvar e continuar');
  t = await text(page);
  check('pedido recusado: depois de completar volta ao carrinho com os itens', t.includes('Meu Carrinho') && t.includes('Batata Frita'), t.slice(0, 200));
  check('pedido recusado: nenhum pedido criado antes de completar', page.api.db.orders.length === 0);
  await noErrors('pedido recusado', page);
  await page.close();
});

// 6. Botão do Google também na página inicial (janela "Entrar" do site)
await step('Google na página inicial', async () => {
  const page = await open('index.html');
  await click(page, 'Entrar', true);
  await click(page, 'Entrar ou criar conta com Google');
  await page.waitForTimeout(2000);
  const auth = new URL(page.authorizeUrls[0] || 'http://x');
  check('página inicial: botão do Google manda para o Supabase', auth.searchParams.get('provider') === 'google', auth.href);
  check('página inicial: volta para o app do cliente', /\/app-cliente\.dc\.html$/.test(auth.searchParams.get('redirect_to') || ''), auth.href);
  check('página inicial: abre "Falta pouco" no app', (await text(page)).includes('Falta pouco'));
  await noErrors('página inicial', page);
  await page.close();
});

// 7. Fluxo direto no Google (com ID do cliente): a tela do Google mostra o
// domínio do site, e o id_token é trocado por uma sessão no Supabase.
const sha256 = t => createHash('sha256').update(t).digest('hex');
await step('Google direto', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=login', { clientId: 'cid.apps.googleusercontent.com' });
  await click(page, 'Entrar com Google');
  await page.waitForTimeout(1500);
  const g = page.googleUrls[0] || new URL('http://x');
  check('direto: vai ao Google, não ao /authorize do Supabase', g.hostname === 'accounts.google.com' && page.authorizeUrls.length === 0, g.href);
  check('direto: pede id_token com o ID do cliente', g.searchParams.get('response_type') === 'id_token' && g.searchParams.get('client_id') === 'cid.apps.googleusercontent.com');
  check('direto: volta para a própria página, sem ?parâmetros', /^http:\/\/localhost:\d+\/app-cliente\.dc\.html$/.test(g.searchParams.get('redirect_uri') || ''), g.searchParams.get('redirect_uri'));
  const tc = page.tokenCalls[0];
  check('direto: troca o id_token no Supabase com a chave publicável', tc && tc.url.searchParams.get('grant_type') === 'id_token' && /^sb_publishable_/.test(tc.apikey || ''), JSON.stringify(tc?.body));
  check('direto: Google recebe o nonce em hash e o Supabase o original', tc && sha256(tc.body.nonce) === g.searchParams.get('nonce'));
  check('direto: usa a sessão em /auth/me', called(page, '/auth/me')[0]?.auth === 'Bearer gtok');
  check('direto: tira o token e devolve os ?parâmetros na barra de endereço', !page.url().includes('id_token') && page.url().endsWith('?module=cliente&screen=login'), page.url());
  check('direto: mostra "Falta pouco"', (await text(page)).includes('Falta pouco'));
  await noErrors('Google direto', page);
  await page.close();
});

await step('Google direto cancelado', async () => {
  const page = await open('app-cliente.dc.html', { clientId: 'cid' });
  page.googleCancels = true;
  await click(page, 'Entrar com Google');
  await page.waitForTimeout(1500);
  const t = await text(page);
  check('direto cancelado: avisa e fica no login', t.includes('Não foi possível entrar') && t.includes('Esqueci minha senha'));
  check('direto cancelado: não troca token', page.tokenCalls.length === 0 && called(page, '/auth/me').length === 0);
  await noErrors('Google direto cancelado', page);
  await page.close();
});

await step('Google direto recusado pelo Supabase', async () => {
  const page = await open('app-cliente.dc.html', { clientId: 'cid' });
  page.supabaseRefuses = true;
  await click(page, 'Entrar com Google');
  await page.waitForTimeout(1500);
  const t = await text(page);
  check('direto recusado: avisa e fica no login', t.includes('Não foi possível entrar com Google') && t.includes('Esqueci minha senha'));
  check('direto recusado: não chama /auth/me', called(page, '/auth/me').length === 0);
  await noErrors('Google direto recusado', page);
  await page.close();
});

await step('Google direto pela página inicial', async () => {
  const page = await open('index.html', { clientId: 'cid' });
  await click(page, 'Entrar', true);
  await click(page, 'Entrar ou criar conta com Google');
  await page.waitForTimeout(2500);
  check('página inicial direto: vai ao Google', page.googleUrls.length === 1 && page.authorizeUrls.length === 0);
  check('página inicial direto: abre "Falta pouco" no app', (await text(page)).includes('Falta pouco'));
  check('página inicial direto: tira o ?google=1 da URL', !page.url().includes('google='), page.url());
  await noErrors('página inicial direto', page);
  await page.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
