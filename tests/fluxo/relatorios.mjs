// Teste da exportação de relatórios num navegador de verdade (Chromium): o
// admin baixa a planilha (.csv para o Excel) e abre a versão para imprimir ou
// salvar como PDF, sempre do período escolhido e com a lista de pedidos.
// API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/relatorios.mjs   (a partir da raiz do repositório)
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

// Pedidos de mentira: o relatório falso vai de 05/10 (hoje) para trás.
const order = (id, createdAt, extra) => ({ id, tableNumber: 3, status: 'Entregue', subtotal: 50, total: 50, note: '', paymentMethod: 'pix',
  paymentStatus: 'approved', createdAt, updatedAt: createdAt, items: [{ productId: 'p1', name: 'Batata Frita', qty: 2, unitPrice: 25, note: '' }], ...extra });
const ORDERS = [
  order('101', '2026-10-05T15:30:00Z'), // 12h30 em São Paulo
  order('102', '2026-10-05T18:10:00Z', { status: 'Cancelado', paymentStatus: 'refunded', total: 22, items: [{ productId: 'p3', name: 'Caipirinha; "da casa"', qty: 1, unitPrice: 22, note: '' }] }),
  order('103', '2026-10-06T02:30:00Z', { paymentMethod: 'entrega', paymentStatus: 'pending', total: 1234.5 }), // 05/10 23h30 em SP
  order('104', '2026-10-01T13:00:00Z', { paymentMethod: 'cartao' }), // só entra em 7 dias
  order('105', '2026-08-01T13:00:00Z'), // fora até dos 30 dias
];

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: true });
  // A impressão de verdade abriria a janela do sistema: aqui só anota que foi chamada.
  await ctx.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  const page = await ctx.newPage();
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await ctx.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi('admin');
  api.db.orders.push(...ORDERS.map(o => ({ ...o })));
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  await page.addInitScript(() => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: 'admin@teste', name: 'Teste', role: 'admin' } })));
  await page.goto(BASE + 'app-cliente.dc.html?module=admin&screen=reports');
  await page.waitForTimeout(1500);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

async function downloadCsv(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('Exportar planilha', { exact: true }).click()]);
  const buf = Buffer.from(await (await dl.createReadStream()).toArray().then(c => Buffer.concat(c)));
  return { name: dl.suggestedFilename(), csv: buf.toString('utf8') };
}
async function openPdf(page) {
  const [win] = await Promise.all([page.context().waitForEvent('page'), page.getByText('Exportar PDF', { exact: true }).click()]);
  await win.waitForLoadState('load'); await win.waitForTimeout(700);
  return win;
}

