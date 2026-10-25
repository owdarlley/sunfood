// Itens altos e médios da avaliação de usabilidade: encerrar o dia com confirmação,
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
    if (new URL(r.request().url()).pathname === '/close-day') { fechou++; base.db.kiosk.dayClosed = true; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalRevenue: 0, totalOrders: 0, avgTicket: 0, topProducts: [] }) }); }
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

// ===== Itens médios =====

// 14. Mesmos nomes no menu do celular e do computador; "Meu pedido" só com pedido
await step('navegação', async () => {
  const cel = await open('app-cliente.dc.html?module=cliente&screen=menu');
  const tc = await cel.locator('.bottomnav').innerText().catch(() => '');
  check('navegação celular: Cardápio, Meus pedidos e Perfil, sem Meu pedido sem pedido', tc.includes('Cardápio') && tc.includes('Meus pedidos') && tc.includes('Perfil') && !tc.includes('Meu pedido\n') && !/Meu pedido$/m.test(tc), tc);
  await cel.context().close();
  const pc = await open('app-cliente.dc.html?module=cliente&screen=menu', { width: 1280, height: 800 });
  const tp = await pc.locator('.toplinks').innerText();
  check('navegação computador: mesma lista (Cardápio, Meus pedidos, Perfil)', tp.includes('Cardápio') && tp.includes('Meus pedidos') && tp.includes('Perfil') && !tp.includes('Minha conta'), tp);
  await pc.context().close();
  const adm = await open('app-cliente.dc.html?module=admin&screen=reports', { role: 'admin', seed: true, width: 1280, height: 800 });
  const side = await adm.locator('.adm-side').first().innerText();
  check('navegação admin: menu com os mesmos nomes dos títulos', side.includes('Relatórios') && side.includes('Desempenho') && side.includes('Cardápio e estoque') && !side.includes('Vendas') && !side.includes('Operação'), side);
  await adm.context().close();
});

// 15 e 17. Cozinha: abas com o glossário e, com garçom, para em Pronto
await step('cozinha', async () => {
  const api = fakeApi('cozinha');
  api.seed();
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', api, width: 1280, height: 800 });
  let t = await text(page);
  check('cozinha: coluna "Na fila" (não "Novos")', t.includes('Na fila') && !t.includes('Novos'));
  check('cozinha: Atrasados 0 não fica vermelho', await page.locator('.kz-chip', { hasText: 'Atrasados' }).locator('b').evaluate(el => getComputedStyle(el).color) !== 'rgb(179, 38, 30)');
  check('cozinha: som é um interruptor no topo', await page.locator('.adm-head [role=switch]').count() === 1 && await page.locator('.adm-side').getByText('Som ligado').count() === 0);
  await page.context().close();
  const api2 = fakeApi('cozinha');
  api2.seed(); api2.db.orders[0].status = 'Pronto'; api2.db.hasWaiters = true;
  const p2 = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', api: api2, width: 1280, height: 800 });
  t = await text(p2);
  check('cozinha com garçom: não marca Entregue, avisa que o garçom leva', !t.includes('Marcar como entregue') && t.includes('O garçom leva até a mesa'), t.slice(0, 400));
  await p2.context().close();
});

// 16. Estimativa pelo tempo de preparo cadastrado
await step('estimativa', async () => {
  const api = fakeApi('cliente');
  api.seed(); api.db.products[0].prepTime = '20 min';
  const page = await open('app-cliente.dc.html?module=cliente&screen=status', { api });
  const t = await text(page);
  check('estimativa: usa o maior tempo de preparo + fila (~25 min)', t.includes('~25 min') && !t.includes('~15 min'), t.slice(0, 300));
  await page.context().close();
});

// 18. +/− do cartão com 40 px e cartão sem mudar de altura
await step('+/- do cartão', async () => {
  for (const [w, h] of [[390, 844], [820, 1180]]) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { width: w, height: h });
    const card = page.locator('.pcard').first();
    const h0 = (await card.boundingBox()).height;
    await card.locator('.addbtn').click(); await page.waitForTimeout(300);
    const h1 = (await card.boundingBox()).height;
    const sb = await card.locator('.stepper .sb').first().boundingBox();
    check(`cartão ${w}px: altura igual depois de adicionar`, Math.abs(h1 - h0) < 1, `${h0} -> ${h1}`);
    check(`cartão ${w}px: +/− com 40 px`, Math.round(sb.width) === 40 && Math.round(sb.height) === 40, JSON.stringify(sb));
    await page.context().close();
  }
});

