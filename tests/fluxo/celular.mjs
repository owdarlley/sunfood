// Teste no celular (tela pequena e toque de dedo, sem mouse): botões que
// não respondiam ao toque, menu do admin sem arrastar e telas sem rolagem
// para os lados. Uso: node fluxo/celular.mjs (de dentro de tests)
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
let VW = { width: 390, height: 844 };

async function open(path, role, { seed = true } = {}) {
  const ctx = await browser.newContext({ viewport: VW, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  if (CDN) await page.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google|supabase/, r => r.abort());
  const api = fakeApi(role || 'cliente'); if (seed) api.seed(); page.api = api;
  await page.route('http://localhost:8787/**', api);
  if (role) await page.addInitScript(r => localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1300);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
const text = p => p.locator('body').innerText();
const tap = async (p, t, exact = true) => { await p.getByText(t, { exact }).first().tap({ timeout: 5000 }); await p.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const semRolagemLateral = p => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

await step('aba Pedido', async () => {
  // Pedido em andamento + página recarregada (o celular faz isso sozinho): a aba volta a mostrar o pedido.
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente');
  await tap(p, 'Pedido');
  check('aba Pedido: mostra o pedido em andamento depois de recarregar', p.url().includes('screen=status') || (await text(p)).includes('#o9'), p.url());
  await p.context().close();
  const sem = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente', { seed: false });
  await tap(sem, 'Pedido');
  check('aba Pedido: sem pedido, avisa em vez de não fazer nada', (await text(sem)).includes('Você não tem pedido em andamento.'));
  await sem.context().close();
});

await step('esqueci minha senha', async () => {
  const p = await open('app-cliente.dc.html?module=cliente&screen=forgot');
  await tap(p, 'Enviar link');
  check('esqueci minha senha: Enviar link vazio explica o que falta', (await text(p)).includes('Informe o e-mail da sua conta.'));
  await tap(p, 'CPF'); await tap(p, 'Enviar link');
  check('esqueci minha senha: CPF vazio explica o que falta', (await text(p)).includes('Informe um CPF válido.'));
  await p.context().close();
});

await step('localização', async () => {
  const p = await open('app-cliente.dc.html?module=cliente&screen=location', 'cliente');
  const mapa = await p.getByText('Abrir no mapa', { exact: true }).getAttribute('href');
  check('localização: Abrir no mapa abre o Google Maps', /google\.com\/maps/.test(mapa || ''), mapa);
  await tap(p, 'Fale conosco'); await p.waitForTimeout(800);
  check('localização: Fale conosco abre o formulário', (await text(p)).includes('Dúvida, reserva ou suporte?'), p.url());
  await p.context().close();
});

for (const [w, h] of [[360, 740], [390, 844]]) {
  VW = { width: w, height: h };
  await step(`admin ${w}px`, async () => {
    const p = await open('app-cliente.dc.html?module=admin&screen=dashboard', 'admin');
    // Um </div> a mais no cardápio já deixou uma tela inteira em branco acima da administração e da cozinha no celular.
    for (const [mod, scr] of [['admin', 'dashboard'], ['cozinha', 'kanban']]) {
      const q = mod === 'admin' ? p : await open(`app-cliente.dc.html?module=${mod}&screen=${scr}`, mod);
      const topo = await q.locator('.adm-brand:visible').first().evaluate(e => e.getBoundingClientRect().top + scrollY);
      check(`${mod} ${w}px: abre com a marca no topo, sem espaço em branco em cima`, topo < 40, String(topo));
      if (q !== p) await q.context().close();
    }
    check(`admin ${w}px: menu cabe sem arrastar para os lados`, await semRolagemLateral(p) && await p.locator('.adm-side').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
    await tap(p, 'Menu');
    const itens = await p.locator('.adm-item').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.height >= 40; }));
    check(`admin ${w}px: todos os itens do menu aparecem e são fáceis de tocar`, itens.length >= 9 && itens.every(Boolean), JSON.stringify(itens));
    await tap(p, 'Pedidos');
    check(`admin ${w}px: tocar num item abre a tela e fecha o menu`, p.url().includes('module=admin') && (await text(p)).includes('Buscar por mesa ou código') && await p.locator('.adm-item').first().isHidden());
    check(`admin ${w}px: tabela de pedidos sem arrastar para os lados`, await p.locator('.tblwrap').first().evaluate(e => e.scrollWidth <= e.clientWidth + 1));
    await p.context().close();
  });
  for (const [path, role] of [['index.html', null], ['app-cliente.dc.html?module=cliente&screen=menu', 'cliente'], ['app-cliente.dc.html?module=cliente&screen=cart', 'cliente'],
    ['app-cliente.dc.html?module=admin&screen=payments', 'admin'], ['app-cliente.dc.html?module=admin&screen=reports', 'admin'], ['app-cliente.dc.html?module=cozinha&screen=kanban', 'cozinha']]) {
    const p = await open(path, role);
    check(`${w}px: ${path} sem rolagem para os lados e sem erro`, await semRolagemLateral(p) && p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  }
}

// Painel do rodapé (Conheça o Sunfood, Fale conosco...): arrastar para o lado troca de aba,
// com o conteúdo acompanhando o dedo e a aba vizinha entrando junto.
await step('arrastar entre as abas do rodapé', async () => {
  const p = await open('#conheca');
  const arrastar = (xs, pausa = 30, soltar = true) => p.evaluate(async ([xs, pausa, soltar]) => {
    const el = document.getElementById('info-body');
    const T = x => new Touch({ identifier: 1, target: el, clientX: x, clientY: 500 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [T(xs[0])], changedTouches: [T(xs[0])], bubbles: true }));
    for (const x of xs.slice(1)) { await new Promise(r => setTimeout(r, pausa)); el.dispatchEvent(new TouchEvent('touchmove', { touches: [T(x)], changedTouches: [T(x)], bubbles: true })); }
    const meio = [...el.querySelectorAll('[data-sec]')].filter(s => !s.hidden).map(s => s.dataset.sec);
    if (soltar) el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [T(xs[xs.length - 1])], bubbles: true }));
    return meio;
  }, [xs, pausa, soltar]);
  const meio = await arrastar([320, 280, 220, 160, 120]);
  check('abas: durante o arrasto a aba vizinha aparece junto', meio.join() === 'conheca,fale-conosco', meio.join());
  await p.waitForTimeout(450);
  check('abas: arrastar para a esquerda abre a próxima', p.url().endsWith('#fale-conosco'), p.url());
  await arrastar([300, 280, 260, 240, 230], 40); await p.waitForTimeout(450);
  check('abas: arrasto curto volta para a mesma aba', p.url().endsWith('#fale-conosco'), p.url());
  await arrastar([60, 120, 180, 240, 300]); await p.waitForTimeout(450);
  const vis = await p.evaluate(() => [...document.querySelectorAll('#info-body [data-sec]')].filter(s => !s.hidden).map(s => s.dataset.sec + (s.style.cssText ? '*' : '')).join());
  check('abas: arrastar para a direita volta à anterior, sem sobrar nada fora do lugar', p.url().endsWith('#conheca') && vis === 'conheca', p.url() + ' ' + vis);
  check('abas: sem erro de JavaScript', p.jsErrors.length === 0, p.jsErrors.join(' | '));
  await p.context().close();
});

