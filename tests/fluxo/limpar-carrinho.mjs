// "Limpar carrinho": tira todos os itens de uma vez, só depois de confirmar
// (Cancelar mantém os itens), e o "Total a pagar" do Resumo fica numa linha
// (celular, tablet, computador e tela larga).
// Uso: node fluxo/limpar-carrinho.mjs (de dentro de tests)
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
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };

const SHOTS = process.env.SHOTS_DIR;
const TELAS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['computador', { width: 1366, height: 900 }], ['tela larga', { width: 1920, height: 1080 }]];
for (const [nome, vp] of TELAS) {
  try {
    const mobile = vp.width < 700;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    if (CDN) await ctx.route('https://unpkg.com/**', r => { const mod = new URL(r.request().url()).pathname.replace(/^\/(@?[^@]+)@[^/]+/, '$1'); r.fulfill({ path: join(CDN, 'node_modules', mod), contentType: 'application/javascript' }); });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/accounts\.google|supabase/, r => r.abort());
    const api = fakeApi('cliente');
    await ctx.route('http://localhost:8787/**', api);
    await ctx.addInitScript(() => {
      localStorage.setItem('sunfood_session', JSON.stringify({ token: 'tok', user: { id: 'u1', email: 'cliente@teste', name: 'Teste', role: 'cliente' } }));
      // Carrinho guardado no aparelho, com o valor alto que quebrava a linha do total.
      if (!sessionStorage.getItem('semeado')) {
        sessionStorage.setItem('semeado', '1');
        localStorage.setItem('sunfood_cart', JSON.stringify({ user: 'u1', at: Date.now(), table: null, orderNote: '', cart: [
          { id: 'p1', name: 'Batata Frita', price: 25, qty: 2, note: '' },
          { id: 'p3', name: 'Caipirinha', price: 22, qty: 13, note: '' },
        ] }));
      }
    });
    const p = await ctx.newPage();
    const erros = [];
    p.on('pageerror', e => erros.push(e.message));
    await p.goto(BASE + 'app-cliente.dc.html?module=cliente&screen=cart');
    await p.waitForTimeout(1500);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, `carrinho-${nome.replace(' ', '-')}.png`), fullPage: true });
    // Total a pagar: rótulo e valor sem quebrar dentro de si.
    const alturas = await p.locator('.sum-pay > span').evaluateAll(els => els.map(e => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).fontSize)));
    check(`${nome}: "Total a pagar" e valor sem quebra de linha`, alturas.every(n => n < 2), JSON.stringify(alturas));
    if (vp.width >= 1024) {
      const tops = await p.locator('.sum-pay > span').evaluateAll(els => els.map(e => e.getBoundingClientRect().bottom));
      check(`${nome}: rótulo e valor na mesma linha`, Math.abs(tops[0] - tops[1]) < 8, JSON.stringify(tops));
    }
    const botao = p.locator('.cart-clear');
    const bb = await botao.boundingBox();
    check(`${nome}: botão Limpar carrinho visível`, !!bb && bb.width > 0, JSON.stringify(bb));
    await botao.click();
    await p.waitForTimeout(300);
    check(`${nome}: pede confirmação`, await p.getByText('Limpar o carrinho?').isVisible());
    if (SHOTS) await p.screenshot({ path: join(SHOTS, `confirmar-${nome.replace(' ', '-')}.png`) });
    await p.getByText('Manter os itens', { exact: true }).click();
    await p.waitForTimeout(300);
    let t = await p.locator('body').innerText();
    check(`${nome}: Manter os itens não apaga nada`, t.includes('Batata Frita') && !t.includes('Limpar o carrinho?'), t.slice(0, 200));
    await botao.click();
    await p.waitForTimeout(300);
    await p.getByText('Sim, limpar', { exact: true }).click();
    await p.waitForTimeout(800);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, `vazio-${nome.replace(' ', '-')}.png`) });
    t = await p.locator('body').innerText();
    check(`${nome}: carrinho fica vazio`, /screen=cartEmpty/.test(p.url()) && t.includes('Seu carrinho está vazio') && !t.includes('Batata Frita'), t.slice(0, 300));
    check(`${nome}: sem erro de JavaScript`, erros.length === 0, erros.join(' | '));
    await ctx.close();
  } catch (e) { check(`${nome}: rodou até o fim`, false, e.message.split('\n')[0]); }
}

await browser.close();
server.close();
const falhas = results.filter(r => !r).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