// 19. Erro da mesa colado no campo
await step('erro da mesa', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu');
  await page.locator('.addbtn:visible').first().click(); await page.waitForTimeout(300);
  await page.getByText('item no carrinho').first().click(); await page.waitForTimeout(300);
  await page.getByText('Escolher a mesa', { exact: true }).click(); await page.waitForTimeout(300);
  await page.getByText('Escolher pagamento', { exact: true }).click(); await page.waitForTimeout(300);
  const inp = page.getByLabel('Número da mesa', { exact: true });
  check('mesa: campo marcado como inválido', await inp.getAttribute('aria-invalid') === 'true');
  const pos = await page.evaluate(() => { const f = document.querySelector('.mesafield').getBoundingClientRect(); const e = document.getElementById('mesaErr'); return e ? e.getBoundingClientRect().top - f.bottom : null; });
  check('mesa: mensagem logo abaixo do campo', pos !== null && pos >= 0 && pos < 16, String(pos));
  await page.context().close();
});

// 20. Painel: texto neutro e gráfico vazio explicado
await step('painel', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=dashboard', { role: 'admin', width: 1280, height: 800 });
  const t = await text(page);
  check('painel: gráfico vazio diz que não há venda', t.includes('Nenhuma venda hoje ainda. O gráfico aparece'));
  check('painel: "0 pedidos hoje" sem (s)', t.includes('0 pedidos hoje') && !t.includes('pedido(s)'));
  check('painel: legenda dos números não fica verde', await page.locator('.kpi .s').first().evaluate(el => getComputedStyle(el).color) !== 'rgb(30, 107, 54)');
  check('painel: tempo médio de preparo aparece uma vez só', (t.match(/Tempo médio de preparo/g) || []).length === 1);
  await page.context().close();
});

// 21. Perfil: sem lista de pedidos repetida e "Excluir conta" por último
await step('perfil', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=profile');
  const t = await text(page);
  check('perfil: sem a seção de pedidos repetida', !t.includes('Quando você fizer o primeiro pedido'));
  check('perfil: Excluir conta é o último bloco', t.trim().lastIndexOf('Excluir minha conta') > t.lastIndexOf('Avisos do pedido'));
  await page.context().close();
});

// 22. Cardápio do admin: Editar antes de Excluir (ícone)
await step('cardápio do admin', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=productForm', { role: 'admin', width: 1280, height: 800 });
  const ordem = await page.locator('.pgrid .card').first().evaluate(c => { const e = [...c.querySelectorAll('.btn')].find(b => b.innerText.trim() === 'Editar'); const d = c.querySelector('.prod-del'); return e && d ? !!(e.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) : null; });
  check('cardápio admin: Editar vem antes da lixeira', ordem === true, String(ordem));
  await page.context().close();
});

// 24. Garçons no computador: sem vão entre a lista e o formulário
await step('garçons', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=waiters', { role: 'admin', width: 1280, height: 800 });
  await page.waitForTimeout(600);
  const gap = await page.evaluate(() => { const c = document.querySelector('.wd-grid .card'); const f = document.querySelector('.wd-cols .col-side'); return c && f ? f.getBoundingClientRect().left - c.getBoundingClientRect().right : null; });
  check('garçons: cartão vai até perto do formulário', gap !== null && gap <= 40, String(gap));
  await page.context().close();
});

// Itens baixos: contexto sem sessão (telas de entrada)
const semSessao = async (width = 390, height = 844) => { const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' }); await ctx.addInitScript(() => { try { sessionStorage.setItem('sunfood_abertura', '1'); } catch {} }); return ctx; };

// 25. Plurais sem "(s)"
await step('plurais', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=waiters', { role: 'admin', width: 1280, height: 800 });
  await page.waitForTimeout(600);
  const t = await text(page);
  check('garçons: "entregues · lançados" sem (s)', t.includes('entregues · ') && !/\(s\)/.test(t), t.match(/Hoje:[^\n]*/)?.[0]);
  await page.context().close();
});

