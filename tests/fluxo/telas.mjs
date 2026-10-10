// Teste de fluxo das telas do Sunfood num navegador de verdade (Chromium),
// com uma API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/telas.mjs   (a partir da raiz do repositório)
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

async function open(path, { role, seed, session = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente');
  if (seed) api.seed();
  await page.route('http://localhost:8787/**', api);
  page.api = api;
  if (role && role !== 'cliente' && session) await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }

// 1. Páginas do site abrem sem erro de JavaScript
for (const p of ['index.html', 'inicio.html', 'sobre.html', 'funcionalidades.html', 'como-funciona.html', 'perfis.html', 'mapa.html', 'contato.html', 'termos.html', 'privacidade.html', 'redefinir-senha.html']) {
  const page = await open(p);
  check(`página ${p} abre sem erro`, page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();
}

// 1b. O endereço principal (index.html) é a tela de login, para os três perfis
await step('login no endereço principal', async () => {
  const page = await open('');
  check('raiz: abre a tela de login', (await text(page)).includes('Bem-vindo de volta'));
  await click(page, 'Entrar', true);
  check('raiz: pede e-mail e senha embaixo de cada campo', (await text(page)).includes('Informe seu e-mail.') && (await text(page)).includes('Informe sua senha.')
    && await page.locator('#email').getAttribute('aria-invalid') === 'true' && await page.evaluate(() => document.activeElement.id) === 'email');
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  await page.waitForTimeout(1200);
  check('raiz: cliente cai no cardápio', page.url().includes('module=cliente&screen=menu') && (await text(page)).includes('Batata Frita'), page.url());
  check('raiz: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();

  for (const [role, dest] of [['admin', 'module=admin&screen=dashboard'], ['cozinha', 'module=cozinha&screen=kanban']]) {
    const p = await open('', { role, session: false });
    await p.getByPlaceholder('voce@email.com').fill(role + '@teste');
    await p.getByPlaceholder('••••••••').fill('senha');
    await click(p, 'Entrar', true);
    await p.waitForTimeout(800);
    check(`raiz: ${role} cai no módulo certo`, p.url().includes(dest), p.url());
    await p.close();
  }

  const salvo = await open('', { role: 'cozinha' });
  check('raiz: quem já entrou vai direto para o seu módulo', salvo.url().includes('module=cozinha&screen=kanban'), salvo.url());
  await salvo.close();

  const inicio = await open('inicio.html');
  check('inicio.html: endereço antigo abre Conheça o Sunfood no login', inicio.url() === BASE + '#conheca' && (await text(inicio)).includes('Um sistema, três telas de trabalho'), inicio.url());
  await inicio.locator('#info').getByText('Entrar', { exact: true }).click(); await inicio.waitForTimeout(300);
  check('Conheça o Sunfood: Entrar fecha o painel e volta ao login', inicio.url() === BASE && await inicio.locator('#info').isHidden() && (await text(inicio)).includes('Bem-vindo de volta'), inicio.url());
  await inicio.close();

  const app = await open('app-cliente.dc.html', { role: 'admin', session: false });
  await app.getByPlaceholder('voce@email.com').fill('admin@teste');
  await app.getByPlaceholder('••••••••').fill('senha');
  await click(app, 'Entrar', true);
  await app.waitForTimeout(800);
  check('login do app: admin vai para o painel', app.url().includes('module=admin&screen=dashboard'), app.url());
  await app.close();
});

// 1c. Links do rodapé do login abrem o conteúdo no próprio login
await step('rodapé do login', async () => {
  const page = await open('');
  for (const [link, trecho, hash] of [['Conheça o Sunfood', 'O que o quiosque ganha', '#conheca'], ['Termos de uso', 'Cancelamento de pedidos', '#termos'], ['Privacidade', 'Seus direitos como titular', '#privacidade'], ['Fale conosco', 'Dúvida, reserva ou suporte?', '#fale-conosco']]) {
    await page.locator('nav.foot').getByText(link, { exact: true }).click();
    await page.waitForTimeout(300);
    const t = await page.locator('#info').innerText();
    check(`rodapé: ${link} abre no login`, page.url() === BASE + hash && t.includes(trecho), page.url());
    if (hash !== '#fale-conosco') { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  }
  await page.locator('.tab', { hasText: 'Termos de uso' }).click(); await page.waitForTimeout(300);
  check('painel: abas trocam de seção', page.url() === BASE + '#termos' && (await page.locator('#info').innerText()).includes('Natureza do serviço'));
  await page.locator('.tab', { hasText: 'Fale conosco' }).click(); await page.waitForTimeout(300);
  // Os motivos do formulário precisam ser os mesmos aceitos pela API (CONTACT_REASONS em server/src).
  const motivos = await page.locator('#c-motivo option').allInnerTexts();
  check('fale conosco: motivos iguais aos aceitos pela API', JSON.stringify(motivos) === JSON.stringify(['Reservar mesa ou guarda-sol', 'Tirar dúvida sobre o cardápio', 'Dúvida sobre pagamento', 'Suporte com um pedido em andamento', 'Parceria com meu quiosque']), motivos.join(' | '));
  await page.fill('#c-nome', 'Bruna Lima');
  await page.fill('#c-contato', 'abc');
  await page.fill('#c-msg', 'Quero reservar uma mesa para 6 pessoas no sábado.');
  await click(page, 'Enviar mensagem', true);
  check('fale conosco: contato inválido não envia', page.api.db.contacts.length === 0 && (await text(page)).includes('Informe um e-mail válido'));
  await page.fill('#c-contato', '(13) 98888-7777');
  await click(page, 'Enviar mensagem', true);
  await page.waitForTimeout(400);
  const t = await text(page);
  check('fale conosco: mensagem gravada pela API', page.api.db.contacts.length === 1 && page.api.db.contacts[0].name === 'Bruna Lima' && page.api.db.contacts[0].reason === 'Reservar mesa ou guarda-sol', JSON.stringify(page.api.db.contacts));
  check('fale conosco: mostra o protocolo do servidor', t.includes('Recebemos sua mensagem, Bruna') && t.includes('SF-100001'));
  await page.keyboard.press('Escape');
  check('rodapé: Esc fecha o painel', page.url() === BASE && await page.locator('#info').isHidden());
  check('rodapé: sem erro de JavaScript', page.jsErrors.length === 0, page.jsErrors.join(' | '));
  await page.close();

  const fora = await open('#fale-conosco');
  await fora.unroute('http://localhost:8787/**');
  await fora.route('http://localhost:8787/**', r => r.abort());
  await fora.fill('#c-nome', 'Bruna'); await fora.fill('#c-contato', 'bruna@email.com'); await fora.fill('#c-msg', 'Mensagem com servidor fora do ar.');
  await click(fora, 'Enviar mensagem', true);
  check('fale conosco: avisa quando o servidor está fora do ar', (await text(fora)).includes('Sem conexão com o servidor'));
  await fora.close();

  // Quem já entrou e abre os termos pelo app vê os termos, não é mandado para o app.
  const logado = await open('termos.html', { role: 'cozinha' });
  check('termos.html: abre os termos mesmo com sessão salva', logado.url() === BASE + '#termos' && (await text(logado)).includes('Legislação aplicável e foro'), logado.url());
  await logado.close();
});

// 1c. Logo do Sunfood: sem login leva à tela de login; logado, ao início de cada perfil
await step('logo do Sunfood', async () => {
  const logo = page => page.locator('.brand:visible, .adm-brand:visible').first();
  const anon = await open('app-cliente.dc.html?module=cliente&screen=signup');
  await logo(anon).click(); await anon.waitForTimeout(800);
  check('logo sem login: vai para a tela de login', anon.url() === BASE && (await text(anon)).includes('Bem-vindo de volta'), anon.url());
  await anon.close();

  const cli = await open('app-cliente.dc.html');
  await cli.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await cli.getByPlaceholder('••••••••').fill('senha');
  await click(cli, 'Entrar', true);
  await click(cli, 'Perfil', true);
  await logo(cli).click(); await cli.waitForTimeout(500);
  check('logo do cliente logado: volta ao cardápio', (await text(cli)).includes('Batata Frita'), (await text(cli)).slice(0, 160));
  await cli.close();

  for (const [role, dest] of [['admin', 'module=admin&screen=dashboard'], ['cozinha', 'module=cozinha&screen=kanban']]) {
    const p = await open(`app-cliente.dc.html?module=${role}&screen=${role === 'admin' ? 'orders' : 'kanban'}`, { role, seed: true });
    await logo(p).click(); await p.waitForTimeout(1200);
    check(`logo de ${role} logado: vai para o início do módulo`, p.url().includes(dest), p.url());
    await p.close();
  }

  const ini = await open('#termos');
  await ini.locator('#info-title').click(); await ini.waitForTimeout(600);
  check('logo do painel do rodapé: volta ao login', ini.url() === BASE && await ini.locator('#info').isHidden(), ini.url());
  await ini.close();
});

// 2. Cliente: login -> cardápio -> carrinho -> mesa -> PIX -> confirmação
await step('fluxo do cliente', async () => {
  const page = await open('app-cliente.dc.html');
  await page.getByPlaceholder('voce@email.com').fill('ana@email.com');
  await page.getByPlaceholder('••••••••').fill('senha');
  await click(page, 'Entrar', true);
  let t = await text(page);
  check('cliente: login abre o cardápio', t.includes('Batata Frita') && t.includes('Água de Coco'));
  check('cliente: item sem estoque aparece como Esgotado', /Açaí[\s\S]*Esgotado/.test(t));
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  t = await text(page);
  check('cliente: carrinho soma subtotal + 10% de taxa', t.includes('R$ 50,00') && t.includes('R$ 5,00') && t.includes('R$ 55,00'));
  await click(page, 'Ir para pagamento');
  t = await text(page);
  check('cliente: aviso de mesas ativas vem do cadastro de mesas', t.includes('Mesas ativas: 1, 3 a 5.'), (t.match(/Mesas? ativas?:[^\n]*/) || [])[0]);
  await page.getByPlaceholder('00').fill('2');
  await click(page, 'Confirmar mesa');
  check('cliente: mesa inativa é recusada', !(await text(page)).includes('Total do pedido · Mesa 2'));
  await page.getByPlaceholder('00').fill('1');
  await click(page, 'Confirmar mesa');
  check('cliente: mesa ativa leva ao pagamento', (await text(page)).includes('Mesa 1'));
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$');
  const sent = page.api.db.orders[0];
  check('cliente: pedido enviado com mesa e itens certos', sent && sent.tableNumber === 1 && sent.items[0].productId === 'p1' && sent.items[0].qty === 2, JSON.stringify(sent?.items));
  t = await text(page);
  check('cliente: tela do PIX abre', t.includes('Pagamento via PIX'));
  check('cliente: tela do PIX mostra o valor do pedido (R$ 55,00)', /Valor a pagar\s*R\$ 55,00/.test(t), (t.match(/Valor a pagar\s*(R\$ [\d,.]+)/) || [])[1]);
  check('cliente: tela do PIX mostra o código copia-e-cola', t.includes('Copiar código PIX'));
  check('cliente: sem pagamento ainda, não confirma', !t.includes('Pedido confirmado'));
  page.api.approvePayment(sent.id);
  await page.waitForTimeout(3500);
  t = await text(page);
  check('cliente: pagamento aprovado leva à confirmação sozinho', t.includes('Pedido confirmado'), t.slice(0, 200));
  check('cliente: sem erro de JavaScript no fluxo', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

// 3. Cozinha: kanban avança Na Fila -> Em Preparo -> Pronto -> Entregue
await step('fluxo da cozinha', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  check('cozinha: pedido aparece na fila com observação', (await text(page)).includes('Obs: sem sal'));
  check('cozinha: cartão mostra o nome de quem pediu', (await text(page)).includes('Ana Teste'));
  await click(page, 'Iniciar preparo'); await click(page, 'Marcar como pronto'); await click(page, 'Marcar como entregue');
  check('cozinha: pedido chega a Entregue', page.api.db.orders[0].status === 'Entregue', page.api.db.orders[0].status);
  check('cozinha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
  await page.close();
});

// 4. Admin: todas as telas renderizam
for (const sc of ['dashboard', 'orders', 'payments', 'messages', 'productForm', 'tables', 'pause', 'reports', 'perfOps', 'closeDay']) {
  await step(`admin ${sc}`, async () => {
    const page = await open(`app-cliente.dc.html?module=admin&screen=${sc}`, { role: 'admin', seed: true });
    const err = page.jsErrors.join(' | ') || await renderError(page);
    check(`admin: tela ${sc} abre sem erro`, !err, err);
    await page.close();
  });
}

// 5. Admin: relatórios (vendas, mais vendidos, horários de pico, troca de período)
await step('admin relatórios', async () => {
  const page = await open('app-cliente.dc.html?module=admin&screen=reports', { role: 'admin', seed: true });
  let t = await text(page);
  check('relatórios: mostra faturamento de hoje', t.includes('R$ 120,00') && t.includes('Itens vendidos'), t.slice(0, 300));
  check('relatórios: mostra o horário de pico', t.includes('Mais movimento: 12h às 13h (2 pedidos)'), t.slice(0, 600));
  check('relatórios: mostra os mais vendidos com quantidade', t.includes('Batata Frita') && t.includes('5 un.'));
  check('relatórios: hoje não mostra gráfico por dia', !t.includes('Vendas por dia'));
  await click(page, 'Últimos 7 dias');
  await page.waitForTimeout(500);
  t = await text(page);
  check('relatórios: troca para 7 dias', page.api.db.lastReportPeriod === '7d' && t.includes('Vendas por dia') && t.includes('35 un.'), page.api.db.lastReportPeriod);
  check('relatórios: mostra o intervalo de datas', t.includes('29/09 a 05/10'));
  await click(page, 'Últimos 30 dias');
  t = await text(page);
  check('relatórios: troca para 30 dias', page.api.db.lastReportPeriod === '30d' && t.includes('150 un.'));
  check('relatórios: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

// 6. Mensagens do Fale conosco (enviadas pelo painel do login, ver 1c): o admin lê e marca como respondida
await step('fale conosco', async () => {
  const admin = await open('app-cliente.dc.html?module=admin&screen=messages', { role: 'admin' });
  admin.api.db.contacts.push({ id: 'c1', protocol: 'SF-100001', name: 'Bruna Lima', contact: '(13) 98888-7777', reason: 'Reservar mesa ou guarda-sol', message: 'Mesa para 6 no sábado.', status: 'novo', createdAt: new Date().toISOString() });
  // No celular o menu do admin fica atrás do botão "Menu" (sem arrastar para os lados).
  await click(admin, 'Menu', true); await click(admin, 'Pagamentos', true);
  check('admin no celular: menu fecha depois de escolher', await admin.locator('.adm-item').first().isHidden());
  await click(admin, 'Menu', true); await click(admin, 'Mensagens', true);
  let a = await text(admin);
  check('admin mensagens: mostra a mensagem nova', a.includes('Bruna Lima') && a.includes('Mesa para 6 no sábado.') && a.includes('Novas (1)'), a.slice(0, 500));
  await click(admin, 'Marcar como respondida');
  a = await text(admin);
  check('admin mensagens: marca como respondida', admin.api.db.contacts[0].status === 'respondido' && a.includes('Nenhuma mensagem nova.'));
  await click(admin, 'Respondidas');
  check('admin mensagens: aparece em Respondidas', (await text(admin)).includes('Bruna Lima'));
  check('admin mensagens: sem erro de JavaScript', admin.jsErrors.length === 0 && !(await renderError(admin)), admin.jsErrors.join(' | '));
  await admin.close();
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
