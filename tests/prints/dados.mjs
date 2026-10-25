// Dados de exemplo para as prints (cardápio, pedidos, mensagens, painel).
const ago = min => new Date(Date.now() - min * 60000).toISOString();

export const PRODUCTS = [
  ['p1', 'Petiscos', 'Batata Frita', 25, 'Crocante, com cheddar e bacon', 12, ['Feito na hora', 'Serve 2']],
  ['p2', 'Bebidas', 'Água de Coco', 12, 'Gelada, direto do coco', null, ['Natural', 'Vegano', 'Gelado']],
  ['p3', 'Drinks', 'Caipirinha', 22, 'Cachaça, limão e gelo', null, ['Alcoólico', '+18', 'Feito na hora']],
  ['p4', 'Pratos', 'Peixe Frito', 89, 'Peixe inteiro com arroz, salada e fritas', 4, ['Frutos do mar', 'Serve 2']],
  ['p5', 'Sobremesas', 'Açaí na Tigela', 18, 'Com banana, granola e leite em pó', 0, ['Vegetariano']],
  ['p6', 'Porções', 'Isca de Peixe', 48, 'Empanada, com molho tártaro', null, ['Frutos do mar', 'Serve 2']],
  ['p7', 'Porções', 'Queijo Coalho na Brasa', 32, '4 espetos com melaço', null, ['Vegetariano', 'Sem glúten']],
  ['p8', 'Bebidas', 'Cerveja Long Neck', 14, 'Puro malte, 355 ml', null, ['Alcoólico', '+18', 'Gelado']],
  ['p9', 'Drinks', 'Piña Colada', 32, 'Rum, abacaxi e coco', null, ['Alcoólico', '+18']],
  ['p10', 'Lanches', 'Pastel de Camarão', 16, 'Massa crocante, recheio cremoso', null, ['Frutos do mar']],
  ['p11', 'Lanches', 'Hambúrguer Artesanal', 34, 'Blend 160 g, queijo e salada', null, ['Feito na hora']],
  ['p12', 'Bebidas', 'Suco de Laranja', 12, 'Espremido na hora', null, ['Natural', 'Vegano']],
].map(([id, category, name, price, description, stockQty, tags]) => ({
  id, category, name, description, longDescription: description + '. Preparado na hora pelo quiosque.',
  price, imageKey: null, imageUrl: null, stockQty, soldOut: stockQty === 0, portion: tags.includes('Serve 2') ? 'Serve 2 pessoas' : '1 porção',
  prepTime: '15 min', kcal: 420, rating: 4.7, reviewCount: 38, ingredients: description, tags,
}));

export const CATEGORIES = [['Petiscos', 'sol'], ['Pratos', 'coral'], ['Porções', 'areia'], ['Lanches', 'sol'], ['Bebidas', 'mar'], ['Drinks', 'coral'], ['Sobremesas', 'uva']]
  .map(([name, color], i) => ({ name, color, position: i + 1 }));

let PR = PRODUCTS;
const it = (id, qty, note = '') => { const p = PR.find(x => x.id === id); return { productId: id, name: p.name, qty, unitPrice: p.price, note }; };
const order = (n, table, status, items, min, extra = {}) => {
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return { id: 'o' + n, number: n, tableNumber: table, customerName: extra.customerName || 'Cliente', status, subtotal,
    total: Math.round(subtotal * 110) / 100, note: extra.note || '', paymentStatus: extra.paymentStatus || 'approved',
    paymentMethod: extra.paymentMethod || 'pix', paymentProvider: 'stripe', createdAt: ago(min), updatedAt: ago(Math.max(0, min - 3)), items, ...extra };
};

