// Aba "Baixe o app" (#baixar-app): botão que baixa o APK assinado, passo a
// passo da instalação, QR Code do tablet para cima e o link do rodapé, que
// some dentro do app Android (e do app instalado pelo navegador).
// Uso: node fluxo/app/baixar-app.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CDN = process.env.CDN_DIR;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.apk': 'application/vnd.android.package-archive' };
const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const file = path === '/' ? 'index.html' : path;
    const b = await readFile(join(ROOT, file)); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(b);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});

const TELAS = [['celular', 390, 844], ['tablet', 820, 1180], ['computador', 1280, 800], ['tela larga', 1920, 1080]];

async function open(path, viewport, { referer, role } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role || 'cliente'); api.seed();
  await page.route('http://localhost:8787/**', api);
  if (role) await page.addInitScript(r => { try { localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })); } catch (e) {} }, role);
  // O app Android abre o site com este referrer; o Chrome do teste não aceita
  // android-app:// de verdade, então o teste o simula antes do script da página.
  if (referer) await page.addInitScript(r => Object.defineProperty(Document.prototype, 'referrer', { get: () => r }), referer);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const semRolagemLateral = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const apk = await stat(join(ROOT, 'download', 'sunfood.apk')).catch(() => null);
check('APK publicado em download/sunfood.apk', !!apk && apk.size > 100000, apk ? apk.size + ' bytes' : 'sem arquivo');

for (const [tela, width, height] of TELAS) {
  const vp = { width, height };
  await step(`${tela}: aba Baixe o app`, async () => {
    const p = await open('', vp);
    await p.locator('.foot a', { hasText: 'Baixe o app' }).click(); await p.waitForTimeout(800);
    const sec = p.locator('[data-sec="baixar-app"]');
    check(`${tela}: rodapé do login abre a aba Baixe o app`, p.url() === BASE + '#baixar-app' && await sec.isVisible(), p.url());
    check(`${tela}: aba marcada e título da página`, await p.locator('.tab[aria-current="page"]').innerText() === 'Baixe o app' && await p.title() === 'SunFood · Baixe o app');
    const btn = sec.locator('a.btn', { hasText: 'Baixar o app' });
    check(`${tela}: botão baixa o APK`, await btn.getAttribute('href') === 'download/sunfood.apk' && await btn.getAttribute('download') === 'sunfood-1.0.2.apk');
    // Altura final na tela (já com o zoom do painel): 48 px no celular e no tablet, 44 px no computador.
    const alt = await btn.evaluate(e => e.getBoundingClientRect().height);
    const min = width > 1024 ? 44 : 48;
    check(`${tela}: botão com ${min} px de altura na tela`, Math.round(alt) >= min, alt + ' px');
    const res = await p.request.get(BASE + 'download/sunfood.apk');
    check(`${tela}: APK responde`, res.ok());
    check(`${tela}: passo a passo com 4 etapas e aviso do iPhone`, await sec.locator('.steps .card').count() === 4 && (await sec.innerText()).includes('Instalar apps desconhecidos') && (await sec.innerText()).includes('Tem iPhone?'));
    const qr = await sec.locator('.dl-qr').isVisible();
    check(`${tela}: QR Code ${width >= 768 ? 'aparece' : 'fica escondido'}`, qr === (width >= 768));
    if (qr) check(`${tela}: QR Code carrega`, await sec.locator('.dl-qr img').evaluate(i => i.complete && i.naturalWidth > 0));
    check(`${tela}: sem rolagem lateral`, await semRolagemLateral(p));
    check(`${tela}: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  });

  await step(`${tela}: dentro do app Android`, async () => {
    const p = await open('', vp, { referer: 'android-app://br.app.sunfood/' });
    check(`${tela}: app Android: sem o link Baixe o app no rodapé`, await p.locator('.foot a', { hasText: 'Baixe o app' }).isHidden() && await p.locator('.foot a', { hasText: 'Termos de uso' }).isVisible());
    await p.locator('.foot a', { hasText: 'Termos de uso' }).click(); await p.waitForTimeout(800);
    check(`${tela}: app Android: sem a aba Baixe o app`, await p.locator('.tab', { hasText: 'Baixe o app' }).isHidden());
    // A marca vale para a sessão do app, também nas outras telas.
    await p.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=signup'); await p.waitForTimeout(1500);
    check(`${tela}: app Android: cadastro sem o link Baixe o app`, await p.locator('.auth-foot a[href$="#baixar-app"]').isHidden());
    await p.context().close();
  });

  await step(`${tela}: cadastro abre Baixe o app por cima`, async () => {
    const p = await open('app-cliente.dc.html?module=cliente&screen=signup', vp);
    const antes = p.url();
    const link = p.locator('.auth-foot a', { hasText: 'Baixe o app' });
    if (await link.isVisible()) await link.click();
    else await p.evaluate(() => { const a = document.createElement('a'); a.href = './#baixar-app'; document.body.appendChild(a); a.click(); a.remove(); });
    await p.waitForTimeout(1500);
    const f = p.frameLocator('iframe.sf-painel');
    check(`${tela}: cadastro: Baixe o app abre na janela sem sair do cadastro`, p.url() === antes && await f.locator('[data-sec="baixar-app"]').isVisible(), p.url());
    check(`${tela}: cadastro: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  });
}

// Texto do aparelho aumentado (acessibilidade do Android): o rodapé do login
// quebra a linha em vez de passar da largura e criar rolagem. E ao recarregar
// a tela continua do tamanho da janela.
await step('texto grande: login sem rolagem', async () => {
  for (const [w, h] of [[360, 640], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await p.goto(BASE); await p.waitForTimeout(1000);
    await p.addStyleTag({ content: 'html{-webkit-text-size-adjust:130%}' }); await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    check(`texto grande ${w}x${h}: login sem rolagem`, r.sw <= w && r.sh <= h, JSON.stringify(r));
    // A altura da tela vem da janela medida (--janela do caber.js), não do dvh,
    // que no app Android da Samsung chegava maior que a janela ao recarregar.
    await p.reload(); await p.waitForTimeout(1000);
    const j = await p.evaluate(() => ({ janela: getComputedStyle(document.documentElement).getPropertyValue('--janela'), ih: innerHeight, sh: document.documentElement.scrollHeight }));
    check(`${w}x${h}: depois de recarregar, altura da janela medida e sem rolagem`, j.janela === j.ih + 'px' && j.sh <= h, JSON.stringify(j));
    await ctx.close();
  }
});

await browser.close(); server.close();
const falhas = results.filter(r => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} ok`);
process.exit(falhas.length ? 1 : 0);
