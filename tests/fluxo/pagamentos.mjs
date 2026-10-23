// Teste de fluxo das telas do SunFood num navegador de verdade (Chromium),
// com uma API falsa em memória: nada sai da máquina, nada vai pro banco.
// Uso: node tests/fluxo/pagamentos.mjs   (a partir da raiz do repositório)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, FAKE_CHECKOUT_URL } from './fake-api.mjs';

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

async function open(path, { role, seed, session, stripe = true, stripeTest = false, stripeInApp = false, viewport = { width: 400, height: 860 }, setup } = {}) {
  const page = await browser.newPage({ viewport, serviceWorkers: 'block' }); // o app instalável (service worker) tem teste próprio em pwa.mjs
  page.jsErrors = [];
  page.on('pageerror', e => page.jsErrors.push(e.message));
  if (CDN) await page.route('https://unpkg.com/**', r => {
    const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1');
    r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const api = fakeApi(role || 'cliente', { stripe, stripeTest, stripeInApp });
  // Stripe.js falso: desenha um campo no lugar do quadro do Stripe e responde
  // ao confirmPayment (recusa se window.__stripeRecusa estiver ligado). Como o
  // Stripe.js de verdade, lança erro se o campo foi criado sem endereço
  // (address:'never') e o confirmPayment não manda o endereço.
  await page.route('https://js.stripe.com/**', r => r.fulfill({ contentType: 'application/javascript', body: `
    window.Stripe = function(pk){ window.__stripePk = pk; var semEndereco = false; return {
      elements: function(o){ window.__stripeOpts = o; window.__stripeUpdates = []; window.__stripeSubmits = 0; return {
        update: function(u){ window.__stripeUpdates.push(u); Object.assign(window.__stripeOpts, u); },
        submit: function(){ window.__stripeSubmits++; return Promise.resolve({}); },
        create: function(t, eo){ semEndereco = !!(eo && eo.fields && eo.fields.billingDetails && eo.fields.billingDetails.address === 'never'); var h = {}, at = null; window.__stripeHandlers = h; return {
        on: function(ev, cb){ h[ev] = cb; },
        mount: function(el){ at = el; window.__stripeMounts = (window.__stripeMounts || 0) + 1; el.innerHTML = '<div class="fake-stripe" style="height:120px;border:1px solid #8F8676;border-radius:8px;padding:12px">Número do cartão</div>'; setTimeout(function(){ h.ready && h.ready(); }, 30); },
        unmount: function(){ if(at) at.innerHTML = ''; at = null; }, destroy: function(){ if(at) at.innerHTML = ''; } }; } }; },
      confirmPayment: function(a){ window.__stripeConfirm = a;
        if(!window.__stripeSubmits) throw new Error('IntegrationError: elements.submit() must be called before stripe.confirmPayment()');
        var bd = a.confirmParams && a.confirmParams.payment_method_data && a.confirmParams.payment_method_data.billing_details;
        if(semEndereco && !window.__stripeSaved && !(bd && bd.address)) throw new Error('IntegrationError: You specified "never" for fields.billing_details.address');
        return Promise.resolve(window.__stripeRecusa ? { error: { type: 'card_error', message: 'Seu cartão foi recusado.' } } : { paymentIntent: { status: 'succeeded' } }); }
    }; };` }));
  if (seed) api.seed();
  if (setup) setup(api.db);
  await page.route('http://localhost:8787/**', api);
  await page.route(FAKE_CHECKOUT_URL, r => r.fulfill({ contentType: 'text/html', body: '<h1>Checkout Stripe (teste)</h1>' }));
  page.api = api;
  if ((role && role !== 'cliente') || session) await page.addInitScript(r => localStorage.setItem('sunfood_session',
    JSON.stringify({ token: 'tok', user: { id: 'u1', email: r + '@teste', name: 'Teste', role: r } })), role);
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}
const text = page => page.locator('body').innerText();
const renderError = page => page.evaluate(() => document.querySelector('.sc-logic-error')?.innerText || null);
const click = async (page, t, exact = false) => { await page.getByText(t, { exact }).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split("\n")[0]); } }

async function ateOPagamento(page) {
  await page.getByLabel('E-mail', { exact: true }).fill('ana@email.com');
  await page.getByLabel('Senha', { exact: true }).fill('senha');
  await click(page, 'Entrar', true);
  await click(page, '+', true); await click(page, '+', true);
  await click(page, 'itens no carrinho');
  await click(page, 'Escolher a mesa');
  await page.getByLabel('Número da mesa', { exact: true }).fill('1');
  await click(page, 'Escolher pagamento');
}

