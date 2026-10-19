// Login e cadastro cabem na altura da tela, sem rolar: tela de entrada
// (chamada e formulário no celular), erro dos campos, aviso de e-mail não
// confirmado e cadastro, no celular, tablet, computador e tela larga. O
// rodapé (Conheça o Sunfood etc.) continua na tela. Celular bem baixo com
// aviso aberto e cadastro com vários erros podem rolar (último recurso).
// Uso: node fluxo/sem-rolagem.mjs (de dentro de tests)
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

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function open(vw, path) {
  const mobile = vw.width < 768;
  const ctx = await browser.newContext({ viewport: vw, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  await page.route('http://localhost:8787/**', fakeApi('cliente'));
  // Sem a abertura animada: só a tela parada interessa aqui.
  await page.addInitScript(() => { try { sessionStorage.setItem('sunfood_abertura', '1'); } catch (e) {} });
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}
// Quanto passa da altura da tela (0 = cabe sem rolar).
const sobra = p => p.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
// O elemento aparece inteiro dentro da tela, sem rolar.
const naTela = (p, sel) => p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; }, sel);

const TELAS = [
  ['celular baixo', { width: 360, height: 640 }],
  ['iPhone com barras', { width: 390, height: 664 }],
  ['celular', { width: 412, height: 915 }],
  ['tablet em pé', { width: 768, height: 1024 }],
  ['tablet deitado', { width: 1024, height: 768 }],
  ['notebook', { width: 1280, height: 720 }],
  ['computador', { width: 1366, height: 768 }],
  ['tela larga', { width: 1920, height: 1080 }]
];

for (const [nome, vw] of TELAS) {
  const cel = vw.width < 768;
  await step(`login (${nome})`, async () => {
    const p = await open(vw, 'index.html');
    check(`login (${nome}): cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    check(`login (${nome}): "Conheça o Sunfood" na tela`, await naTela(p, '.foot a[href="#conheca"]'));
    if (cel) {
      await p.locator('#com-email').tap(); await p.waitForTimeout(300);
      check(`login (${nome}): formulário cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    }
    await p.evaluate(() => document.getElementById('entrar').click()); await p.waitForTimeout(300);
    check(`login (${nome}): erro dos campos cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    check(`login (${nome}): botão Entrar e rodapé na tela`, await naTela(p, '#entrar') && await naTela(p, '.foot a[href="#privacidade"]'));
    // E-mail não confirmado: aviso e botão de reenviar. No celular de 640 px pode rolar.
    await p.route('http://localhost:8787/auth/login', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Confirme seu e-mail antes de entrar. Procure o e-mail do Sunfood na caixa de entrada ou no spam.', code: 'email_not_confirmed' }) }));
    await p.fill('#email', 'ana@email.com'); await p.fill('#pass', '123456');
    await p.evaluate(() => document.getElementById('entrar').click()); await p.waitForTimeout(600);
    check(`login (${nome}): aviso de e-mail não confirmado aparece`, await p.locator('#resend').isVisible());
    if (vw.height >= 664) check(`login (${nome}): aviso de e-mail não confirmado cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    await p.context().close();
  });
  await step(`cadastro (${nome})`, async () => {
    const p = await open(vw, 'app-cliente.dc.html?module=cliente&screen=signup');
    check(`cadastro (${nome}): cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    const btn = p.getByText('Criar minha conta', { exact: true }).first();
    check(`cadastro (${nome}): "Criar minha conta" na tela`, await btn.evaluate(e => e.getBoundingClientRect().bottom <= innerHeight + 1));
    const alturas = await p.locator('.su .inp').evaluateAll(l => l.map(e => Math.round(e.getBoundingClientRect().height)));
    const min = vw.width > 1024 ? 44 : 48;
    check(`cadastro (${nome}): campos com ${min} px`, alturas.length === 7 && alturas.every(h => h >= min), alturas.join(','));
    check(`cadastro (${nome}): sem rolagem lateral`, await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await p.context().close();
  });
}

await browser.close(); server.close();
const falhas = results.filter(r => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} ok`);
process.exit(falhas.length ? 1 : 0);
