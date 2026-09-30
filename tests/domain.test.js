const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMoneyCents,
  formatBRL,
  defaultEnvelopes,
  parseExpenseText,
  parseIncomeText,
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

  const prefixExpense = parseExpenseText("almoço 45", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]);
  assert.equal(prefixExpense.amountCents, 4500);
  assert.equal(prefixExpense.category, "mercado");

  const uberPrefix = parseExpenseText("uber 25", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]);
  assert.equal(uberPrefix.amountCents, 2500);
  assert.equal(uberPrefix.category, "transporte");
});

test("reconhece categorias personalizadas e datas de meta", () => {
  assert.equal(findCategory("lanche", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]), "mercado");
  assert.equal(findCategory("hotel", ["contas", "mercado", "transporte", "lazer", "viagem", "outros"]), "viagem");
  assert.equal(monthsInclusiveUntil("2026-12-20", new Date("2026-09-30T12:00:00Z")), 4);
});

test("reconhece múltiplas fontes de ganho e renda", () => {
  const single = parseIncomeText("3500");
  assert.equal(single.totalCents, 350000);
  assert.equal(single.items.length, 1);

  const multiple = parseIncomeText("3500 salario + 800 auxilio alimentacao e 400 freela");
  assert.equal(multiple.totalCents, 470000);
  assert.equal(multiple.items.length, 3);
  assert.equal(multiple.items[0].amountCents, 350000);
  assert.equal(multiple.items[0].source, "Salário");
  assert.equal(multiple.items[1].amountCents, 80000);
  assert.equal(multiple.items[1].source, "Auxílio alimentação");
  assert.equal(multiple.items[2].amountCents, 40000);
  assert.equal(multiple.items[2].source, "Renda extra");

  const naturalMulti = parseIncomeText("salario 3500 auxilio alimentacao 800");
  assert.equal(naturalMulti.totalCents, 430000);
  assert.equal(naturalMulti.items.length, 2);
  assert.equal(naturalMulti.items[0].source, "Salário");
  assert.equal(naturalMulti.items[0].amountCents, 350000);
  assert.equal(naturalMulti.items[1].source, "Auxílio alimentação");
  assert.equal(naturalMulti.items[1].amountCents, 80000);

  const userCase = parseIncomeText("minha renda tem salariio 3500 auxilio alimentacao 800 e as vez alguns a mais 400");
  assert.equal(userCase.totalCents, 470000);
  assert.equal(userCase.items.length, 3);
  assert.equal(userCase.items[0].source, "Salário");
  assert.equal(userCase.items[0].amountCents, 350000);
  assert.equal(userCase.items[1].source, "Auxílio alimentação");
  assert.equal(userCase.items[1].amountCents, 80000);
  assert.equal(userCase.items[2].source, "Renda extra");
  assert.equal(userCase.items[2].amountCents, 40000);

  const recebi = parseIncomeText("/recebi 850 vale alimentação");
  assert.equal(recebi.totalCents, 85000);
  assert.equal(recebi.items[0].source, "Auxílio alimentação");
});
