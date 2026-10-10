// Teste da tela Perfil do cliente num navegador de verdade (Chromium): editar
// nome/telefone/nascimento, foto enviada e avatar pronto, trocar senha, avisos
// do pedido pronto (notificação e som) e o botão de teste "modo sem conexão"
// fora do perfil. Celular, tablet e computador, sem rolagem para os lados.
// API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/perfil.mjs   (a partir da raiz do repositório)
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

async function open(screen, { width = 400, height = 860, setup, prefs = {} } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: 'block' });
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('https://teste.supabase.co/**', r => r.fulfill({ path: join(ROOT, 'icons', 'icon-192.png'), contentType: 'image/png' }));
  const api = fakeApi('cliente');
  api.user.name = 'Ana Souza'; api.user.email = 'ana@email.com'; api.user.profileComplete = true;
  if (setup) setup(api);
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  // Conta o som e a vibração do aviso de pedido pronto.
  await page.addInitScript(() => {
    window.__beeps = 0; window.__vibrations = 0;
    window.AudioContext = class { constructor(){ this.currentTime = 0; this.destination = {}; }
      createOscillator(){ window.__beeps++; return { frequency: {}, connect(){}, start(){}, stop(){} }; }
      createGain(){ return { gain: { setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; } };
    navigator.vibrate = () => { window.__vibrations++; return true; };
  });
  await page.addInitScript(u => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: u })),
    { id: 'u1', email: 'ana@email.com', name: 'Ana Souza', role: 'cliente', profileComplete: true, ...prefs });
  await page.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=' + screen);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const pressBtn = async (page, t) => { await page.locator('.btn', { hasText: t }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const patches = page => page.api.db.log.filter(l => l === 'PATCH /auth/profile').length;