// 1. Planilha de hoje: resumo, horários, mais vendidos e pedidos do dia
await step('planilha de hoje', async () => {
  const page = await open({ width: 1366, height: 900 });
  const t = await text(page);
  check('relatórios: botões Exportar planilha e Exportar PDF aparecem', t.includes('Exportar planilha') && t.includes('Exportar PDF'));
  const { name, csv } = await downloadCsv(page);
  check('planilha: nome do arquivo com a data', name === 'sunfood-relatorio-2026-10-05.csv', name);
  check('planilha: começa com BOM (acentos certos no Excel)', csv.charCodeAt(0) === 0xFEFF);
  const lines = csv.slice(1).split('\r\n');
  check('planilha: separador ";" e período', lines[1] === 'Período;Hoje (05/10/2026)', lines[1]);
  check('planilha: faturamento com vírgula decimal', lines.includes('Faturamento (R$);120,00'), lines.slice(5, 10).join(' | '));
  check('planilha: horário de pico', lines.includes('12h às 13h;2;80,00'));
  check('planilha: mais vendidos', lines.includes('1;Batata Frita;5;125,00'));
  const head = 'Código;Data;Hora;Mesa;Itens;Total (R$);Status;Forma de pagamento;Pagamento;Entra nas vendas';
  const rows = lines.slice(lines.indexOf(head) + 1).filter(Boolean);
  check('planilha: lista os 3 pedidos de hoje (horário de São Paulo)', rows.length === 3 && rows[0].startsWith('#101;05/10/2026;12:30;3;2x Batata Frita;50,00;Entregue;PIX;Pago no app (PIX);Sim'), rows.join(' | '));
  check('planilha: cancelado/estornado aparece com "Não" e aspas no item com ;', rows[1] === '#102;05/10/2026;15:10;3;"1x Caipirinha; ""da casa""";22,00;Cancelado;PIX;Estornado (PIX);Não', rows[1]);
  check('planilha: pedido das 23h30 de SP conta no dia 05/10', rows[2].startsWith('#103;05/10/2026;23:30') && rows[2].includes(';1234,50;') && rows[2].endsWith('Cobrar na entrega;Sim'), rows[2]);
  check('planilha: resumo por escrito com vendas, faturamento e ticket', lines.includes('RESUMO POR ESCRITO') &&
    lines.includes('Hoje (05/10/2026), o quiosque fez 3 vendas, com faturamento de R$ 120,00.') &&
    lines.includes('O ticket médio foi de R$ 40,00 por pedido e foram vendidos 6 itens.'), lines.slice(4, 14).join(' | '));
  check('planilha: resumo por escrito com pico, mais vendido e pagamentos', lines.includes('O horário de mais movimento foi das 12h às 13h, com 2 pedidos.') &&
    lines.includes('O produto mais vendido foi Batata Frita (5 unidades, R$ 125,00), seguido de Água de Coco (2 unidades).') &&
    lines.includes('Formas de pagamento das vendas: PIX 1, Na entrega 1.') &&
    lines.includes('Ao todo, 3 pedidos foram feitos no período: 1 cancelado ou estornado, e não entram nas vendas.'), lines.slice(4, 14).join(' | '));
  check('planilha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.context().close();
});

// 2. Muda para 7 e 30 dias: o arquivo acompanha o período escolhido
await step('planilha 7 e 30 dias', async () => {
  const page = await open({ width: 1366, height: 900 });
  await click(page, 'Últimos 7 dias');
  let { name, csv } = await downloadCsv(page);
  check('planilha 7 dias: nome com o intervalo', name === 'sunfood-relatorio-2026-09-29-a-2026-10-05.csv', name);
  check('planilha 7 dias: período e vendas por dia', csv.includes('Últimos 7 dias (29/09/2026 a 05/10/2026)') && csv.includes('29/09/2026;1;40,00'));
  check('planilha 7 dias: inclui o pedido de 01/10 e não o de agosto', csv.includes('#104;01/10/2026') && csv.includes(';Cartão;') && !csv.includes('#105'));
  await click(page, 'Últimos 30 dias');
  ({ csv } = await downloadCsv(page));
  check('planilha 30 dias: período certo e sem o pedido de agosto', csv.includes('Últimos 30 dias (06/09/2026 a 05/10/2026)') && !csv.includes('#105') && csv.includes('#104'));
  await page.context().close();
});

// 3. PDF em celular, tablet e computador: abre a versão para imprimir e chama a impressão
for (const [nome, viewport] of [['celular', { width: 375, height: 800 }], ['tablet', { width: 768, height: 1000 }], ['computador', { width: 1366, height: 900 }]]) {
  await step(`pdf ${nome}`, async () => {
    const page = await open(viewport);
    const btns = await Promise.all(['Exportar planilha', 'Exportar PDF'].map(t => page.getByText(t, { exact: true }).boundingBox()));
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`relatórios ${nome}: botões cabem na tela, sem rolagem lateral`, btns.every(b => b && b.x >= 0 && b.x + b.width <= viewport.width && b.height >= 36) && scroll <= 0, JSON.stringify({ btns, scroll }));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/relatorios-${nome}.png` });
    await click(page, 'Últimos 7 dias');
    const win = await openPdf(page);
    const w = await win.locator('body').innerText();
    check(`pdf ${nome}: título, período e resumo`, w.includes('Relatório de vendas · Sunfood') && w.includes('Últimos 7 dias (29/09/2026 a 05/10/2026)') && w.includes('R$ 360,00'), w.slice(0, 300));
    check(`pdf ${nome}: resumo por escrito com melhor dia e média`, w.includes('Resumo por escrito') && w.includes('Nos últimos 7 dias (29/09/2026 a 05/10/2026), o quiosque fez 9 vendas, com faturamento de R$ 360,00.') &&
      w.includes('O melhor dia foi 05/10/2026, com R$ 120,00 em 3 pedidos. Houve venda em 7 de 7 dias, uma média de R$ 51,43 por dia.'), w.slice(0, 900));
    check(`pdf ${nome}: vendas por dia, horários e mais vendidos`, w.includes('Vendas por dia') && w.includes('12h às 13h') && w.includes('Batata Frita'));
    check(`pdf ${nome}: lista os 4 pedidos do período`, w.includes('Pedidos do período (4)') && w.includes('#104') && w.includes('R$ 1.234,50') && !w.includes('#105'));
    check(`pdf ${nome}: abre a impressão (salvar como PDF)`, await win.evaluate(() => window.__printed) === 1);
    const wScroll = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`pdf ${nome}: página sem rolagem lateral`, wScroll <= 0, String(wScroll));
    if (process.env.SHOTS) {
      await win.screenshot({ path: `${process.env.SHOTS}/relatorio-pdf-${nome}.png`, fullPage: true });
      if (nome === 'computador') await win.pdf({ path: `${process.env.SHOTS}/relatorio.pdf`, format: 'A4' });
    }
    check(`pdf ${nome}: sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.context().close();
  });
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
