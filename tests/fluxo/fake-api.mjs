// API falsa em memória: o navegador acha que está falando com o servidor,
// mas nada sai da máquina e nada é gravado no banco de verdade.
// Página de checkout do Mercado Pago de mentira (o teste responde ela sem rede).
export const FAKE_CHECKOUT_URL = 'https://www.mercadopago.com.br/checkout/teste';

// Endereço das fotos enviadas (o teste serve uma imagem pequena nele).
export const FAKE_PHOTO_BASE = 'https://teste.supabase.co/storage/v1/object/public/produtos/';

export function fakeApi(role = 'cliente', { paymentsConfigured = true } = {}) {
  const now = () => new Date().toISOString();
  const db = {
    products: [
      ['p1','Petiscos','Batata Frita',25,'batata',3],
      ['p2','Bebidas','Água de Coco',12,'coco',null],
      ['p3','Bebidas','Caipirinha',22,'caipirinha',null],
      ['p4','Pratos','Peixe Frito',89,'peixe',null],
      ['p5','Sobremesas','Açaí',18,'acai',0],
    ].map(([id, category, name, price, imageKey, stockQty]) => ({ id, category, name, description: name, longDescription: name,
      price, imageKey, stockQty, soldOut: stockQty === 0, portion: '1', prepTime: '10 min', kcal: 100, rating: 4.5,
      reviewCount: 10, ingredients: '-', tags: [] })),
    tables: [1, 2, 3, 4, 5].map(number => ({ number, active: number !== 2, seats: 4 })),
    kiosk: { paused: false, dayClosed: false, cancelWindowMinutes: 0 },
    orders: [],
    contacts: [],
    paymentsConfigured,
  };
  const user = { id: 'u1', email: role + '@teste', name: 'Teste', role };
  const toApi = o => o;
  const handler = async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname, m = req.method();
    // Envio de foto vem como arquivo (binário), não JSON.
    if (url.pathname === '/products/images' && req.method() === 'POST') {
      const buf = req.postDataBuffer();
      db.uploads = (db.uploads || []).concat([{ type: req.headers()['content-type'], size: buf.length, jpeg: buf[0] === 0xff && buf[1] === 0xd8 }]);
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ url: FAKE_PHOTO_BASE + 'foto' + db.uploads.length + '.jpg' }) });
    }
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    db.log = (db.log || []).concat(m + ' ' + p);
    if (p === '/auth/login') return json(200, { token: 'tok', user });
    if (p === '/auth/me') return json(200, { user });
    if (p === '/products' && m === 'GET') return json(200, db.products);
    if (p === '/tables') return json(200, db.tables);
    if (p === '/kiosk-settings/cancel-window') { db.kiosk.cancelWindowMinutes = body.minutes; return json(200, db.kiosk); }
    if (p === '/kiosk-settings') return json(200, db.kiosk);
    if (p === '/orders/mine') return json(200, db.orders);
    if (p === '/orders' && m === 'GET') return json(200, db.orders);
    if (p === '/orders' && m === 'POST') {
      const items = body.items.map(i => { const pr = db.products.find(x => x.id === i.productId);
        return { productId: pr.id, name: pr.name, qty: i.qty, unitPrice: pr.price, note: i.note }; });
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const o = { id: 'o' + (db.orders.length + 1), tableNumber: body.tableNumber, status: 'Na Fila', subtotal,
        total: Math.round(subtotal * 110) / 100, note: body.note, paymentStatus: 'pending', paymentMethod: body.paymentMethod, createdAt: now(), updatedAt: now(), items };
      db.orders.unshift(o); return json(201, o);
    }
    let r;
    if ((r = p.match(/^\/payments\/card\/([^/]+)$/))) { db.cardReturnUrl = body.returnUrl;
      if (!db.paymentsConfigured) { Object.assign(db.orders.find(o => o.id === r[1]), { paymentStatus: 'approved', paymentProvider: 'provisorio' }); return json(200, { provisional: true, paymentStatus: 'approved' }); }
      return json(200, { checkoutUrl: FAKE_CHECKOUT_URL }); }
    if ((r = p.match(/^\/payments\/pix\/([^/]+)$/))) {
      if (!db.paymentsConfigured) { Object.assign(db.orders.find(o => o.id === r[1]), { paymentStatus: 'approved', paymentProvider: 'provisorio' }); return json(200, { provisional: true, paymentStatus: 'approved' }); }
      return json(200, { qrCode: '000201FAKEPIX', qrCodeBase64: '' }); }
    if (p === '/payments/status') return json(200, { configured: db.paymentsConfigured });
    if ((r = p.match(/^\/orders\/([^/]+)\/payment-received$/))) { const o = db.orders.find(o => o.id === r[1]);
      if (o.paymentMethod !== 'entrega' || o.status === 'Cancelado') return json(409, { error: 'Só pedido na entrega.' });
      Object.assign(o, body.receivedWith ? { paymentStatus: 'approved', receivedWith: body.receivedWith } : { paymentStatus: 'pending', receivedWith: null });
      return json(200, o); }
    if ((r = p.match(/^\/payments\/pix\/([^/]+)\/status$/))) return json(200, { paymentStatus: db.orders.find(o => o.id === r[1]).paymentStatus });
    if ((r = p.match(/^\/orders\/([^/]+)\/cancel$/))) { const o = db.orders.find(o => o.id === r[1]); o.status = 'Cancelado'; return json(200, o); }
    if ((r = p.match(/^\/orders\/([^/]+)\/status$/))) { const o = db.orders.find(o => o.id === r[1]); o.status = body.status; o.updatedAt = now(); return json(200, o); }
    if ((r = p.match(/^\/orders\/([^/]+)$/))) return json(200, db.orders.find(o => o.id === r[1]));
    if ((r = p.match(/^\/products\/([^/]+)$/)) && m === 'PUT') { const pr = db.products.find(x => x.id === r[1]);
      db.lastProductBody = body;
      Object.assign(pr, { name: body.name, price: body.price, category: body.category, description: body.description },
        body.stockQty !== undefined ? { stockQty: body.stockQty } : {}, body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {});
      return json(200, pr); }
    if (p === '/products' && m === 'POST') { db.lastProductBody = body;
      const pr = { id: 'p' + (db.products.length + 1), category: body.category, name: body.name, description: body.description, price: body.price,
        imageKey: null, imageUrl: body.imageUrl || null, stockQty: body.stockQty ?? null, soldOut: false, tags: [] };
      db.products.push(pr); return json(201, pr); }
    if ((r = p.match(/^\/products\/([^/]+)\/sold-out$/))) { const pr = db.products.find(x => x.id === r[1]); pr.soldOut = body.soldOut; return json(200, pr); }
    if (p === '/dashboard') return json(200, { revenueToday: 0, ordersToday: 0, avgTicket: 0, topProducts: [], salesByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0 })) });
    if (p === '/ops-metrics') return json(200, { lateOrders: 0, avgPrepSeconds: null, cancelledToday: 0, avgQueueSeconds: null, soldOutProducts: [], ordersInQueueOrPrep: 1 });
    if (p === '/contact' && m === 'POST') {
      // Mesma validação mínima do servidor: contato precisa ser e-mail ou telefone.
      if (!/@/.test(body.contact) && String(body.contact).replace(/\D/g, '').length < 10) return json(400, { error: 'Dados inválidos.', details: [{ message: 'Informe um e-mail ou telefone com DDD.' }] });
      const c = { id: 'c' + (db.contacts.length + 1), protocol: 'SF-' + (100001 + db.contacts.length), ...body, status: 'novo', createdAt: now() };
      db.contacts.unshift(c); return json(201, { protocol: c.protocol });
    }
    if (p === '/contact' && m === 'GET') return json(200, db.contacts);
    if ((r = p.match(/^\/contact\/([^/]+)\/status$/))) { const c = db.contacts.find(c => c.id === r[1]); c.status = body.status; return json(200, c); }
    if (p === '/reports/sales') {
      // Relatório de mentira: 12h é o pico; período de 1, 7 ou 30 dias.
      const period = url.searchParams.get('period') || 'hoje';
      const days = { hoje: 1, '7d': 7, '30d': 30 }[period];
      if (!days) return json(400, { error: 'Período inválido.' });
      db.lastReportPeriod = period;
      const day = i => new Date(Date.UTC(2026, 9, 5 - (days - 1) + i)).toISOString().slice(0, 10);
      const byDay = Array.from({ length: days }, (_, i) => ({ date: day(i), orders: i === days - 1 ? 3 : 1, revenue: i === days - 1 ? 120 : 40 }));
      const orders = byDay.reduce((a, d) => a + d.orders, 0), revenue = byDay.reduce((a, d) => a + d.revenue, 0);
      return json(200, { period, from: byDay[0].date, to: byDay[days - 1].date, revenue, orders, avgTicket: revenue / orders, itemsSold: orders * 2,
        topProducts: [{ name: 'Batata Frita', qty: 5 * days, revenue: 125 * days }, { name: 'Água de Coco', qty: 2 * days, revenue: 24 * days }],
        byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hour === 12 ? 2 : hour === 18 ? 1 : 0, revenue: hour === 12 ? 80 : hour === 18 ? 40 : 0 })),
        byDay });
    }
    if (p === '/day-reports/latest') return json(404, { error: 'none' });
    return json(404, { error: 'rota falsa não implementada: ' + m + ' ' + p });
  };
  // Faz o papel do webhook do Mercado Pago: o pagamento do pedido foi aprovado.
  handler.approvePayment = id => { db.orders.find(o => o.id === id).paymentStatus = 'approved'; };
  handler.db = db;
  handler.seed = () => db.orders.push({ id: 'o9', tableNumber: 1, status: 'Na Fila', subtotal: 25, total: 27.5, note: 'sem sal',
    paymentStatus: 'approved', createdAt: now(), updatedAt: now(), items: [{ productId: 'p1', name: 'Batata Frita', qty: 1, unitPrice: 25, note: '' }] });
  return handler;
}
