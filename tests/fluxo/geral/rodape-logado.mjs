// Links do rodapé do app: "Termos", "Privacidade", "Conheça o SunFood" e "Fale
// conosco" abrem numa janela por cima da tela atual, sem sair dela; fechar só
// tira a janela. Os endereços antigos (termos.html...) continuam funcionando.
// Uso: node fluxo/geral/rodape-logado.mjs (de dentro de tests)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../fake-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

const TELAS = [['celular', 390, 844], ['tablet', 820, 1180], ['computador', 1280, 800], ['tela larga', 1920, 1080]];

async function open(path, viewport, role) {
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
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok   ' : 'FALHA'} ${name}${ok || !detail ? '' : ' -> ' + detail}`); };
const text = p => p.locator('body').innerText();
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } }
const semLogin = p => p.locator('#lp').isHidden();
const semRolagemLateral = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const fechar = async p => { await p.locator('.info-close').click(); await p.waitForTimeout(1500); };

for (const [tela, width, height] of TELAS) {
  const vp = { width, height };
  const comRodape = width > 920; // abaixo disso o app usa a barra de baixo e o Perfil

  await step(`${tela}: rodapé do app abre numa janela por cima da tela`, async () => {
    const p = await open('app-cliente.dc.html?module=cliente&screen=menu', vp, 'cliente');
    const antes = p.url();
    for (const [link, trecho] of [['Termos', 'Natureza do serviço'], ['Privacidade', 'Seus direitos como titular']]) {
      if (comRodape) await p.locator('.footer a', { hasText: link }).click();
      else await p.evaluate(h => { const a = document.createElement('a'); a.href = h; document.body.appendChild(a); a.click(); a.remove(); }, link === 'Termos' ? './#termos' : './#privacidade');
      await p.waitForTimeout(1500);
      const f = p.frameLocator('iframe.sf-painel');
      check(`${tela}: ${link} não sai da tela (mesmo endereço, mesma aba)`, p.context().pages().length === 1 && p.url() === antes, p.url());
      check(`${tela}: ${link} mostra o conteúdo na janela, sem a tela de login`, (await f.locator('#info').innerText()).includes(trecho) && await f.locator('#lp').isHidden());
      check(`${tela}: ${link} com o cardápio atrás da janela`, (await text(p)).includes('Batata Frita'));
      check(`${tela}: ${link} sem rolagem lateral`, await semRolagemLateral(p) && await f.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.locator('.info-close').click(); await p.waitForTimeout(800);
      check(`${tela}: fechar ${link} continua no cardápio`, p.url() === antes && await p.locator('iframe.sf-painel').count() === 0 && (await text(p)).includes('Batata Frita'), p.url());
    }
    // Abas dentro da janela e Esc também não saem da tela.
    await p.evaluate(() => { const a = document.createElement('a'); a.href = './#conheca'; document.body.appendChild(a); a.click(); a.remove(); });
    await p.waitForTimeout(1500);
    const f = p.frameLocator('iframe.sf-painel');
    check(`${tela}: Conheça troca Entrar/Criar conta por Voltar ao cardápio na janela`, await f.locator('[data-sec="conheca"] .cta').innerText() === 'Voltar ao cardápio');
    await f.locator('.tab', { hasText: 'Fale conosco' }).click(); await p.waitForTimeout(600);
    check(`${tela}: aba Fale conosco abre dentro da janela`, p.url() === antes && await f.locator('[data-sec="fale-conosco"]').isVisible(), p.url());
    await f.locator('[data-sec="fale-conosco"]').press('Escape'); await p.waitForTimeout(600);
    check(`${tela}: Esc fecha a janela e fica no cardápio`, p.url() === antes && await p.locator('iframe.sf-painel').count() === 0, p.url());
    if (comRodape) {
      await p.locator('.footer .link', { hasText: 'Onde estamos' }).click(); await p.waitForTimeout(800);
      check(`${tela}: Onde estamos abre a localização`, /screen=location/.test(p.url()) && (await text(p)).includes('Abrir no mapa'), p.url());
    }
    check(`${tela}: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  });

  await step(`${tela}: rodapé do cadastro abre por cima sem perder o que foi digitado`, async () => {
    const p = await open('app-cliente.dc.html?module=cliente&screen=signup', vp);
    const antes = p.url();
    const campo = p.locator('input').first();
    await campo.fill('Maria Teste');
    const fale = p.locator('.auth-foot a', { hasText: 'Fale conosco' });
    if (await fale.isVisible()) await fale.click();
    else await p.evaluate(() => { const a = document.createElement('a'); a.href = './#fale-conosco'; document.body.appendChild(a); a.click(); a.remove(); });
    await p.waitForTimeout(1500);
    const f = p.frameLocator('iframe.sf-painel');
    check(`${tela}: cadastro: Fale conosco abre na janela sem sair do cadastro`, p.url() === antes && await f.locator('[data-sec="fale-conosco"]').isVisible() && await f.locator('#lp').isHidden(), p.url());
    await f.locator('.info-bg').click({ position: { x: 5, y: 5 } }).catch(() => f.locator('.info-close').click());
    await p.waitForTimeout(800);
    check(`${tela}: cadastro: fechar mantém o que foi digitado`, p.url() === antes && await p.locator('iframe.sf-painel').count() === 0 && await campo.inputValue() === 'Maria Teste', p.url());
    check(`${tela}: cadastro: sem erro de JavaScript`, p.jsErrors.length === 0, p.jsErrors.join(' | '));
    await p.context().close();
  });

  await step(`${tela}: endereços antigos com a conta aberta`, async () => {
    for (const [pagina, hash] of [['mapa.html', '#conheca'], ['termos.html', '#termos'], ['privacidade.html', '#privacidade']]) {
      const p = await open(pagina, vp, 'cliente');
      check(`${tela}: ${pagina} abre o painel sem o login`, p.url() === BASE + hash && await p.locator('#info').isVisible() && await semLogin(p), p.url());
      if (hash === '#conheca') check(`${tela}: Conheça troca Entrar/Criar conta por Voltar ao cardápio`, await p.locator('[data-sec="conheca"] .cta').innerText() === 'Voltar ao cardápio');
      await fechar(p);
      check(`${tela}: fechar ${pagina} leva ao cardápio`, /module=cliente&screen=menu/.test(p.url()), p.url());
      await p.context().close();
    }
    const adm = await open('termos.html', vp, 'admin');
    await adm.keyboard.press('Escape'); await adm.waitForTimeout(1500);
    check(`${tela}: Esc nos termos leva o admin ao painel dele`, /module=admin&screen=dashboard/.test(adm.url()), adm.url());
    await adm.context().close();
  });

  await step(`${tela}: sem conta aberta continua igual`, async () => {
    const p = await open('termos.html', vp);
    check(`${tela}: sem conta, termos.html abre o painel por cima do login`, p.url() === BASE + '#termos' && await p.locator('#lp').isVisible());
    await fechar(p);
    check(`${tela}: sem conta, fechar volta ao login`, p.url() === BASE && await p.locator('#info').isHidden() && await p.locator('#lp').isVisible(), p.url());
    await p.context().close();
  });
}

await browser.close(); server.close();
const falhas = results.filter(r => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} ok`);
process.exit(falhas.length ? 1 : 0);
