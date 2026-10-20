// Login e cadastro cabem na altura da tela, sem rolar: tela de entrada
// (chamada e formulário no celular), erro dos campos, aviso de e-mail não
// confirmado e cadastro, no celular, tablet, computador e tela larga, com as
// alturas reais do navegador (barra de endereço e abas descontadas). Do tablet
// para cima login e cadastro usam a mesma escala, já definida antes da tela
// aparecer (caber.js, mínimo 75%), inclusive com o teclado do tablet aberto, e
// os cartões do cardápio não achatam; no celular a escala fica em 100%. O
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

async function open(vw, path, toque) {
  const mobile = toque || vw.width < 768;
  const ctx = await browser.newContext({ viewport: vw, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  await page.route('http://localhost:8787/**', fakeApi('cliente'));
  // Sem a abertura animada: só a tela parada interessa aqui.
  await page.addInitScript(() => { try { sessionStorage.setItem('sunfood_abertura', '1'); } catch (e) {} });
  await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { window.__fitInicial = Number(document.documentElement.style.getPropertyValue('--fit') || 1); }); });
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}
// Quanto passa da altura da tela (0 = cabe sem rolar).
const sobra = p => p.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
// O elemento aparece inteiro dentro da tela, sem rolar.
const naTela = (p, sel) => p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; }, sel);

// Escala efetiva na tela: o zoom do elemento vezes o dos pais (o app tem zoom
// próprio do tablet para cima, que o da tela de cadastro compensa).
const escala = (p, sel) => p.evaluate(s => { let z = 1; for (let e = document.querySelector(s); e; e = e.parentElement) z *= Number(getComputedStyle(e).zoom || 1); return Math.round(z * 1000) / 1000; }, sel);
// Escala já definida antes da tela aparecer (sem abrir grande e encolher depois).
const escalaInicial = p => p.evaluate(() => window.__fitInicial);
// Altura da tela em 100%, sem o mínimo de uma tela cheia.
const alturaNatural = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); e.style.minHeight = '0px'; const a = e.offsetHeight; e.style.minHeight = ''; return a; }, sel);
const escalaOk = async (p, sel, cel) => { const z = await escala(p, sel); return cel ? z === 0.83 : z >= 0.75 && z <= 0.83; };

const TELAS = process.env.TELAS ? process.env.TELAS.split(',').map(t => { const [w, h] = t.split('x').map(Number); return [t, { width: w, height: h }]; }) : [
  ['celular baixo', { width: 360, height: 640 }],
  ['iPhone com barras', { width: 390, height: 664 }],
  ['celular', { width: 412, height: 780 }],
  ['tablet em pé', { width: 768, height: 950 }],
  ['tablet deitado', { width: 1024, height: 680 }],
  ['notebook baixo', { width: 1276, height: 573 }],
  ['notebook', { width: 1366, height: 625 }],
  ['computador', { width: 1536, height: 730 }],
  ['tela larga', { width: 1920, height: 950 }]
];

const escalas = {};
for (const [nome, vw] of TELAS) {
  const cel = vw.width < 768;
  await step(`login (${nome})`, async () => {
    const p = await open(vw, 'index.html');
    check(`login (${nome}): cabe sem rolar`, await sobra(p) <= 1, `${await sobra(p)} px a mais`);
    check(`login (${nome}): "Conheça o Sunfood" na tela`, await naTela(p, '.foot a[href="#conheca"]'));
    check(`login (${nome}): escala entre 75% e 83% (83% no celular)`, await escalaOk(p, '.lp', cel), await escala(p, '.lp'));
    escalas[nome] = { login: await escala(p, '.lp'), loginInicial: await escalaInicial(p) };
    if (vw.width >= 768 && vw.width < 1024) { const a = await alturaNatural(p, '.lp'); check(`login (${nome}): altura de referência certa no tablet (${a} de 968 px)`, a <= 968 && 968 - a <= 12, `${a} px`); }
    check(`login (${nome}): já abre na escala certa`, escalas[nome].loginInicial === escalas[nome].login, `${escalas[nome].loginInicial} -> ${escalas[nome].login}`);
    check(`login (${nome}): cartões do cardápio sem achatar`, await p.locator('.lp-cat').first().evaluate((e, cel) => e.getBoundingClientRect().height / e.currentCSSZoom >= (cel ? 140 : 150), cel));
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
    check(`cadastro (${nome}): escala entre 75% e 83% (83% no celular)`, await escalaOk(p, '.auth', cel), await escala(p, '.auth'));
    const zc = await escala(p, '.auth');
    check(`cadastro (${nome}): mesma escala do login`, zc === escalas[nome]?.login, `cadastro ${zc}, login ${escalas[nome]?.login}`);
    check(`cadastro (${nome}): já abre na escala certa`, await escalaInicial(p) === zc, `${await escalaInicial(p)} -> ${zc}`);
    // A altura de referência de caber.js continua certa: a do cadastro (computador) cabe nela, com folga de até 12 px.
    if (vw.width >= 1040 && vw.height < 820) { const a = await alturaNatural(p, '.auth'), ref = 758; check(`cadastro (${nome}): altura de referência certa (${a} de ${ref} px)`, a <= ref && ref - a <= 12, `${a} px`); }
    if (cel) {
      const alturas = await p.locator('.su .inp').evaluateAll(l => l.map(e => Math.round(e.getBoundingClientRect().height)));
      check(`cadastro (${nome}): campos com 48 px no celular`, alturas.length === 7 && alturas.every(h => h >= 48), alturas.join(','));
    }
    check(`cadastro (${nome}): sem rolagem lateral`, await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await p.context().close();
  });
}

// Tablet com teclado aberto: a altura da janela diminui com o campo em foco,
// mas a escala não muda enquanto a pessoa digita (a tela não pula).
await step('teclado no tablet', async () => {
  for (const [path, sel, campo] of [['index.html', '.lp', '#email'], ['app-cliente.dc.html?module=cliente&screen=signup', '.auth', '.su .inp']]) {
    const p = await open({ width: 1180, height: 820 }, path, true);
    if (sel === '.lp') { await p.locator('#com-email').click().catch(() => {}); }
    const antes = await escala(p, sel);
    await p.locator(campo).first().focus();
    await p.setViewportSize({ width: 1180, height: 500 }); await p.waitForTimeout(300);
    check(`teclado no tablet (${sel === '.lp' ? 'login' : 'cadastro'}): escala não muda com o teclado aberto`, await escala(p, sel) === antes, `${antes} -> ${await escala(p, sel)}`);
    await p.locator(campo).first().blur();
    await p.setViewportSize({ width: 1180, height: 820 }); await p.waitForTimeout(300);
    check(`teclado no tablet (${sel === '.lp' ? 'login' : 'cadastro'}): escala volta igual ao fechar`, await escala(p, sel) === antes);
    await p.setViewportSize({ width: 1180, height: 600 }); await p.waitForTimeout(300);
    check(`teclado no tablet (${sel === '.lp' ? 'login' : 'cadastro'}): janela menor sem teclado ajusta a escala`, await escala(p, sel) < antes && await sobra(p) <= 1);
    await p.context().close();
  }
});

await browser.close(); server.close();
const falhas = results.filter(r => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} ok`);
process.exit(falhas.length ? 1 : 0);
