import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_ORDER_CENTS,
  SERVICE_FEE_RATE,
  isValidTransition,
  computeOrderTotals,
  meetsMinimumOrder,
  minOrderCentsFrom,
  formatBRL,
  canCancel,
} from "../src/business-rules.js";

test("RN01: pedido abaixo de R$10 é rejeitado", () => {
  assert.equal(meetsMinimumOrder(999), false);
  assert.equal(meetsMinimumOrder(MIN_ORDER_CENTS), true);
  assert.equal(meetsMinimumOrder(MIN_ORDER_CENTS + 1), true);
});

test("RN01: mínimo configurável pelo admin", () => {
  assert.equal(meetsMinimumOrder(1499, 1500), false);
  assert.equal(meetsMinimumOrder(1500, 1500), true);
  assert.equal(meetsMinimumOrder(1, 0), true); // 0 = sem mínimo
});

test("minOrderCentsFrom usa o valor do banco e cai no padrão se faltar", () => {
  assert.equal(minOrderCentsFrom({ min_order_cents: 2500 }), 2500);
  assert.equal(minOrderCentsFrom({ min_order_cents: 0 }), 0);
  assert.equal(minOrderCentsFrom({ paused: false }), MIN_ORDER_CENTS);
  assert.equal(minOrderCentsFrom(null), MIN_ORDER_CENTS);
  assert.equal(formatBRL(1550), "R$ 15,50");
});

test("computeOrderTotals soma em centavos sem erro de ponto flutuante", () => {
  const items = [
    { productId: "a", qty: 3 }, // 3x R$ 0,10
    { productId: "b", qty: 1 }, // 1x R$ 0,20
  ];
  const priceCentsOf = (item) => (item.productId === "a" ? 10 : 20);
  const { subtotalCents, feeCents, totalCents } = computeOrderTotals(items, priceCentsOf);
  assert.equal(subtotalCents, 50); // 3*10 + 1*20 — não pode virar 49 ou 51 por float
  assert.equal(feeCents, Math.round(50 * SERVICE_FEE_RATE));
  assert.equal(totalCents, subtotalCents + feeCents);
});

test("RN04: só cancela enquanto 'Na Fila'", () => {
  assert.equal(canCancel("Na Fila"), true);
  assert.equal(canCancel("Em Preparo"), false);
  assert.equal(canCancel("Pronto"), false);
  assert.equal(canCancel("Entregue"), false);
  assert.equal(canCancel("Cancelado"), false);
});

test("transições de status do kanban seguem a ordem certa", () => {
  assert.equal(isValidTransition("Na Fila", "Em Preparo"), true);
  assert.equal(isValidTransition("Na Fila", "Cancelado"), true);
  assert.equal(isValidTransition("Em Preparo", "Pronto"), true);
  assert.equal(isValidTransition("Pronto", "Entregue"), true);
});

test("transições fora de ordem são rejeitadas (não pode pular etapa nem voltar)", () => {
  assert.equal(isValidTransition("Na Fila", "Pronto"), false);
  assert.equal(isValidTransition("Na Fila", "Entregue"), false);
  assert.equal(isValidTransition("Em Preparo", "Entregue"), false);
  assert.equal(isValidTransition("Em Preparo", "Cancelado"), false);
  assert.equal(isValidTransition("Pronto", "Na Fila"), false);
  assert.equal(isValidTransition("Entregue", "Na Fila"), false);
  assert.equal(isValidTransition("Cancelado", "Na Fila"), false);
});