const noErrors = async (name, page) => check(name + ': sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));

// 1. Perfil: novas opções, sem o botão de teste, avisos ligam e desligam
await step('perfil', async () => {
  const page = await open('profile');
  const t = await text(page);
  check('perfil: sem "Simular modo sem conexão"', !t.includes('Simular modo sem conexão'));
  check('perfil: mostra Editar perfil, Trocar senha e Avisos', t.includes('Editar perfil e foto') && t.includes('Trocar senha') && t.includes('Avisos do pedido'));
  check('perfil: iniciais quando não tem foto', t.includes('AS'));
  const sw = page.locator('[aria-label="Tocar som"]');
  await sw.click(); await page.waitForTimeout(400);
  check('avisos: desligar o som salva no servidor', page.api.user.soundOn === false && await sw.getAttribute('aria-checked') === 'false');
  await page.locator('[aria-label="Avisar quando ficar pronto"]').click(); await page.waitForTimeout(400);
  check('avisos: desligar o aviso de pronto salva no servidor', page.api.user.notifyReady === false);
  await noErrors('perfil', page);
  await page.close();
});

// 2. Editar perfil: formulário preenchido, e-mail/CPF travados, salvar
await step('editar', async () => {
  const page = await open('profile');
  await click(page, 'Editar perfil e foto');
  const nome = page.getByPlaceholder('Seu nome');
  check('editar: nome já preenchido', await nome.inputValue() === 'Ana Souza');
  check('editar: telefone já preenchido', await page.getByPlaceholder('(11) 91234-5678').inputValue() === '11999999999');
  check('editar: e-mail e CPF travados', await page.locator('input[disabled]').count() === 2 && (await text(page)).includes('E-mail e CPF não mudam'));
  check('editar: CPF mascarado', await page.locator('input[disabled]').nth(1).inputValue() === '529.***.***-25');
  await page.getByPlaceholder('dd/mm/aaaa').fill('01/01/2015');
  await pressBtn(page, 'Salvar');
  check('editar: recusa menor de 18', (await text(page)).includes('18 anos'));
  await page.getByPlaceholder('dd/mm/aaaa').fill('10/05/1999');
  await nome.fill('Ana Maria Souza');
  await page.getByPlaceholder('(11) 91234-5678').fill('11 98888-7777');
  await pressBtn(page, 'Salvar');
  check('editar: envia nome, telefone e nascimento', page.api.user.name === 'Ana Maria Souza' && page.api.db.profile.phone === '11 98888-7777' && page.api.db.profile.birthDate === '1999-05-10');
  const t = await text(page);
  check('editar: volta ao perfil com o nome novo', t.includes('Olá, Ana') && t.includes('Ana Maria Souza') && t.includes('Perfil salvo'));
  await noErrors('editar', page);
  await page.close();
});

// 3. Foto: avatar pronto e foto enviada (reduzida para JPEG), tirar foto
await step('foto', async () => {
  const page = await open('editProfile');
  await page.locator('[aria-label="Coco"]').click(); await page.waitForTimeout(500);
  check('avatar: escolher o Coco salva', page.api.user.avatarPreset === 'coco');
  // O avatar pronto é um desenho de traço (imagem de fundo), não mais um emoji.
  check('avatar: aparece no lugar das iniciais', await page.evaluate(() => [...document.querySelectorAll('[style*="data:image/svg+xml"]')]
    .some(e => !e.classList.contains('avatar-opt') && e.getBoundingClientRect().width >= 56)));
  await page.locator('input[type=file]').setInputFiles(join(ROOT, 'icons', 'icon-512.png'));
  await page.waitForTimeout(1200);
  const up = page.api.db.avatarUpload;
  check('foto: envia como JPEG', up && up.type === 'image/jpeg' && up.body[0] === 0xff && up.body[1] === 0xd8, up && up.type);
  check('foto: reduzida (bem menor que 2 MB)', up && up.body.length < 200 * 1024, up && String(up.body.length));
  const bg = await page.locator('.avatar-head > span').first().evaluate(e => getComputedStyle(e).backgroundImage);
  check('foto: aparece no perfil', bg.includes('avatares/foto.jpg'), bg);
  await click(page, 'Tirar foto', true);
  check('foto: tirar foto volta às iniciais', page.api.user.avatarUrl === null && (await text(page)).includes('AS'));
  await noErrors('foto', page);
  await page.close();
});

// 4. Trocar senha
await step('senha', async () => {
  const page = await open('changePassword');
  const [atual, nova, repete] = [0, 1, 2].map(i => page.locator('input[type=password]').nth(i));
  await atual.fill('chute'); await nova.fill('nova-senha'); await repete.fill('outra-senha');
  await pressBtn(page, 'Trocar senha');
  check('senha: avisa quando as novas não batem', (await text(page)).includes('não são iguais'));
  await repete.fill('nova-senha');
  await pressBtn(page, 'Trocar senha');
  check('senha: avisa senha atual errada', (await text(page)).includes('Senha atual incorreta'));
  await atual.fill('senha-atual');
  await pressBtn(page, 'Trocar senha');
  check('senha: troca e volta ao perfil', page.api.db.newPassword === 'nova-senha' && (await text(page)).includes('Senha alterada'));
  await click(page, 'Trocar senha');
  await click(page, 'Esqueci minha senha atual');
  check('senha: esqueci manda link pro e-mail da conta', page.api.db.resetFor === 'ana@email.com');
  await noErrors('senha', page);
  await page.close();
});

// 5. Conta do Google não tem "Trocar senha"
await step('google', async () => {
  const page = await open('profile', { setup: api => { api.db.profile.hasPassword = false; } });
  await page.waitForTimeout(400);
  check('google: sem "Trocar senha"', !(await text(page)).includes('Trocar senha'));
  await page.close();
});

// 6. Pedido pronto: aviso com vibração e som, respeitando o perfil
for (const [nome, prefs, vib, som] of [['ligados', {}, true, true], ['desligados', { notifyReady: false, soundOn: false }, false, false]]) {
  await step('pronto ' + nome, async () => {
    const page = await open('status', { prefs, setup: api => { Object.assign(api.user, prefs); api.seed(); api.db.orders[0].status = 'Em Preparo'; } });
    page.api.db.orders[0].status = 'Pronto';
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => ({ beeps: window.__beeps, vib: window.__vibrations }));
    check(`pronto (avisos ${nome}): mostra o aviso na tela`, (await text(page)).includes('Seu pedido está pronto'));
    check(`pronto (avisos ${nome}): vibração ${vib ? 'sim' : 'não'}`, (r.vib > 0) === vib, JSON.stringify(r));
    check(`pronto (avisos ${nome}): som ${som ? 'sim' : 'não'}`, (r.beeps > 0) === som, JSON.stringify(r));
    await page.close();
  });
}

// 7. Cabe na tela: celular, tablet e computador
for (const [w, h] of [[360, 740], [390, 844], [768, 1024], [1280, 800], [1600, 900]]) {
  for (const screen of ['profile', 'editProfile', 'changePassword']) {
    await step(`largura ${w} ${screen}`, async () => {
      const page = await open(screen, { width: w, height: h });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${screen} em ${w}px: sem rolagem para os lados`, over <= 0, over + 'px');
      const small = await page.evaluate(() => [...document.querySelectorAll('.toggle,.avatar-opt,.btn,.inp,.menurow')]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.height < 40 && !(r.height >= 28)).length);
      check(`${screen} em ${w}px: alvos de toque com bom tamanho`, small === 0, String(small));
      await noErrors(`${screen} ${w}`, page);
      await page.close();
    });
  }
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