await step('detalhe do produto', async () => {
  // Celular pequeno: nome, preço e o botão Adicionar aparecem sem rolar, e o botão funciona.
  VW = { width: 360, height: 640 };
  const p = await open('app-cliente.dc.html?module=cliente&screen=menu', 'cliente');
  await tap(p, 'Peixe Frito');
  const dentro = await p.evaluate(() => ['.pd-name', '.pd-mprice', '.pd-desc', '.pd-add'].map(sel => {
    const r = document.querySelector(sel).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; }));
  check('detalhe do produto 360px: nome, preço, descrição e Adicionar aparecem sem rolar', dentro.every(Boolean), JSON.stringify(dentro));
  check('detalhe do produto 360px: sem rolagem para os lados', await semRolagemLateral(p));
  await tap(p, '+');
  await p.locator('.pd-add').tap(); await p.waitForTimeout(500);
  check('detalhe do produto 360px: Adicionar põe 2 itens no carrinho e volta ao cardápio', p.url().includes('screen=menu') && (await text(p)).includes('2 itens no carrinho'), p.url());
  await p.context().close();
});

await step('tracinho de digitação', async () => {
  // Ao tocar/clicar num botão não pode aparecer o cursor de texto piscando; nos campos, sim.
  for (const [path, role, botao, campo] of [['index.html', null, '#entrar', '#email'], ['app-cliente.dc.html?module=cliente&screen=forgot', null, 'text=Enviar link', 'input'], ['app-cliente.dc.html?module=admin&screen=tables', 'admin', 'text=Menu', 'input']]) {
    const p = await open(path, role);
    const b = await p.locator(botao).first().evaluate(e => [getComputedStyle(e).caretColor, getComputedStyle(e).userSelect]);
    const c = await p.locator(campo).first().evaluate(e => getComputedStyle(e).caretColor);
    check(`${path.split('?')[1] || path}: botão sem cursor de texto e sem selecionar, campo com cursor`, b[0] === 'rgba(0, 0, 0, 0)' && b[1] === 'none' && c !== 'rgba(0, 0, 0, 0)', JSON.stringify([b, c]));
    // Texto comum (título) também não seleciona nem mostra o cursor de texto; o campo continua selecionável.
    const t = await p.locator('h1, .tt').first().evaluate(e => [getComputedStyle(e).userSelect, getComputedStyle(e).cursor]);
    const ci = await p.locator(campo).first().evaluate(e => getComputedStyle(e).userSelect);
    check(`${path.split('?')[1] || path}: texto comum não seleciona ao clicar, campo sim`, t[0] === 'none' && t[1] === 'default' && ci === 'text', JSON.stringify([t, ci]));
    await p.context().close();
  }
});

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
