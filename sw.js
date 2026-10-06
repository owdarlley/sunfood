// Service worker do Sunfood: deixa o site instalável como app e guarda uma
// cópia das páginas e arquivos estáticos para abrir mesmo sem internet.
//
// Regras:
// - Só mexe em GET. Pedidos, login, pagamentos (API na Vercel, Supabase,
//   Mercado Pago) passam direto pela rede, nunca pelo cache.
// - Páginas e scripts do site: rede primeiro (atualização aparece na hora);
//   o cache só é usado quando a rede falha.
// - Imagens do site e fontes do Google: cache primeiro, atualizando por trás.
// - Bibliotecas do unpkg com versão fixa (React, Babel): cache primeiro,
//   porque o arquivo daquela versão nunca muda.
//
// Ao mudar a lista abaixo ou a lógica deste arquivo, aumente a VERSAO para
// o navegador trocar o cache antigo.
const VERSAO = 'v3';
const CACHE = 'sunfood-' + VERSAO;

const PRECACHE = [
  './',
  './index.html',
  './inicio.html',
  './app-cliente.dc.html',
  './redefinir-senha.html',
  './support.js',
  './pwa.js',
  './offline.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.svg'
];

const LIBS = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    // Bibliotecas externas: se o CDN falhar agora, baixam na próxima visita.
    await Promise.all(LIBS.map(url => cache.add(new Request(url, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n.startsWith('sunfood-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') return event.respondWith(paginaRedePrimeiro(req));
    if (req.destination === 'image') return event.respondWith(cachePrimeiroAtualizando(req));
    return event.respondWith(redePrimeiro(req));
  }
  if (url.origin === 'https://unpkg.com' && /@\d+\.\d+\.\d+\//.test(url.pathname)) {
    return event.respondWith(cachePrimeiro(req));
  }
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    return event.respondWith(cachePrimeiroAtualizando(req));
  }
  // Todo o resto (API, Supabase, Mercado Pago...) segue sem passar pelo service worker.
});

async function guardar(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const cache = await caches.open(CACHE);
    await cache.put(req, res.clone());
  }
  return res;
}

async function redePrimeiro(req) {
  try {
    return await guardar(req, await fetch(req));
  } catch (e) {
    const salvo = await caches.match(req, { ignoreSearch: true });
    if (salvo) return salvo;
    throw e;
  }
}

async function paginaRedePrimeiro(req) {
  try {
    const res = await fetch(req);
    // Guarda sem os parâmetros (?module=..., ?login=1) para abrir offline com qualquer um deles.
    if (res.ok) {
      const url = new URL(req.url);
      const cache = await caches.open(CACHE);
      await cache.put(url.origin + url.pathname, res.clone());
    }
    return res;
  } catch (e) {
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./offline.html'));
  }
}

async function cachePrimeiro(req) {
  return (await caches.match(req)) || guardar(req, await fetch(req));
}

async function cachePrimeiroAtualizando(req) {
  const salvo = await caches.match(req);
  const daRede = fetch(req).then(res => guardar(req, res)).catch(() => null);
  return salvo || (await daRede) || Response.error();
}
