// "Site para computador" do Chrome no app Android: o APK (Trusted Web Activity)
// usa o Chrome do celular, que nesse modo ignora o <meta viewport> e monta a
// página com 980 px de largura. O celular.js volta o app ao tamanho de celular.
// Aqui a tela de 412 px com a página de 980 px imita esse modo e confere que o
// app fica igual ao celular normal; no navegador e no tablet/computador nada
// muda. Uso: node fluxo/modo-computador.mjs (de dentro de tests)
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
const SHOTS = process.env.SHOTS;
const CELULAR = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
// Chrome com "Site para computador": página de 980 px numa tela de 412 px.
const MODO_PC = { viewport: { width: 980, height: 2175 }, screen: { width: 412, height: 915 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 };

async function open(path, role, ctxOpts, { apk = true } = {}) {
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role || 'cliente'); api.seed();
  await page.route('http://localhost:8787/**', api);
  // O index.html marca o app Android no sessionStorage ao abrir pelo APK.
  if (apk) await page.addInitScript(() => sessionStorage.setItem('sunfood_apk', '1'));
  if (role) await page.addInitScript(r => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1500);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
// Medidas na tela do aparelho: no modo computador a página de 980 px é
// encolhida para os 412 px da tela, então tudo é multiplicado por 412/980.
const medidas = (p, sel) => p.evaluate(sel => {
  const pagina = document.documentElement.getBoundingClientRect().width, f = screen.width / Math.max(pagina, screen.width);
  return sel.map(s => { const e = [...document.querySelectorAll(s)].find(e => e.getBoundingClientRect().width); if (!e) return null; const r = e.getBoundingClientRect(); return { s, x: Math.round(r.left * f), y: Math.round(r.top * f), w: Math.round(r.width * f), h: Math.round(r.height * f) }; });
}, sel);
const perto = (a, b) => a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= Math.max(3, b[k] * 0.03));

const TELAS = [
  ['login', 'index.html', null, ['.lp h1', '.lp .btn, .lp button']],
  ['cadastro', 'app-cliente.dc.html?module=cliente&screen=signup', null, ['.su h1', '.su .btn-sun']],
  ['cardápio', 'app-cliente.dc.html?module=cliente&screen=menu', 'cliente', ['.pcard', '.bottomnav', 'input']],
  ['carrinho', 'app-cliente.dc.html?module=cliente&screen=cart', 'cliente', ['h1', '.brand']],
  ['pedido', 'app-cliente.dc.html?module=cliente&screen=status', 'cliente', ['h1', '.bottomnav']],
  ['perfil', 'app-cliente.dc.html?module=cliente&screen=profile', 'cliente', ['h1', '.bottomnav']],
  ['admin', 'app-cliente.dc.html?module=admin&screen=dashboard', 'admin', ['h1', '.adm-menubtn']],
  ['pedidos do admin', 'app-cliente.dc.html?module=admin&screen=orders', 'admin', ['h1', '.adm-menubtn']],
  ['cozinha', 'app-cliente.dc.html?module=cozinha&screen=kanban', 'cozinha', ['.adm-brand', '.adm-menubtn']],
];

for (const [nome, path, role, sel] of TELAS) await step(nome, async () => {
  const cel = await open(path, role, CELULAR), pc = await open(path, role, MODO_PC);
  const [a, b] = [await medidas(cel, sel), await medidas(pc, sel)];
  const info = await pc.evaluate(() => ({ zoom: document.documentElement.style.zoom, iw: innerWidth, cel: matchMedia('(max-width:767px)').matches, lado: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
  check(`${nome}: no modo computador o app enxerga a largura do celular`, Number(info.zoom) > 2 && info.iw === 412 && info.cel, JSON.stringify(info));
  check(`${nome}: mesmo tamanho e lugar do celular normal`, sel.every((_, i) => perto(b[i], a[i])), JSON.stringify([a, b]));
  check(`${nome}: sem rolagem para os lados e sem erro`, info.lado && pc.jsErrors.length === 0, pc.jsErrors.join(' | '));
  // Cadastro: a página termina no botão, sem faixa em branco embaixo (as
  // caixas de fora tinham 100vh, que o zoom do modo computador aumentava).
  if (nome === 'cadastro') for (const [onde, p] of [['celular', cel], ['modo computador', pc]]) {
    const r = await p.evaluate(() => ({ alto: document.documentElement.scrollHeight, janela: document.documentElement.clientHeight }));
    check(`cadastro (${onde}): sem espaço em branco no fim da tela`, r.alto <= r.janela + 1, JSON.stringify(r));
  }
  if (SHOTS) { await cel.screenshot({ path: `${SHOTS}/${nome}-celular.png` }); await pc.screenshot({ path: `${SHOTS}/${nome}-modo-computador.png` }); }
  await cel.context().close(); await pc.context().close();
});

await step('produto e janela do rodapé', async () => {
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', MODO_PC);
  await p.getByText('Peixe Frito', { exact: true }).first().tap({ timeout: 5000 }); await p.waitForTimeout(700);
  const f = await p.evaluate(() => screen.width / document.documentElement.getBoundingClientRect().width);
  const alto = await p.locator('.pd-add').evaluate((e, f) => Math.round(e.getBoundingClientRect().height * f), f);
  check('produto: botão Adicionar com pelo menos 48 px na tela', alto >= 46, String(alto));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/produto-modo-computador.png` });
  await p.context().close();
  const l = await open('index.html', null, MODO_PC);
  await l.getByText('Contato', { exact: true }).filter({ visible: true }).first().tap({ timeout: 5000 }); await l.waitForTimeout(1200);
  // Na tela de entrada o painel abre na própria página; dentro do app, numa janela (iframe).
  const j = await l.evaluate(() => { const fr = document.querySelector('iframe.sf-painel'), d = (fr ? fr.contentDocument : document).documentElement; return { cw: d.clientWidth, sw: d.scrollWidth, fale: /Dúvida, reserva ou suporte/.test(d.innerText) }; });
  check('janela do rodapé: Fale conosco abre e cabe sem rolar para os lados', j.fale && j.sw <= j.cw + 1, JSON.stringify(j));
  if (SHOTS) await l.screenshot({ path: `${SHOTS}/rodape-modo-computador.png` });
  await l.context().close();
});

await step('sem mudança fora do modo computador do app', async () => {
  const nav = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', MODO_PC, { apk: false });
  check('navegador com "Site para computador": continua como a pessoa escolheu', await nav.evaluate(() => !document.documentElement.style.zoom && innerWidth === 980));
  await nav.context().close();
  for (const [w, h] of [[800, 1280], [1024, 768], [1366, 768], [1920, 1080]]) {
    const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { viewport: { width: w, height: h }, screen: { width: w, height: h }, hasTouch: w <= 1024, isMobile: false });
    check(`${w}×${h}: app sem zoom extra`, await p.evaluate(w => !document.documentElement.style.zoom && innerWidth === w, w));
    await p.context().close();
  }
  // Tablet pequeno em que o Chrome também força 980 px: volta para a largura do tablet.
  const tab = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { viewport: { width: 980, height: 1568 }, screen: { width: 600, height: 960 }, hasTouch: true, isMobile: false });
  check('tablet de 600 px no modo computador: app na largura do tablet', await tab.evaluate(() => innerWidth === 600 && matchMedia('(max-width:767px)').matches));
  await tab.context().close();
});

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