// 26. Nenhum erro de SVG no console
await step('console', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const erros = [];
  ctx.on('console', m => { if (m.type() === 'error' && /attribute d/.test(m.text())) erros.push(m.text()); });
  const page = await open('app-cliente.dc.html?module=cliente&screen=menu', { context: ctx });
  const d = await page.locator('svg[viewBox="0 0 48 48"] path:visible').first().getAttribute('d').catch(() => null);
  check('console: sem erro de <path d> ao abrir o app', erros.length === 0, erros[0]);
  check('console: ícone do produto continua desenhado', !!d && d.startsWith('M'), String(d));
  await ctx.close();
});

// 27. Histórico: seta à direita e sem bolinha
await step('histórico', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=history', { seed: true });
  const row = page.locator('.orow').first();
  check('histórico: linha tem a seta de abrir', await row.locator('.orow-go').count() === 1);
  const bolinha = await row.evaluate(r => [...r.querySelectorAll(':scope > span')].some(s => s.offsetWidth === 10 && s.offsetHeight === 10));
  check('histórico: sem a bolinha amarela', !bolinha);
  await page.context().close();
});

// 28. Entrada no celular: botões logo abaixo dos cartões
await step('entrada no celular', async () => {
  const page = await open('index.html', { context: await semSessao() });
  const gap = await page.evaluate(() => { const c = document.querySelector('.lp-cats'); const b = document.querySelector('.lp-email'); return c && b ? b.getBoundingClientRect().top - c.getBoundingClientRect().bottom : null; });
  check('entrada: até 48 px entre os cartões e "Entrar com e-mail"', gap !== null && gap <= 48, String(gap));
  await page.context().close();
});

// 29. Cadastro: mesma marca da entrada e frase de apoio abaixo do título
await step('cadastro', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=signup', { context: await semSessao() });
  const r = await page.evaluate(() => { const l = [...document.querySelectorAll('.auth-logo')].find(e => e.offsetParent); const h = document.querySelector('.auth-box h1'); return { logo: l ? Math.round(l.querySelector('svg').getBoundingClientRect().width / l.currentCSSZoom) : 0, h1: h ? h.innerText : '', antes: !!h && [...document.querySelectorAll('body *')].some(e => e.offsetParent && e.children.length === 0 && /menos de um minuto/.test(e.innerText) && (e.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) }; });
  check('cadastro: logo de 22 px, igual à entrada', r.logo === 22, String(r.logo));
  check('cadastro: título "Criar conta" é <h1> e nada vem antes dele', r.h1 === 'Criar conta' && !r.antes, JSON.stringify(r));
  await page.context().close();
});

// 30. Observações do pedido sem cara de alerta
await step('observações', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=status', { seed: true });
  const cls = await page.getByText('Observações enviadas', { exact: true }).first().evaluate(b => b.parentElement.className);
  check('meu pedido: observações em bloco informativo', /alert-info/.test(cls) && !/alert-warn/.test(cls), cls);
  await page.context().close();
});

// 31. Títulos das telas do cliente são <h1>
await step('títulos h1', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=history', { seed: true });
  const h = await page.locator('h1:visible').allInnerTexts();
  check('histórico: o título é um <h1>', h.includes('Meus pedidos'), JSON.stringify(h));
  await page.context().close();
});

// 32. Diálogo pelo teclado (auditoria M13): o foco entra no botão que não
// apaga nada, Tab fica dentro do diálogo, Esc fecha e o foco volta ao botão
// que abriu.
await step('diálogo pelo teclado', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=closeDay', { role: 'admin', width: 1280, height: 800 });
  const abrir = page.locator('.btn-danger-ghost', { hasText: 'Encerrar o dia' }).last();
  await abrir.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=alertdialog]');
  await page.waitForTimeout(200);
  const foco = () => page.evaluate(() => ({ dentro: !!document.activeElement.closest('[aria-modal="true"]'), texto: document.activeElement.textContent.trim() }));
  let f = await foco();
  check('diálogo: o foco começa em "Continuar aberto"', f.dentro && f.texto === 'Continuar aberto', JSON.stringify(f));
  let sempreDentro = true;
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); if (!(await foco()).dentro) sempreDentro = false; }
  await page.keyboard.press('Shift+Tab');
  if (!(await foco()).dentro) sempreDentro = false;
  check('diálogo: Tab não sai do diálogo', sempreDentro);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('diálogo: Esc fecha', !(await page.locator('[role=alertdialog]').count()));
  f = await page.evaluate(() => document.activeElement.textContent.trim());
  check('diálogo: o foco volta ao botão que abriu', f === 'Encerrar o dia', f);
  await page.context().close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
