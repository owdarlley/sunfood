// Itens altos da avaliação de usabilidade: encerrar o dia com confirmação,
// etapas da compra, medidas do design system, fonte do garçom e voltar no
// detalhe do produto.
// Uso: node tests/fluxo/usabilidade.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from './fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDN = process.env.CDN_DIR;
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path === '/' ? 'index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, 'localhost');
await new Promise(r => server.on('listening', r));
const BASE = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function open(path, { role = 'cliente', seed, width = 390, height = 844, api, context } = {}) {
  const ctx = context || await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  page.api = api || fakeApi(role);
  if (seed) page.api.seed();
  await page.route('http://localhost:8787/**', page.api);
  if (!context) await page.addInitScript(r => {
    try { sessionStorage.setItem('sunfood_abertura', '1'); } catch {}
    if (!localStorage.getItem('sunfood_session')) localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } }));
  }, role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const screen = page => new URL(page.url()).searchParams.get('screen');
const addFirst = async page => { await page.locator('.addbtn:visible').first().click(); await page.waitForTimeout(300); };

// 6. Encerrar o dia pede confirmação e mostra o resumo
await step('encerrar o dia', async () => {
  const base = fakeApi('admin');
  base.seed();
  let fechou = 0;
  const api = r => {
    if (new URL(r.request().url()).pathname === '/close-day') { fechou++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalRevenue: 0, totalOrders: 0, avgTicket: 0, topProducts: [] }) }); }
    return base(r);
  };
  const page = await open('app-cliente.dc.html?module=admin&screen=dashboard', { role: 'admin', api, width: 1280, height: 800 });
  const topo = page.locator('.adm-head').getByText('Encerrar o dia', { exact: true });
  check('encerrar: botão do painel é secundário (contorno vermelho)', await topo.evaluate(el => el.classList.contains('btn-danger-ghost')));
  await topo.click(); await page.waitForTimeout(400);
  await page.locator('.adm-main .panel .btn').getByText('Encerrar o dia', { exact: true }).click(); await page.waitForTimeout(400);
  let t = await text(page);
  check('encerrar: abre a confirmação sem fechar o caixa', fechou === 0 && t.includes('Encerrar o dia agora?') && t.includes('Continuar aberto'), t.slice(0, 300));
  check('encerrar: confirmação mostra o resumo do dia', /Hoje: \d+ pedidos? e R\$/.test(t));
  await page.getByText('Continuar aberto', { exact: true }).click(); await page.waitForTimeout(300);
  check('encerrar: Continuar aberto fecha a janela sem encerrar', fechou === 0 && !(await text(page)).includes('Encerrar o dia agora?'));
  await page.locator('.adm-main .panel .btn').getByText('Encerrar o dia', { exact: true }).click(); await page.waitForTimeout(300);
  await page.locator('[role=alertdialog]').getByText('Encerrar o dia', { exact: true }).click();
  const encerrou = await page.getByText('Dia encerrado', { exact: true }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('encerrar: confirmar encerra o dia', fechou === 1 && encerrou, `chamadas=${fechou}`);
  check('encerrar: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.context().close();
});

// 7. Etapas da compra com nomes que batem e "Pagar" depois do resumo
await step('etapas da compra', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu');
  await page.locator('.addbtn:visible').first().click(); await page.waitForTimeout(300);
  await page.getByText('item no carrinho').first().click(); await page.waitForTimeout(400);
  check('compra: carrinho se chama Seu carrinho', (await text(page)).includes('Seu carrinho'));
  await page.getByText('Escolher a mesa', { exact: true }).click(); await page.waitForTimeout(400);
  let t = await text(page);
  check('compra: mesa é a etapa 1 de 2', t.includes('Sua mesa') && t.includes('Etapa 1 de 2'), t.slice(0, 200));
  await page.getByLabel('Número da mesa', { exact: true }).fill('3');
  await page.getByText('Escolher pagamento', { exact: true }).click(); await page.waitForTimeout(400);
  t = await text(page);
  check('compra: pagamento é a etapa 2 de 2', t.includes('Pagamento') && t.includes('Etapa 2 de 2 · Mesa 3'), t.slice(0, 200));
  const pos = await page.evaluate(() => {
    const pay = [...document.querySelectorAll('.btn')].find(b => /^Pagar R\$/.test(b.innerText.trim()));
    const total = [...document.querySelectorAll('.sumtotal')].find(b => b.offsetParent);
    return pay && total ? { pay: pay.getBoundingClientRect().top, total: total.getBoundingClientRect().top, h: pay.getBoundingClientRect().height } : null;
  });
  check('compra: no celular o Pagar fica abaixo do resumo', pos && pos.pay > pos.total, JSON.stringify(pos));
  check('compra: Pagar tem a altura dos outros botões (48 px)', pos && Math.round(pos.h) === 48, JSON.stringify(pos));
  await page.context().close();
});

// 9 e 10. Medidas do design system
await step('design system', async () => {
  for (const [w, h, ctl, h1, sm] of [[390, 844, 48, 24, 14], [820, 1180, 48, 28, 14], [1280, 800, 44, 32, 14]]) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { width: w, height: h });
    const m = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const g = k => parseInt(cs.getPropertyValue(k)); return { ctl: g('--ctl'), h1: g('--fs-h1'), sm: g('--fs-sm'), rb: g('--r-btn'), rc: g('--r-ctl') }; });
    check(`tokens ${w}px: botão ${ctl}, H1 ${h1}, texto pequeno ${sm}, cantos 8`, m.ctl === ctl && m.h1 === h1 && m.sm === sm && m.rb === 8 && m.rc === 8, JSON.stringify(m));
    if (w === 820) {
      const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
      check('tablet: cardápio em 3 colunas', cols === 3, String(cols));
    }
    if (w === 390) {
      const n13 = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.offsetParent && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && getComputedStyle(el).fontSize === '13px').length);
      check('celular: nenhum texto de 13 px no cardápio', n13 === 0, String(n13));
    }
    await page.context().close();
  }
});

// 11. Garçom usa a fonte e as cores do app
await step('garçom', async () => {
  const html = await readFile(join(ROOT, 'app-cliente.dc.html'), 'utf8');
  check('garçom: nenhuma referência a DM Sans', !html.includes('DM Sans'));
  check('garçom: sem cores fora da paleta', !/#0B6670|#084C53|#5A6670/.test(html));
});

// 12. Detalhe do produto tem botão de voltar
await step('detalhe do produto', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu');
  await page.locator('.pcard').first().click(); await page.waitForTimeout(500);
  check('detalhe: abriu o produto', screen(page) === 'product', page.url());
  const back = page.getByLabel('Voltar ao cardápio', { exact: true });
  check('detalhe: botão de voltar visível no celular', await back.isVisible());
  await back.click(); await page.waitForTimeout(400);
  check('detalhe: voltar leva ao cardápio', screen(page) === 'menu', page.url());
  await page.context().close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