await step('pagar na entrega', async () => {
  const page = await open('app-cliente.dc.html');
  await ateOPagamento(page);
  let t = await text(page);
  check('opções: PIX, cartão e na entrega (sem Apple/Google Pay)', t.includes('PIX') && t.includes('Cartão de crédito ou débito') && t.includes('Pagar na entrega') && !t.includes('Apple'));
  await click(page, 'Pagar na entrega', true);
  await click(page, 'Fazer pedido');
  const o = page.api.db.orders[0];
  check('entrega: pedido enviado com paymentMethod=entrega', o && o.paymentMethod === 'entrega', JSON.stringify(o?.paymentMethod));
  t = await text(page);
  check('entrega: confirmação diz para pagar ao garçom', t.includes('Pague ao garçom') && t.includes('A pagar na entrega'));
  await click(page, 'Acompanhar pedido');
  await click(page, 'Cancelar pedido');
  t = await text(page);
  check('entrega: cancelar não promete estorno', t.includes('Nada a estornar'));
  check('entrega: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('cartão', async () => {
  const page = await open('app-cliente.dc.html');
  await ateOPagamento(page);
  await click(page, 'Cartão de crédito ou débito', true);
  await click(page, 'Pagar R$');
  const o = page.api.db.orders[0];
  check('cartão: pedido enviado com paymentMethod=cartao', o && o.paymentMethod === 'cartao');
  check('cartão: pede checkout com volta pro próprio app', /app-cliente\.dc\.html\?module=cliente&screen=card$/.test(page.api.db.cardReturnUrl || ''), page.api.db.cardReturnUrl);
  check('cartão: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.waitForURL(FAKE_CHECKOUT_URL, { timeout: 5000 }).catch(() => {});
  check('cartão: leva pro checkout do Stripe (cartão digitado lá, não no app)', page.url() === FAKE_CHECKOUT_URL, page.url());
  await page.close();
});

await step('volta do checkout', async () => {
  const page = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=approved', { role: 'cliente', seed: true, session: true });
  await page.waitForTimeout(1500);
  check('volta aprovada: vai para a confirmação', (await text(page)).toLowerCase().includes('pedido confirmado'), (await text(page)).slice(0, 200));
  check('volta: limpa os parâmetros da URL', !page.url().includes('pedido='));
  await page.close();
  const p2 = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=failure', { role: 'cliente', seed: true, session: true });
  p2.api.db.orders[0].paymentStatus = 'pending';
  await p2.waitForTimeout(800);
  check('volta sem pagar: mostra pagamento não concluído', (await text(p2)).includes('não foi concluído'));
  check('volta: sem erro de JavaScript', p2.jsErrors.length === 0 && !(await renderError(p2)), p2.jsErrors.join(' | ') || await renderError(p2));
  await p2.close();
});

await step('cozinha vê se está pago', async () => {
  const page = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha', seed: true });
  const now = new Date().toISOString();
  const item = [{ productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' }];
  page.api.db.orders.push(
    { id: 'o10', tableNumber: 1, status: 'Na Fila', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o11', tableNumber: 1, status: 'Na Fila', total: 99.99, note: 'NAOPAGO', paymentMethod: 'pix', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item });
  await page.waitForTimeout(3800);
  const t = await text(page);
  check('cozinha: selo "Pago no app (PIX)"', t.includes('Pago no app (PIX)'));
  check('cozinha: selo "Cobrar na entrega"', t.includes('Cobrar na entrega · R$ 13,20'));
  check('cozinha: PIX não pago não aparece', !t.includes('NAOPAGO'));
  check('cozinha: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('sem Stripe', async () => {
  const page = await open('app-cliente.dc.html', { stripe: false });
  await ateOPagamento(page);
  let t = await text(page);
  check('sem Stripe: mostra PIX, cartão e na entrega', t.includes('Pagar na entrega') && t.includes('Cartão de crédito ou débito') && t.includes('Pague agora pelo app do banco'), t.slice(0, 300));
  await click(page, 'Cartão de crédito ou débito', true);
  await click(page, 'Pagar R$');
  await page.waitForTimeout(3500);
  const o = page.api.db.orders[0];
  check('sem Stripe: cartão aprovado na hora como provisório', o && o.paymentMethod === 'cartao' && o.paymentStatus === 'approved' && o.paymentProvider === 'provisorio', JSON.stringify(o));
  t = await text(page);
  check('sem Stripe: cliente vai direto para a confirmação', t.toLowerCase().includes('pedido confirmado'), t.slice(0, 200));
  check('sem Stripe: confirmação não diz "Total pago" quando nada foi cobrado', t.includes('Total (nada foi cobrado)') && !t.includes('Total pago'), t.slice(0, 400));
  await click(page, 'Acompanhar pedido');
  t = await text(page);
  check('sem Stripe: acompanhamento avisa que nada foi cobrado', t.includes('Pedido aceito sem cobrança') && !t.includes('Cartão confirmado'), t.slice(0, 400));
  await click(page, 'Cancelar pedido');
  check('sem Stripe: cancelar cartão provisório não promete estorno', (await text(page)).includes('Nada a estornar'));
  check('sem Stripe: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('PIX sem Stripe', async () => {
  const page = await open('app-cliente.dc.html', { stripe: false });
  await ateOPagamento(page);
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$');
  await page.waitForTimeout(3500);
  const o = page.api.db.orders[0];
  check('sem Stripe: PIX aprovado na hora como provisório', o && o.paymentMethod === 'pix' && o.paymentStatus === 'approved' && o.paymentProvider === 'provisorio', JSON.stringify(o));
  const t = await text(page);
  check('sem Stripe: PIX vai direto para a confirmação', t.toLowerCase().includes('pedido confirmado'), t.slice(0, 200));
  check('sem Stripe (PIX): sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('tela de Pagamentos do admin', async () => {
  const admin = await open('app-cliente.dc.html?module=admin&screen=payments', { role: 'admin', stripe: false });
  const now = new Date().toISOString();
  const item = [{ productId: 'p2', name: 'Água de Coco', qty: 1, unitPrice: 12, note: '' }];
  admin.api.db.orders.push(
    { id: 'o20', tableNumber: 3, status: 'Entregue', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o21', tableNumber: 4, status: 'Cancelado', total: 50, note: '', paymentMethod: 'entrega', paymentStatus: 'pending', createdAt: now, updatedAt: now, items: item },
    { id: 'o23', tableNumber: 5, status: 'Na Fila', total: 22, note: '', paymentMethod: 'cartao', paymentStatus: 'approved', paymentProvider: 'provisorio', createdAt: now, updatedAt: now, items: item });
  await admin.reload(); await admin.waitForTimeout(1500);
  let t = await text(admin);
  check('admin: menu tem "Pagamentos"', t.includes('Pagamentos'));
  check('admin: avisa que PIX e cartão estão sem meio de pagamento (provisório)', t.includes('Sem meio de pagamento configurado para PIX e cartão'));
  check('admin: cartão provisório aparece separado', t.includes('Cartão provisório (sem cobrança) · R$ 22,00') && /Provisório hoje \(PIX\/cartão\)\s*R\$ 22,00/.test(t));
  check('admin: lista todos os pedidos, inclusive cancelado', t.includes('#o20') && t.includes('#o21'));
  check('admin: "A receber na entrega" soma R$ 13,20', /A receber na entrega\s*R\$ 13,20/.test(t), t.slice(0, 400));
  check('admin: cancelado não tem botão de receber', (await admin.getByText('Dinheiro', { exact: true }).count()) === 1);
  await click(admin, 'Dinheiro', true);
  await admin.waitForTimeout(500);
  t = await text(admin);
  const o = admin.api.db.orders.find(o => o.id === 'o20');
  check('admin: marca recebido em dinheiro', o.paymentStatus === 'approved' && o.receivedWith === 'dinheiro');
  check('admin: mostra "Recebido na entrega (dinheiro)"', t.includes('Recebido na entrega (dinheiro)'));
  check('admin: "Recebido hoje" passa a R$ 13,20', /Recebido hoje\s*R\$ 13,20/.test(t));
  await click(admin, 'Desfazer', true);
  await admin.waitForTimeout(500);
  check('admin: desfazer volta para "a receber"', o.paymentStatus === 'pending' && !o.receivedWith && (await text(admin)).includes('Cobrar na entrega'));
  await admin.locator('.pay-pills .fpill').filter({ hasText: 'A receber' }).click(); await admin.waitForTimeout(300);
  t = await admin.locator('.pay-wrap').innerText();
  check('admin: filtro "A receber" mostra só o que falta receber', t.includes('#o20') && !t.includes('#o21') && !t.includes('#o23'), t.slice(0, 300));
  await admin.locator('.pay-pills .fpill').filter({ hasText: 'Estornos e cancelados' }).click(); await admin.waitForTimeout(300);
  t = await admin.locator('.pay-wrap').innerText();
  check('admin: filtro "Estornos e cancelados" mostra o cancelado', t.includes('#o21') && !t.includes('#o20'), t.slice(0, 300));
  await admin.locator('.pay-pills .fpill').filter({ hasText: 'Todos' }).click(); await admin.waitForTimeout(300);
  for (const [nome, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    await admin.setViewportSize(viewport); await admin.waitForTimeout(300);
    const btn = await admin.getByText('Dinheiro', { exact: true }).boundingBox();
    const scroll = await admin.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`admin ${nome}: Pagamentos sem rolagem lateral e botões com altura de toque`, scroll <= 0 && btn && btn.height >= (viewport.width < 768 ? 48 : 40) && btn.x + btn.width <= viewport.width, JSON.stringify({ btn, scroll }));
    if (process.env.SHOTS_DIR) await admin.screenshot({ path: `${process.env.SHOTS_DIR}/admin-pagamentos-${nome}.png`, fullPage: true });
  }
  check('admin: sem erro de JavaScript', admin.jsErrors.length === 0 && !(await renderError(admin)), admin.jsErrors.join(' | ') || await renderError(admin));
  await admin.close();

  const kitchen = await open('app-cliente.dc.html?module=cozinha&screen=kanban', { role: 'cozinha' });
  kitchen.api.db.orders.push({ id: 'o22', tableNumber: 1, status: 'Na Fila', total: 13.2, note: '', paymentMethod: 'entrega', paymentStatus: 'approved', receivedWith: 'cartao', createdAt: now, updatedAt: now, items: item });
  await kitchen.waitForTimeout(3800);
  check('cozinha: selo "Recebido na entrega (cartão)"', (await text(kitchen)).includes('Recebido na entrega (cartão)'));
  await kitchen.close();
});

await step('prazo de cancelamento', async () => {
  const admin = await open('app-cliente.dc.html?module=admin&screen=pause', { role: 'admin' });
  let t = await text(admin);
  check('admin: mostra o prazo atual (sem prazo)', t.includes('Prazo para o cliente cancelar') && t.includes('sem prazo'));
  await admin.getByLabel('Prazo para cancelar, em minutos', { exact: true }).fill('5');
  await click(admin, 'Salvar', true);
  t = await text(admin);
  check('admin: salva 5 minutos', admin.api.db.kiosk.cancelWindowMinutes === 5 && t.includes('5 min depois do pedido'), String(admin.api.db.kiosk.cancelWindowMinutes));
  await admin.getByLabel('Prazo para cancelar, em minutos', { exact: true }).fill('abc');
  await click(admin, 'Salvar', true);
  check('admin: recusa valor inválido', (await text(admin)).includes('número inteiro de minutos'));
  check('admin: sem erro de JavaScript', admin.jsErrors.length === 0 && !(await renderError(admin)), admin.jsErrors.join(' | '));
  await admin.close();

  for (const [nome, offsetMin, deveCancelar] of [['dentro do prazo', 4, true], ['prazo vencido', -1, false]]) {
    const page = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=approved', { role: 'cliente', seed: true, session: true });
    page.api.db.orders[0].cancelDeadline = new Date(Date.now() + offsetMin * 60000).toISOString();
    await page.waitForTimeout(3500);
    await click(page, 'Acompanhar pedido');
    t = await text(page);
    check(`cliente ${nome}: botão Cancelar ${deveCancelar ? 'aparece' : 'some'}`, t.includes('Cancelar pedido') === deveCancelar);
    check(`cliente ${nome}: aviso "até HH:MM" ${deveCancelar ? 'aparece' : 'some'}`, /Você pode cancelar até \d\d:\d\d/.test(t) === deveCancelar);
    await page.close();
  }
});

await step('cartão pelo Stripe (modo teste)', async () => {
  const SHOTS = process.env.SHOTS_DIR; // opcional: pasta para salvar prints das telas
  for (const [tela, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }],
    ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    // O caminho até o pagamento é feito no tamanho de celular; depois a tela muda de tamanho.
    const page = await open('app-cliente.dc.html', { stripeTest: true });
    await ateOPagamento(page);
    await page.setViewportSize(viewport); await page.waitForTimeout(400);
    await click(page, 'Cartão de crédito ou débito', true);
    let t = await text(page);
    check(`stripe ${tela}: opção diz "À vista, no app"`, t.includes('À vista, no app') && !t.includes('pelo Stripe'));
    check(`stripe ${tela}: sem aviso do cartão de teste para o cliente`, !t.includes('4242') && !t.includes('Modo de teste'));
    check(`stripe ${tela}: sem rolagem lateral`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pagamento-stripe-${tela}.png`, fullPage: true });
    await page.route(FAKE_CHECKOUT_URL, r => r.fulfill({ contentType: 'text/html', body: '<h1>Checkout Stripe (teste)</h1>' }));
    await click(page, 'Pagar R$');
    await page.waitForURL(FAKE_CHECKOUT_URL, { timeout: 5000 }).catch(() => {});
    check(`stripe ${tela}: leva pro checkout (não aprova como provisório)`, page.url() === FAKE_CHECKOUT_URL && page.api.db.orders[0].paymentStatus !== 'approved', page.url());
    check(`stripe ${tela}: sem erro de JavaScript`, page.jsErrors.length === 0, page.jsErrors.join(' | '));
    await page.close();

    const back = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9', { role: 'cliente', seed: true, session: true, stripeTest: true, viewport,
      setup: db => { db.orders[0].paymentStatus = 'pending'; } });
    // No CI a primeira tela às vezes demora mais que 800 ms para montar.
    await back.getByText('Aguardando confirmação do pagamento').first().waitFor({ timeout: 8000 }).catch(() => {});
    t = await text(back);
    check(`stripe ${tela}: na volta, espera a confirmação sem aviso de teste`, t.includes('Aguardando confirmação do pagamento') && t.includes('página segura para digitar') && !t.includes('4242'), t.slice(0, 300));
    if (SHOTS) await back.screenshot({ path: `${SHOTS}/cartao-stripe-${tela}.png`, fullPage: true });
    back.api.db.orders[0].paymentStatus = 'approved';
    await back.waitForTimeout(3500);
    check(`stripe ${tela}: webhook aprovou → pedido confirmado`, (await text(back)).toLowerCase().includes('pedido confirmado'));
    await back.close();
  }
  const fail = await open('app-cliente.dc.html?module=cliente&screen=card&pedido=o9&status=failure', { role: 'cliente', seed: true, session: true, stripeTest: true });
  fail.api.db.orders[0].paymentStatus = 'pending';
  await fail.waitForTimeout(800);
  const t = await text(fail);
  check('stripe: desistiu no Stripe → pagamento não concluído', t.includes('não foi concluído') && t.includes('processados com segurança pelo Stripe'));
  await fail.close();

  const admin = await open('app-cliente.dc.html?module=admin&screen=payments', { role: 'admin', stripeTest: true });
  const ta = await text(admin);
  check('stripe: admin vê PIX e cartão no Stripe em modo de teste', ta.includes('Pagamentos online pelo Stripe em modo de teste') && !ta.includes('Sem meio de pagamento configurado'), ta.slice(0, 400));
  await admin.close();
});

await step('cartão dentro do app (Stripe Payment Element)', async () => {
  const SHOTS = process.env.SHOTS_DIR;
  for (const [tela, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }],
    ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    const page = await open('app-cliente.dc.html', { stripeTest: true, stripeInApp: true });
    await ateOPagamento(page);
    await page.setViewportSize(viewport); await page.waitForTimeout(1600);
    check(`no app ${tela}: Stripe.js já baixado antes de pagar`, await page.evaluate(() => typeof window.Stripe === 'function'));
    check(`no app ${tela}: campos do cartão já preparados no carrinho, sem pedido`, await page.evaluate(() => !!document.querySelector('#sf-stripe-warm .fake-stripe'))
      && page.api.db.orders.length === 0 && !page.api.db.cardIntentCalls);
    await click(page, 'Cartão de crédito ou débito', true);
    // Servidor lento pra criar o pedido: os campos aparecem mesmo assim.
    page.api.db.orderDelayMs = 1500;
    await click(page, 'Pagar R$');
    await page.waitForSelector('#sf-stripe-card .fake-stripe', { timeout: 400 });
    check(`no app ${tela}: campos aparecem antes de o pedido ficar pronto`, page.api.db.orders.length === 0 && !page.api.db.cardIntentCalls);
    page.api.db.orderDelayMs = 0;
    await page.waitForTimeout(1700);
    let t = await text(page);
    check(`no app ${tela}: não sai do app (campos do cartão na tela)`, page.url().startsWith(BASE) && t.includes('Dados do cartão'), page.url());
    check(`no app ${tela}: Stripe com a chave publicável e as cores do SunFood`, await page.evaluate(() => window.__stripePk === 'pk_test_fake'
      && window.__stripeOpts.mode === 'payment' && window.__stripeOpts.currency === 'brl' && window.__stripeOpts.paymentMethodTypes.join() === 'card'
      && !window.__stripeOpts.clientSecret && window.__stripeOpts.appearance.variables.colorPrimary.toUpperCase() === '#1F5A63'
      && window.__stripeOpts.appearance.variables.fontFamily.startsWith('Manrope')));
    check(`no app ${tela}: sem aviso do cartão de teste`, !t.includes('4242') && !t.includes('Modo de teste'));
    check(`no app ${tela}: sem rolagem lateral`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const btnH = await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().evaluate(el => el.getBoundingClientRect().height);
    check(`no app ${tela}: botão Pagar com altura de toque (40 a 56 px)`, btnH >= 40 && btnH <= 56, String(btnH));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/cartao-no-app-${tela}.png`, fullPage: true });
    await page.getByLabel('Nome do titular do cartão').fill('');
    await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().click(); await page.waitForTimeout(300);
    check(`no app ${tela}: pede o nome completo do titular`, (await text(page)).includes('Informe o nome completo do titular'));
    await page.getByLabel('Nome do titular do cartão').fill('Ana Souza');
    await page.getByLabel('CPF do titular do cartão').fill('12345678900');
    await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().click(); await page.waitForTimeout(300);
    t = await text(page);
    check(`no app ${tela}: recusa CPF inválido do titular`, t.includes('CPF do titular inválido') && !page.api.db.cardHolder);
    await page.getByLabel('CPF do titular do cartão').fill('52998224725');
    check(`no app ${tela}: CPF do titular é pontuado`, await page.getByLabel('CPF do titular do cartão').inputValue() === '529.982.247-25');
    await page.evaluate(() => { window.__stripeRecusa = true; window.__stripeSaved = true; window.__stripeHandlers.change({ value: { type: 'card', payment_method: { id: 'pm_salvo' } } }); });
    await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().click(); await page.waitForTimeout(500);
    check(`no app ${tela}: com cartão salvo, confirma sem dados de cartão novo`, await page.evaluate(() => !!window.__stripeConfirm && !window.__stripeConfirm.confirmParams.payment_method_data));
    await page.evaluate(() => { window.__stripeSaved = false; window.__stripeHandlers.change({ value: { type: 'card' } }); });
    check(`no app ${tela}: cartão recusado mostra o erro e deixa tentar de novo`, (await text(page)).includes('Seu cartão foi recusado.'));
    await page.evaluate(() => { window.__stripeRecusa = false; });
    await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().click(); await page.waitForTimeout(500);
    check(`no app ${tela}: depois de pagar, espera a confirmação do servidor`, (await text(page)).includes('Aguardando confirmação do pagamento'));
    check(`no app ${tela}: confirma com o pagamento do pedido criado no servidor`, await page.evaluate(() => window.__stripeConfirm.clientSecret === 'pi_fake_secret_o1'));
    check(`no app ${tela}: valor dos campos acertado com o do servidor`, await page.evaluate(t => window.__stripeOpts.amount === t, Math.round(page.api.db.orders[0].total * 100)));
    check(`no app ${tela}: pagamento do pedido sem pedir outra sessão do cliente`, page.api.db.cardIntentSession === '0' && page.api.db.cardSessionCalls >= 1);
    check(`no app ${tela}: volta do 3D Secure aponta pro pedido`, await page.evaluate(() => /pedido=/.test(window.__stripeConfirm.confirmParams.return_url)));
    check(`no app ${tela}: Stripe recebe a sessão do cliente (cartões salvos)`, await page.evaluate(() => window.__stripeOpts.customerSessionClientSecret === 'cuss_fake_secret'));
    check(`no app ${tela}: titular vai pro servidor e o nome pro Stripe`, page.api.db.cardHolder?.name === 'Ana Souza' && page.api.db.cardHolder?.cpf === '52998224725'
      && await page.evaluate(() => window.__stripeConfirm.confirmParams.payment_method_data.billing_details.name === 'Ana Souza'));
    page.api.db.orders[0].paymentStatus = 'approved';
    await page.waitForTimeout(3500);
    check(`no app ${tela}: webhook aprovou → pedido confirmado`, (await text(page)).toLowerCase().includes('pedido confirmado'));
    check(`no app ${tela}: sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
    await page.close();
  }
});

await step('carrinho só some depois do pagamento aprovado', async () => {
  const page = await open('app-cliente.dc.html', { stripeTest: true, stripeInApp: true });
  await ateOPagamento(page);
  const total = (await text(page)).match(/R\$\s?[\d.,]+/g).pop();
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$'); await page.waitForTimeout(600);
  check('carrinho: PIX aberto, pedido criado e ainda pendente', page.api.db.orders.length === 1 && page.api.db.orders[0].paymentStatus === 'pending');
  await page.locator('[aria-label="Voltar"]').first().click(); await page.waitForTimeout(500);
  let t = await text(page);
  check('carrinho: voltar do PIX mostra o pedido com os itens e o mesmo total', t.includes('Etapa 2 de 2') && t.includes(total) && !t.includes('R$ 0,00'), total);
  await click(page, 'PIX', true);
  await click(page, 'Pagar R$'); await page.waitForTimeout(600);
  check('carrinho: tentar de novo com o mesmo carrinho reaproveita o pedido', page.api.db.orders.length === 1);
  await page.locator('[aria-label="Voltar"]').first().click(); await page.waitForTimeout(500);
  await click(page, 'Cartão de crédito ou débito', true);
  await click(page, 'Pagar R$'); await page.waitForTimeout(600);
  check('carrinho: trocar para cartão cancela o PIX não pago e cria outro pedido',
    page.api.db.orders.length === 2 && page.api.db.orders[1].status === 'Cancelado' && page.api.db.orders[0].paymentMethod === 'cartao');
  await page.locator('[aria-label="Voltar"]').first().click(); await page.waitForTimeout(500);
  check('carrinho: antes de aprovar, o carrinho continua cheio', (await text(page)).includes(total));
  page.api.db.orders[0].paymentStatus = 'approved';
  await click(page, 'Cartão de crédito ou débito', true);
  await click(page, 'Pagar R$');
  await page.waitForTimeout(3500);
  check('carrinho: mesmo pedido de cartão reaproveitado e confirmado quando aprova', page.api.db.orders.length === 2 && (await text(page)).toLowerCase().includes('pedido confirmado'));
  check('carrinho: sem erro de JavaScript', page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | ') || await renderError(page));
  await page.close();
});

await step('PIX pelo Stripe (modo teste)', async () => {
  const SHOTS = process.env.SHOTS_DIR;
  for (const [tela, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }],
    ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    const page = await open('app-cliente.dc.html', { stripeTest: true, stripeInApp: true });
    await ateOPagamento(page);
    await page.setViewportSize(viewport); await page.waitForTimeout(400);
    let t = await text(page);
    check(`pix stripe ${tela}: cartão aparece como crédito ou débito, à vista`, t.includes('Cartão de crédito ou débito') && t.includes('À vista, no app'));
    await click(page, 'PIX', true);
    await click(page, 'Pagar R$');
    await page.waitForTimeout(600);
    const o = page.api.db.orders[0];
    t = await text(page);
    check(`pix stripe ${tela}: pedido NÃO é aprovado antes de pagar`, o && o.paymentMethod === 'pix' && o.paymentStatus !== 'approved' && t.includes('Aguardando confirmação do pagamento'), JSON.stringify(o?.paymentStatus));
    check(`pix stripe ${tela}: mostra o QR do Stripe, sem aviso nem botão de teste`, await page.locator('img[alt="QR Code PIX"]').count() === 1 && !t.includes('Simular pagamento do PIX') && !t.includes('Modo de teste'));
    check(`pix stripe ${tela}: sem rolagem lateral`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pix-stripe-${tela}.png`, fullPage: true });
    o.paymentStatus = 'approved';
    await page.waitForTimeout(3500);
    check(`pix stripe ${tela}: webhook aprovou → pedido confirmado`, (await text(page)).toLowerCase().includes('pedido confirmado'));
    check(`pix stripe ${tela}: sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.close();
  }
});

// Recarregar a página no meio do pagamento (F5, puxar pra baixo no celular):
// o QR do PIX e os campos do cartão voltam, sem criar outro pedido.
await step('recarregar a tela de pagamento', async () => {
  for (const [tela, viewport] of [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }],
    ['computador', { width: 1366, height: 900 }], ['tela-larga', { width: 1920, height: 1080 }]]) {
    // PIX
    let page = await open('app-cliente.dc.html', { stripeTest: true, stripeInApp: true });
    let pixCalls = 0;
    page.on('request', r => { if (/\/payments\/pix\//.test(r.url())) pixCalls++; });
    await ateOPagamento(page);
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    await click(page, 'PIX', true);
    await click(page, 'Pagar R$');
    await page.waitForTimeout(600);
    check(`recarregar ${tela}: PIX mostra o QR antes`, await page.locator('img[alt="QR Code PIX"]').count() === 1);
    await page.reload(); await page.waitForTimeout(2000);
    let t = await text(page);
    check(`recarregar ${tela}: PIX volta com o QR e o código copia-e-cola`, page.url().includes('screen=pix') && await page.locator('img[alt="QR Code PIX"]').count() === 1
      && t.includes('Aguardando confirmação do pagamento') && t.includes('Copiar código PIX')
      && await page.evaluate(() => JSON.parse(localStorage.getItem('sunfood_pix')).qrCode === '000201STRIPEPIX1'), t.slice(0, 400));
    check(`recarregar ${tela}: PIX não cria outro pedido nem outra cobrança`, page.api.db.orders.length === 1 && pixCalls === 1, `${page.api.db.orders.length} pedidos, ${pixCalls} chamadas de PIX`);
    if (tela === 'celular') {
      // QR não guardado no aparelho: pede o mesmo PIX de novo ao servidor.
      await page.evaluate(() => localStorage.removeItem('sunfood_pix'));
      await page.reload(); await page.waitForTimeout(2000);
      check('recarregar: sem o QR guardado, pede de novo e mostra', await page.locator('img[alt="QR Code PIX"]').count() === 1 && pixCalls === 2
        && page.api.db.orders.length === 1, String(pixCalls));
    }
    page.api.db.orders[0].paymentStatus = 'approved';
    await page.waitForTimeout(3500);
    check(`recarregar ${tela}: PIX pago depois de recarregar confirma o pedido`, (await text(page)).toLowerCase().includes('pedido confirmado'));
    check(`recarregar ${tela}: PIX sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.close();

    // Cartão no app
    page = await open('app-cliente.dc.html', { stripeTest: true, stripeInApp: true });
    await ateOPagamento(page);
    await page.setViewportSize(viewport); await page.waitForTimeout(300);
    await click(page, 'Cartão de crédito ou débito', true);
    await click(page, 'Pagar R$');
    await page.waitForTimeout(1500);
    check(`recarregar ${tela}: cartão mostra os campos antes`, await page.locator('#sf-stripe-card .fake-stripe').count() === 1);
    await page.reload(); await page.waitForTimeout(2500);
    t = await text(page);
    check(`recarregar ${tela}: cartão volta com os campos do cartão`, page.url().includes('screen=card') && await page.locator('#sf-stripe-card .fake-stripe').count() === 1
      && t.includes('Dados do cartão'), t.slice(0, 400));
    check(`recarregar ${tela}: cartão não cria outro pedido`, page.api.db.orders.length === 1, String(page.api.db.orders.length));
    check(`recarregar ${tela}: cartão sem rolagem lateral`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.getByLabel('Nome do titular do cartão').fill('Ana Souza');
    await page.getByLabel('CPF do titular do cartão').fill('529.982.247-25');
    await page.locator('.btn', { hasText: /^Pagar R\$/ }).last().click(); await page.waitForTimeout(800);
    check(`recarregar ${tela}: dá para pagar com cartão depois de recarregar`, await page.evaluate(() => !!window.__stripeConfirm && !!window.__stripeConfirm.clientSecret),
      (await text(page)).slice(0, 300));
    check(`recarregar ${tela}: cartão sem erro de JavaScript`, page.jsErrors.length === 0 && !(await renderError(page)), page.jsErrors.join(' | '));
    await page.close();
  }
});

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} checagens passaram.`);
process.exit(failed.length ? 1 : 0);