export function orders(products = PRODUCTS) {
  PR = products;
  return [
    order(14, 3, 'Na Fila', [it('p1', 1, 'sem bacon'), it('p8', 2)], 2, { customerName: 'Ana Souza', mine: true }),
    order(13, 6, 'Na Fila', [it('p6', 1), it('p3', 2)], 4, { customerName: 'Bruno Lima', paymentMethod: 'entrega', paymentStatus: 'pending' }),
    order(12, 1, 'Em Preparo', [it('p4', 1), it('p2', 2)], 9, { customerName: 'Carla Dias', paymentMethod: 'card' }),
    order(11, 8, 'Em Preparo', [it('p11', 2), it('p12', 2)], 14, { customerName: 'Diego Alves', note: 'um hambúrguer sem cebola' }),
    order(10, 4, 'Pronto', [it('p7', 1), it('p9', 1)], 18, { customerName: 'Eduarda Reis' }),
    order(9, 5, 'Pronto', [it('p10', 3)], 21, { customerName: 'Felipe Costa', paymentMethod: 'entrega', paymentStatus: 'pending' }),
    order(8, 2, 'Entregue', [it('p1', 2), it('p8', 4)], 45, { customerName: 'Ana Souza', mine: true }),
    order(7, 9, 'Entregue', [it('p5', 2)], 60, { customerName: 'Gabriel Nunes', paymentMethod: 'card' }),
    order(6, 3, 'Cancelado', [it('p3', 1)], 75, { customerName: 'Helena Prado', paymentStatus: 'refunded', refundedAmount: 24.2 }),
    order(5, 7, 'Entregue', [it('p4', 1), it('p6', 1), it('p3', 3)], 95, { customerName: 'Ana Souza', mine: true }),
  ];
}

export const CONTACTS = [
  { id: 'c1', protocol: 'SF-100003', name: 'Marina Torres', contact: 'marina@email.com', reason: 'Reservar mesa ou guarda-sol', message: 'Queria reservar uma mesa para 8 pessoas no sábado, perto da água.', status: 'novo', createdAt: ago(30) },
  { id: 'c2', protocol: 'SF-100002', name: 'Paulo Henrique', contact: '(13) 98888-7777', reason: 'Tirar dúvida sobre o cardápio', message: 'Vocês têm opção sem glúten nas porções?', status: 'novo', createdAt: ago(120) },
  { id: 'c3', protocol: 'SF-100001', name: 'Júlia Campos', contact: 'julia@email.com', reason: 'Parceria com meu quiosque', message: 'Tenho um quiosque em Guarujá e quero usar o SunFood.', status: 'respondido', reply: 'Oi, Júlia! Vamos te chamar amanhã para conversar.', replyChannel: 'email', repliedAt: ago(60), createdAt: ago(300) },
];

export const WAITERS = [
  { id: 'w1', name: 'Carlos Souza', email: 'carlos@sunfood.com', active: true, deliveredToday: 12, launchedToday: 5 },
  { id: 'w2', name: 'Fernanda Melo', email: 'fernanda@sunfood.com', active: true, deliveredToday: 9, launchedToday: 3 },
  { id: 'w3', name: 'Rafael Gomes', email: 'rafael@sunfood.com', active: false, deliveredToday: 0, launchedToday: 0 },
];

const rev = { 10: 120, 11: 340, 12: 780, 13: 920, 14: 610, 15: 420, 16: 380, 17: 290, 18: 150 };
export const DASHBOARD = { revenueToday: 4010, ordersToday: 63, avgTicket: 63.65,
  topProducts: [{ name: 'Batata Rústica c/ Cheddar', qty: 28, revenue: 672 }, { name: 'Caipirinha de Limão', qty: 24, revenue: 528 }, { name: 'Peixe Frito com Pirão', qty: 9, revenue: 648 }],
  salesByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: rev[hour] || 0 })) };
export const OPS = { lateOrders: 1, avgPrepSeconds: 540, cancelledToday: 1, avgQueueSeconds: 210, soldOutProducts: ['Açaí na Tigela'], ordersInQueueOrPrep: 4 };
export const STRIPE = { source: 'painel', configured: true, mode: 'live', secretKeyHint: 'sk_live_…9f2c', publishableKey: 'pk_live_51QxSunfoodExemplo',
  webhook: { configured: true, url: 'https://api.sunfood.app.br/payments/stripe/webhook' }, account: { id: 'acct_1SunFood', name: 'Quiosque SunFood' },
  connection: { ok: true }, updatedAt: ago(1440), updatedBy: 'Dárlley' };

// Itens do cardápio real que fazem o papel de p1..p12 nas telas de exemplo.
export const REAL_MAP = { p1: 'Batata Rústica c/ Cheddar', p2: 'Água de Coco Gelada', p3: 'Caipirinha de Limão', p4: 'Peixe Frito com Pirão',
  p5: 'Açaí na Tigela', p6: 'Isca de Peixe', p7: 'Queijo Coalho na Brasa', p8: 'Cerveja Pilsen Long Neck', p9: 'Piña Colada',
  p10: 'Pastel de Camarão', p11: 'Hambúrguer Artesanal', p12: 'Suco de Laranja' };
