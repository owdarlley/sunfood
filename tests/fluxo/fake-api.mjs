// API falsa em memória: o navegador acha que está falando com o servidor,
// mas nada sai da máquina e nada é gravado no banco de verdade.
// Página de checkout do Mercado Pago de mentira (o teste responde ela sem rede).
export const FAKE_CHECKOUT_URL = 'https://www.mercadopago.com.br/checkout/teste';

// Endereço das fotos enviadas (o teste serve uma imagem pequena nele).
export const FAKE_PHOTO_BASE = 'https://teste.supabase.co/storage/v1/object/public/produtos/';

export function fakeApi(role = 'cliente', { paymentsConfigured = true, stripeTest = false, stripeInApp = false, stripePix = false } = {}) {
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
    categories: [['Petiscos','sol'],['Bebidas','mar'],['Pratos','coral'],['Sobremesas','uva']].map(([name, color], i) => ({ name, color, position: i + 1 })),
    tables: [1, 2, 3, 4, 5].map(number => ({ number, active: number !== 2, seats: 4 })),
    kiosk: { paused: false, dayClosed: false, cancelWindowMinutes: 0 },
    orders: [],
    contacts: [],
    paymentsConfigured, stripeTest, stripeInApp, stripePix,
  };
  const user = { id: 'u1', email: role + '@teste', name: 'Teste', role, avatarUrl: null, avatarPreset: null, notifyReady: true, soundOn: true };
  // Tela Perfil (GET/PATCH /auth/profile, foto e trocar senha). A senha atual certa é "senha-atual".
  db.profile = { phone: '11999999999', birthDate: '2000-01-01', cpf: '529.***.***-25', hasPassword: true };
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
    const isJson = /json/.test(req.headers()['content-type'] || '');
    const body = isJson && req.postData() ? JSON.parse(req.postData()) : {};
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    db.log = (db.log || []).concat(m + ' ' + p);
    if (p === '/auth/login') return json(200, { token: 'tok', user });
    if (p === '/auth/me') return json(200, { user });
    if (p === '/auth/profile' && m === 'GET') return json(200, { user, ...db.profile });
    if (p === '/auth/profile' && m === 'PATCH') {
      const { phone, birthDate, ...rest } = body;
      if (phone !== undefined) db.profile.phone = phone;
      if (birthDate !== undefined) db.profile.birthDate = birthDate;
      Object.assign(user, rest);
      if (body.avatarPreset) user.avatarUrl = null;
      return json(200, { user });
    }
    if (p === '/auth/avatar' && m === 'POST') {
      db.avatarUpload = { type: req.headers()['content-type'], body: req.postDataBuffer() };
      Object.assign(user, { avatarUrl: 'https://teste.supabase.co/storage/v1/object/public/avatares/foto.jpg', avatarPreset: null });
      return json(201, { user });
    }
    if (p === '/auth/avatar' && m === 'DELETE') { Object.assign(user, { avatarUrl: null, avatarPreset: null }); return json(200, { user }); }
    if (p === '/auth/change-password') {
      if (!db.profile.hasPassword) return json(400, { error: 'Sua conta entra pelo Google e não tem senha no Sunfood.', code: 'google_account' });
      if (body.currentPassword !== 'senha-atual') return json(400, { error: 'Senha atual incorreta.', code: 'wrong_password' });
      db.newPassword = body.newPassword; return json(200, { message: 'Senha alterada.' });
    }
    if (p === '/auth/forgot-password') { db.resetFor = body.email; return json(200, { message: 'ok' }); }
    if (p === '/products' && m === 'GET') return json(200, db.products);
    if (p === '/tables') return json(200, db.tables);
    // Categorias: mesmas regras do servidor (nome único sem diferenciar
    // maiúsculas, renomear leva os itens, excluir só sem item).
    if (p.startsWith('/categories')) {
      const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
      if (p === '/categories' && m === 'GET') return json(200, [...db.categories].sort((a, b) => a.position - b.position));
      if (p === '/categories' && m === 'POST') {
        const name = String(body.name || '').trim();
        if (name.length < 2) return json(400, { error: 'Dados inválidos.', details: [{ message: 'Nome da categoria muito curto.' }] });
        if (db.categories.some(c => sameName(c.name, name))) return json(409, { error: 'Já existe uma categoria com esse nome.' });
        const c = { name, color: body.color || 'areia', position: Math.max(0, ...db.categories.map(c => c.position)) + 1 };
        db.categories.push(c); return json(201, c);
      }
      if (p === '/categories/reorder') {
        if (body.names.length !== db.categories.length) return json(409, { error: 'As categorias mudaram. Recarregue a tela.' });
        db.categories.forEach(c => { c.position = body.names.indexOf(c.name) + 1; }); return json(200, { ok: true });
      }
      const c = db.categories.find(c => c.name === decodeURIComponent(p.slice('/categories/'.length)));
      if (!c) return json(404, { error: 'Categoria não encontrada.' });
      if (m === 'PUT') {
        const name = String(body.name || '').trim();
        if (db.categories.some(o => o !== c && sameName(o.name, name))) return json(409, { error: 'Já existe uma categoria com esse nome.' });
        db.products.filter(pr => pr.category === c.name).forEach(pr => { pr.category = name; });
        Object.assign(c, { name }, body.color ? { color: body.color } : {}); return json(200, c);
      }
      if (m === 'DELETE') {
        if (db.products.some(pr => pr.category === c.name)) return json(409, { error: 'Essa categoria ainda tem itens. Mova ou exclua os itens antes.' });
        db.categories = db.categories.filter(o => o !== c); return json(200, { ok: true });
      }
    }
    if (p === '/kiosk-settings/cancel-window') { db.kiosk.cancelWindowMinutes = body.minutes; return json(200, db.kiosk); }
    if (p === '/kiosk-settings') return json(200, db.kiosk);
    if (p === '/orders/mine') return json(200, db.orders);
    if (p === '/orders' && m === 'GET') return json(200, db.orders);
    if (p === '/orders' && m === 'POST') {
      const items = body.items.map(i => { const pr = db.products.find(x => x.id === i.productId);
        return { productId: pr.id, name: pr.name, qty: i.qty, unitPrice: pr.price, note: i.note }; });
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const o = { id: 'o' + (db.orders.length + 1), tableNumber: body.tableNumber, status: 'Na Fila', subtotal,
        total: subtotal, note: body.note, paymentStatus: 'pending', paymentMethod: body.paymentMethod, createdAt: now(), updatedAt: now(), items };
      db.orders.unshift(o); return json(201, o);
    }
    // Garçom: pedido lançado na mesa (pago na entrega, no nome do garçom) e métricas.
    if (p === '/orders/manual' && m === 'POST') {
      if (db.kiosk.paused) return json(409, { error: 'Quiosque pausado no momento — não é possível fechar o pedido.' });
      const items = body.items.map(i => { const pr = db.products.find(x => x.id === i.productId);
        return { productId: pr.id, name: pr.name, qty: i.qty, unitPrice: pr.price, note: '' }; });
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const o = { id: 'o' + (db.orders.length + 1), tableNumber: body.tableNumber, status: 'Na Fila', subtotal, waiterId: user.id,
        total: Math.round(subtotal * 110) / 100, note: body.note, paymentStatus: 'pending', paymentMethod: 'entrega', createdAt: now(), updatedAt: now(), items };
      db.manual = body;
      db.orders.unshift(o); return json(201, o);
    }
    if (p === '/waiter/metrics') {
      const period = url.searchParams.get('period') || 'hoje';
      const days = { hoje: 1, '7d': 7, '30d': 30 }[period];
      if (!days) return json(400, { error: 'Período inválido.' });
      db.lastWaiterPeriod = period;
      const byDay = Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 9 - (days - 1) + i)).toISOString().slice(0, 10), delivered: i + 1, launched: 1 }));
      return json(200, { period, from: byDay[0].date, to: byDay[days - 1].date, delivered: byDay.reduce((a, d) => a + d.delivered, 0),
        avgDeliverMin: 3.5, launched: days, launchedTotal: 33 * days, received: 27.5, byDay });
    }
    db.waiters = db.waiters || [{ id: 'w1', name: 'Carlos Souza', email: 'carlos@sunfood.com', active: true, deliveredToday: 4, launchedToday: 2 }];
    if (p === '/waiters' && m === 'GET') return json(200, db.waiters);
    if (p === '/waiters' && m === 'POST') {
      if (db.waiters.some(w => w.email === body.email.toLowerCase())) return json(409, { error: 'Já existe uma conta com esse e-mail.' });
      const w = { id: 'w' + (db.waiters.length + 1), name: body.name, email: body.email.toLowerCase(), active: true, deliveredToday: 0, launchedToday: 0 };
      db.waiters.push(w); db.waiterPassword = body.password; return json(201, w);
    }
    let r;
    if ((r = p.match(/^\/payments\/card\/([^/]+)$/))) { db.cardReturnUrl = body.returnUrl;
      if (!db.paymentsConfigured && !db.stripeTest) { Object.assign(db.orders.find(o => o.id === r[1]), { paymentStatus: 'approved', paymentProvider: 'provisorio' }); return json(200, { provisional: true, paymentStatus: 'approved' }); }
      return json(200, { checkoutUrl: FAKE_CHECKOUT_URL }); }
    if ((r = p.match(/^\/payments\/pix\/([^/]+)$/))) {
      if (db.stripePix) return json(200, { qrCode: '000201STRIPEPIX', qrCodeImageUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', testPayUrl: 'https://payments.stripe.com/pix/teste' });
      if (!db.paymentsConfigured) { Object.assign(db.orders.find(o => o.id === r[1]), { paymentStatus: 'approved', paymentProvider: 'provisorio' }); return json(200, { provisional: true, paymentStatus: 'approved' }); }
      return json(200, { qrCode: '000201FAKEPIX', qrCodeBase64: '' }); }
    if (p === '/payments/status') return json(200, { configured: db.paymentsConfigured,
      pix: db.paymentsConfigured ? 'mercadopago' : db.stripePix ? 'stripe' : 'provisorio',
      card: db.stripeTest ? 'stripe' : db.paymentsConfigured ? 'mercadopago' : 'provisorio', cardTestMode: db.stripeTest,
      stripePublishableKey: db.stripeTest && db.stripeInApp ? 'pk_test_fake' : null });
    if ((r = p.match(/^\/payments\/card-holder\/([^/]+)$/))) {
      db.cardHolder = body;
      return json(200, { ok: true }); }
    if ((r = p.match(/^\/payments\/card-intent\/([^/]+)$/))) {
      db.cardIntentCalls = (db.cardIntentCalls || 0) + 1;
      return json(200, { clientSecret: 'pi_fake_secret_' + r[1], publishableKey: 'pk_test_fake', customerSessionClientSecret: 'cuss_fake_secret' }); }
    if ((r = p.match(/^\/waiters\/([^/]+)\/report$/)) && m === 'GET') {
      const w = db.waiters.find(w => w.id === r[1]);
      if (!w) return json(404, { error: 'Garçom não encontrado.' });
      const period = url.searchParams.get('period') || 'hoje';
      const days = { hoje: 1, '7d': 7, '30d': 30 }[period];
      if (!days) return json(400, { error: 'Período inválido.' });
      db.lastWaiterReport = { id: w.id, period };
      const items = [{ name: 'Caipirinha', qty: 2 }, { name: 'Água de Coco', qty: 1 }];
      const orders = period === '30d' ? [] : [
        { id: 'ow1', number: 7, tableNumber: 4, status: 'Entregue', total: 56, launched: true, delivered: true, createdAt: now(), items },
        { id: 'ow2', number: 9, tableNumber: 2, status: 'Entregue', total: 34, launched: false, delivered: true, createdAt: now(), items: items.slice(1) },
        { id: 'ow3', number: 12, tableNumber: 6, status: 'Cancelado', total: 22, launched: true, delivered: false, createdAt: now(), items: items.slice(0, 1) },
      ];
      return json(200, { waiter: { id: w.id, name: w.name, email: w.email, active: w.active },
        metrics: { period, delivered: 2, avgDeliverMin: 4.5, launched: 1, launchedTotal: 56, received: 56,
          served: orders.length ? 2 : 0, servedTotal: orders.length ? 90 : 0, avgTicket: orders.length ? 45 : 0, byDay: [] }, orders });
    }
    if ((r = p.match(/^\/waiters\/([^/]+)$/)) && m === 'DELETE') {
      if (!db.waiters.some(w => w.id === r[1])) return json(404, { error: 'Garçom não encontrado.' });
      db.waiters = db.waiters.filter(w => w.id !== r[1]); db.deletedWaiter = r[1]; return json(200, { id: r[1] });
    }
    if ((r = p.match(/^\/waiters\/([^/]+)$/)) && m === 'PATCH') { const w = db.waiters.find(w => w.id === r[1]); w.active = body.active; return json(200, { id: w.id, active: w.active }); }
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
        body.stockQty !== undefined ? { stockQty: body.stockQty } : {}, body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {},
        body.ingredients !== undefined ? { ingredients: body.ingredients } : {}, body.tags !== undefined ? { tags: body.tags } : {});
      return json(200, pr); }
    if (p === '/products' && m === 'POST') { db.lastProductBody = body;
      const pr = { id: 'p' + (db.products.length + 1), category: body.category, name: body.name, description: body.description, price: body.price,
        imageKey: null, imageUrl: body.imageUrl || null, stockQty: body.stockQty ?? null, soldOut: false, ingredients: body.ingredients || '', tags: body.tags || [] };
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
    if ((r = p.match(/^\/contact\/([^/]+)\/reply$/)) && m === 'POST') {
      const c = db.contacts.find(c => c.id === r[1]);
      const byEmail = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(c.contact).trim());
      if (byEmail && db.emailOff) return json(503, { error: 'O envio de e-mail ainda não foi configurado no servidor. A resposta não foi enviada.', code: 'email_not_configured' });
      Object.assign(c, { reply: body.reply, replyChannel: byEmail ? 'email' : 'whatsapp', repliedAt: now(), status: 'respondido' });
      return json(200, c);
    }
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
  handler.user = user;
  handler.seed = () => db.orders.push({ id: 'o9', tableNumber: 1, customerName: 'Ana Teste', status: 'Na Fila', subtotal: 25, total: 27.5, note: 'sem sal',
    paymentStatus: 'approved', createdAt: now(), updatedAt: now(), items: [{ productId: 'p1', name: 'Batata Frita', qty: 1, unitPrice: 25, note: '' }] });
  return handler;
}
