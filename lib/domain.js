const TIME_ZONE = "America/Sao_Paulo";

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseMoneyCents(value, { allowZero = false } = {}) {
  let raw = String(value ?? "").trim().replace(/r\$/gi, "").replace(/\s/g, "");
  raw = raw.replace(/[^0-9,.-]/g, "");
  if (!raw || raw === "." || raw === "," || raw === "-") return null;

  if (raw.includes(",")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(raw)) {
    raw = raw.replace(/\./g, "");
  }

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

function formatBRL(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(cents || 0) / 100);
}

function monthInfo(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    monthKey: `${values.year}-${values.month}-01`,
    today: `${values.year}-${values.month}-${values.day}`,
    year: Number(values.year),
    month: Number(values.month),
  };
}

function defaultEnvelopes(spendingLimitCents, fixedCents = 0) {
  const total = Math.max(0, Math.round(Number(spendingLimitCents) || 0));
  const fixed = Math.max(0, Math.round(Number(fixedCents) || 0));
  if (fixed > total) return [];

  const variable = total - fixed;
  const shares = [
    ["mercado", 40],
    ["transporte", 15],
    ["lazer", 20],
    ["viagem", 15],
    ["outros", 10],
  ];
  const envelopes = [{ name: "contas", limitCents: fixed }];
  let allocated = 0;
  shares.forEach(([name, percent], index) => {
    const amount = index === shares.length - 1
      ? variable - allocated
      : Math.round((variable * percent) / 100);
    envelopes.push({ name, limitCents: amount });
    allocated += amount;
  });
  return envelopes;
}

const CATEGORY_ALIASES = [
  { category: "contas", aliases: ["contas", "conta", "aluguel", "luz", "agua", "internet", "boleto"] },
  { category: "mercado", aliases: ["mercado", "supermercado", "alimentacao", "comida", "almoco", "jantar", "lanche", "restaurante"] },
  { category: "transporte", aliases: ["transporte", "uber", "taxi", "onibus", "metro", "gasolina", "combustivel"] },
  { category: "lazer", aliases: ["lazer", "cinema", "bar", "passeio", "show", "entretenimento"] },
  { category: "viagem", aliases: ["viagem", "viagens", "sp", "sao paulo", "passagem", "hotel"] },
  { category: "outros", aliases: ["outros", "outro", "diversos"] },
];

function containsPhrase(haystack, phrase) {
  const text = ` ${normalizeText(haystack)} `;
  const needle = ` ${normalizeText(phrase)} `;
  return text.includes(needle);
}

function findCategory(text, knownNames = []) {
  const normalizedText = normalizeText(text);
  const names = [...new Set(knownNames.map((name) => String(name).trim()).filter(Boolean))]
    .sort((a, b) => normalizeText(b).length - normalizeText(a).length);
  for (const name of names) {
    if (containsPhrase(normalizedText, name)) return name;
  }
  for (const item of CATEGORY_ALIASES) {
    if (item.aliases.some((alias) => containsPhrase(normalizedText, alias))) {
      return item.category;
    }
  }
  return null;
}

function parseExpenseText(text, knownNames = []) {
  let clean = String(text ?? "").trim();
  clean = clean.replace(/^\/gastei(?:@[a-z0-9_]+)?\s*/i, "");
  clean = clean.replace(/^(?:hoje\s+)?(?:gastei|paguei|comprei)\s+/i, "");
  const match = clean.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i);
  if (!match) return null;

  const amountCents = parseMoneyCents(match[1]);
  if (amountCents === null) return null;
  const tail = clean.slice(match.index + match[0].length).trim();
  const category = findCategory(tail, knownNames);
  const description = tail
    .replace(/\b(?:em|no|na|de|do|da)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { amountCents, category, description };
}

function monthsInclusiveUntil(dateString, now = new Date()) {
  const due = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const current = monthInfo(now);
  const dueYear = due.getUTCFullYear();
  const dueMonth = due.getUTCMonth() + 1;
  const count = (dueYear - current.year) * 12 + (dueMonth - current.month) + 1;
  return count > 0 ? count : 0;
}

module.exports = {
  TIME_ZONE,
  normalizeText,
  parseMoneyCents,
  formatBRL,
  monthInfo,
  defaultEnvelopes,
  findCategory,
  parseExpenseText,
  monthsInclusiveUntil,
};
