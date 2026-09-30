const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMoneyCents,
  formatBRL,
  defaultEnvelopes,
  parseExpenseText,
  findCategory,
  monthsInclusiveUntil,
} = require("../lib/domain");

test("interpreta valores brasileiros em reais", () => {
  assert.equal(parseMoneyCents("R$ 50"), 5000);
  assert.equal(parseMoneyCents("1.234,56"), 123456);
  assert.equal(parseMoneyCents("2500,5"), 250050);
  assert.equal(parseMoneyCents("1.000"), 100000);
  assert.equal(parseMoneyCents("0", { allowZero: true }), 0);
  assert.equal(parseMoneyCents("-20"), null);
});

test("formata reais para resposta ao usuário", () => {
  assert.match(formatBRL(5000), /50,00/);
});

test("a divisão inicial das caixinhas respeita o teto total", () => {
  const envelopes = defaultEnvelopes(350000, 180000);
  assert.equal(envelopes.reduce((sum, item) => sum + item.limitCents, 0), 350000);
  assert.equal(envelopes.find((item) => item.name === "contas").limitCents, 180000);
});

test("classifica lançamentos com texto natural e categorias usuais", () => {
  const parsed = parseExpenseText("gastei R$ 50 no almoço", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]);
  assert.equal(parsed.amountCents, 5000);
  assert.equal(parsed.category, "mercado");

  const uber = parseExpenseText("/gastei 32,90 Uber", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]);
  assert.equal(uber.amountCents, 3290);
  assert.equal(uber.category, "transporte");
});

test("reconhece categorias personalizadas e datas de meta", () => {
  assert.equal(findCategory("lanche", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]), "mercado");
  assert.equal(findCategory("hotel", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]), "viagem");
  assert.equal(monthsInclusiveUntil("2026-12-20", new Date("2026-09-30T12:00:00Z")), 4);
});
