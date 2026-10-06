// Teste do "esqueci minha senha" num navegador de verdade (Chromium), com a
// API respondida aqui mesmo: nada sai da máquina, nenhum e-mail é enviado.
// Uso: node tests/fluxo/senha.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

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

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.calls = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('http://localhost:8787/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    page.calls.push({ p, body });
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/auth/forgot-password') {
      if (body.email === 'ana@emial.com') return json(404, { error: 'Não encontramos uma conta com este e-mail. Confira se digitou certo ou crie uma conta.', code: 'email_not_found' });
      if (body.cpf === '11144477735') return json(404, { error: 'Não encontramos uma conta com este CPF. Confira os números ou crie uma conta.', code: 'cpf_not_found' });
      if (body.cpf) return json(200, { message: 'Enviamos um link de redefinição para a*a@email.com.', sentTo: 'a*a@email.com' });
      if (body.email === 'bia@gmail.com') return json(400, { error: 'Esta conta foi criada com o Google e não tem senha. Use o botão "Entrar com Google".', code: 'google_account' });
      return json(200, { message: 'ok' });
    }
    if (p === '/auth/update-password') return body.accessToken === 'tok-recuperacao'
      ? json(200, { message: 'Senha redefinida com sucesso.' })
      : json(401, { error: 'Link de redefinição inválido ou expirado.' });
    return json(200, {});
  });
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const click = async (page, t) => { await page.getByText(t).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

// 1. Pedir o link: tela "Recuperar senha" chama a API com o e-mail
await step('pedir link', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=login');
  await click(page, 'Esqueci minha senha');
  await page.getByPlaceholder('voce@email.com').last().fill('ana@email.com');
  await click(page, 'Enviar link');
  const call = page.calls.find(c => c.p === '/auth/forgot-password');
  check('pedir link: chama /auth/forgot-password com o e-mail', call?.body.email === 'ana@email.com', JSON.stringify(page.calls));
  check('pedir link: mostra "Link enviado"', (await text(page)).includes('Link enviado'));
  check('pedir link: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

// 1b. E-mail sem conta ou conta só do Google: avisa e deixa corrigir
await step('pedir link com e-mail errado', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=login');
  await click(page, 'Esqueci minha senha');
  const input = page.getByPlaceholder('voce@email.com').last();
  await input.fill('ana@emial.com');
  await click(page, 'Enviar link');
  let t = await text(page);
  check('e-mail errado: avisa que não tem conta', t.includes('Não encontramos uma conta com este e-mail'), t.slice(0, 300));
  check('e-mail errado: continua na tela para corrigir', !t.includes('Link enviado') && t.includes('Recuperar senha'));
  await input.fill('ana@email.co');
  t = await text(page);
  check('e-mail errado: aviso some ao digitar', !t.includes('Não encontramos uma conta'));
  await input.fill('bia@gmail.com');
  await click(page, 'Enviar link');
  t = await text(page);
  check('conta do Google: manda usar o botão do Google', t.includes('criada com o Google') && !t.includes('Link enviado'));
  await input.fill('ana@email.com');
  await click(page, 'Enviar link');
  check('depois de corrigir: mostra "Link enviado"', (await text(page)).includes('Link enviado'));
  check('e-mail errado: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

// 1c. Não lembra o e-mail: pede pelo CPF e vê o e-mail mascarado
await step('pedir link pelo CPF', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=login');
  await click(page, 'Esqueci minha senha');
  await page.getByText('CPF', { exact: true }).first().click(); await page.waitForTimeout(300);
  const input = page.getByPlaceholder('000.000.000-00').last();
  await input.fill('12345678900');
  let t = await text(page);
  check('CPF: avisa CPF inválido na hora', t.includes('CPF inválido'));
  await click(page, 'Enviar link');
  check('CPF: CPF inválido não chama a API', !page.calls.some(c => c.p === '/auth/forgot-password'));
  await input.fill('111.444.777-35');
  check('CPF: pontua enquanto digita', (await input.inputValue()) === '111.444.777-35', await input.inputValue());
  await click(page, 'Enviar link');
  t = await text(page);
  check('CPF sem conta: avisa e continua na tela', t.includes('Não encontramos uma conta com este CPF') && !t.includes('Link enviado'));
  await input.fill('529.982.247-25');
  await click(page, 'Enviar link');
  const call = page.calls.filter(c => c.p === '/auth/forgot-password').at(-1);
  check('CPF: manda só os dígitos, sem e-mail', call?.body.cpf === '52998224725' && !('email' in call.body), JSON.stringify(call?.body));
  t = await text(page);
  check('CPF: mostra o e-mail mascarado', t.includes('Link enviado') && t.includes('a*a@email.com'), t.slice(0, 400));
  check('CPF: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

// 1d. Tela de recuperar senha cabe no celular, tablet e computador
for (const [nome, width, height] of [['celular', 360, 740], ['tablet', 820, 1100], ['computador', 1366, 820]]) {
  await step(`responsivo ${nome}`, async () => {
    const page = await open('app-cliente.dc.html?module=cliente&screen=forgot');
    await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
    await page.getByText('CPF', { exact: true }).first().click(); await page.waitForTimeout(300);
    const sobra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`recuperar senha (${nome}): sem rolagem lateral`, sobra <= 0, `sobra ${sobra}px`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/recuperar-cpf-${nome}.png` });
    await page.close();
  });
}

const LINK = '#access_token=tok-recuperacao&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery';

// 2. Link do e-mail abre a tela de nova senha e troca a senha
await step('trocar senha', async () => {
  const page = await open('redefinir-senha.html' + LINK);
  check('nova senha: token sai da barra de endereço', !page.url().includes('access_token'), page.url());
  await page.getByPlaceholder('Mínimo 6 caracteres').fill('nova123');
  await page.getByPlaceholder('Repita a senha').fill('outra99');
  await page.getByText('Redefinir senha', { exact: true }).last().click(); await page.waitForTimeout(500);
  check('nova senha: senhas diferentes são recusadas', (await text(page)).includes('não conferem'));
  await page.getByPlaceholder('Repita a senha').fill('nova123');
  await page.getByText('Redefinir senha', { exact: true }).last().click(); await page.waitForTimeout(500);
  const call = page.calls.find(c => c.p === '/auth/update-password');
  check('nova senha: envia token + nova senha pra API', call?.body.accessToken === 'tok-recuperacao' && call?.body.newPassword === 'nova123', JSON.stringify(call?.body));
  check('nova senha: mostra sucesso', (await text(page)).includes('Senha redefinida com sucesso'));
  check('nova senha: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
});

// 3. Link expirado explica o que fazer e oferece pedir outro
await step('link expirado', async () => {
  const page = await open('redefinir-senha.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  const t = await text(page);
  check('link expirado: avisa que expirou', t.includes('expirou'), t.slice(0, 200));
  check('link expirado: botão pra pedir novo link', t.includes('Pedir um novo link'));
  await page.close();
});

// 4. Se o Supabase mandar o link pra página inicial ou pro app, vai pra tela de nova senha
for (const p of ['index.html', 'app-cliente.dc.html']) {
  await step(`desvio ${p}`, async () => {
    const page = await open(p + LINK);
    await page.waitForTimeout(800);
    check(`link caindo em ${p} vai pra redefinir-senha.html`, page.url().includes('redefinir-senha.html') && /nova senha/i.test(await text(page)), page.url());
    check(`link caindo em ${p} não faz login`, !page.calls.some(c => c.p === '/auth/me'));
    await page.close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
