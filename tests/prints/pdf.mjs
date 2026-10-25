import { pathToFileURL } from 'node:url';
const ROOT = process.env.SUNFOOD_DIR || '/home/user/sunfood';
const { chromium } = await import(pathToFileURL(ROOT + '/tests/node_modules/playwright/index.mjs').href);
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const m = JSON.parse(readFileSync('png/manifest.json'));
const SEC = { '01-entrada': 'Entrada: login, cadastro e senha', '02-site': 'Painéis do rodapé (site)', '03-cliente': 'Cliente', '04-admin': 'Administração', '05-cozinha': 'Cozinha', '06-garcom': 'Garçom' };
const screens = []; for (const x of m) { let s = screens.find(s => s.sec === x.sec && s.file === x.file); if (!s) screens.push(s = { sec: x.sec, file: x.file, title: x.title, url: x.url }); s[x.size] = x.name; }
const img = (sec, n) => 'data:image/png;base64,' + readFileSync(`png/${sec}/${n}`).toString('base64');
let html = `<!doctype html><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box}
@page{size:A4 landscape;margin:10mm}body{font-family:Manrope,Arial,sans-serif;color:#14232A;margin:0}
.pg{page-break-after:always;height:186mm;overflow:hidden;display:flex;flex-direction:column}
h1{font-size:30px;margin:0 0 6px}h2{font-size:15px;margin:0}small{color:#5b6b70;font-size:10px}
.row{flex:1;display:flex;gap:8mm;align-items:flex-start;margin-top:4mm;min-height:0}
.row figure{margin:0;display:flex;flex-direction:column;align-items:center;height:100%}
.row img{max-height:168mm;max-width:100%;object-fit:contain;border:1px solid #ddd;border-radius:6px}
.pc{flex:3}.cel{flex:1}figcaption{font-size:9px;color:#5b6b70;margin-bottom:2px}
.cover{justify-content:center;background:#F7F4EE;padding:20mm}.sec{justify-content:center;padding:20mm}.sec h1{color:#1F5A63;font-size:40px}
ol{columns:3;font-size:10px;line-height:1.5}</style>`;
html += `<div class="pg cover"><h1>SunFood · Prints de todas as telas</h1><p>${screens.length} telas e estados, em celular (390 × 844) e computador (1440 × 900). Gerado em ${new Date().toLocaleDateString('pt-BR')} a partir da versão atual do site (main)${process.env.REAL === '1' ? ', com o cardápio e as fotos reais; pedidos, mensagens e números são de exemplo' : ', com dados de exemplo'}.</p><ol>`;
let last = ''; for (const s of screens) { if (s.sec !== last) { html += `<li style="list-style:none;font-weight:700;margin-top:6px">${SEC[s.sec]}</li>`; last = s.sec; } html += `<li style="list-style:none">${s.sec.slice(0,2)}.${s.file.slice(0,2)} ${s.title}</li>`; }
html += `</ol></div>`; last = '';
for (const s of screens) {
  if (s.sec !== last) { html += `<div class="pg sec"><small>Seção ${s.sec.slice(0,2)}</small><h1>${SEC[s.sec]}</h1></div>`; last = s.sec; }
  html += `<div class="pg"><h2>${s.sec.slice(0,2)}.${s.file.slice(0,2)} · ${s.title}</h2><small>${s.url}</small><div class="row">`;
  if (s.computador) html += `<figure class="pc"><figcaption>Computador</figcaption><img src="${img(s.sec, s.computador)}"></figure>`;
  if (s.celular) html += `<figure class="cel"><figcaption>Celular</figcaption><img src="${img(s.sec, s.celular)}"></figure>`;
  html += `</div></div>`;
}
writeFileSync('doc.html', html);
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await b.newPage(); await p.goto(pathToFileURL(resolve('doc.html')).href); await p.waitForLoadState("networkidle"); await p.waitForTimeout(1500);
await p.pdf({ path: 'sunfood-prints-todas-as-telas.pdf', format: 'A4', landscape: true, printBackground: true });
await b.close();
