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
  { category: "contas", aliases: ["contas", "conta", "aluguel", "condominio", "luz", "energia", "enel", "cpfl", "agua", "sabesp", "internet", "wifi", "telefone", "celular", "plano", "boleto", "fatura", "gas"] },
  { category: "mercado", aliases: ["mercado", "supermercado", "alimentacao", "comida", "almoco", "jantar", "lanche", "restaurante", "padaria", "feira", "hortifruti", "acougue", "ifood", "pizza", "hamburguer", "cafe"] },
  { category: "transporte", aliases: ["transporte", "uber", "99", "taxi", "onibus", "metro", "gasolina", "combustivel", "posto", "estacionamento", "pedagio", "tarifa"] },
  { category: "lazer", aliases: ["lazer", "cinema", "bar", "balada", "festa", "show", "passeio", "jogos", "streaming", "netflix", "spotify", "entretenimento", "churrasco", "cerveja"] },
  { category: "viagem", aliases: ["viagem", "viagens", "sp", "sao paulo", "passagem", "voo", "hotel", "airbnb", "pousada", "hospedagem"] },
  { category: "outros", aliases: ["outros", "outro", "diversos", "farmacia", "drogaria", "remedio", "saude", "medico", "roupa", "compras", "livro", "curso", "presente"] },
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
  const match = clean.match(/(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)/i);
  if (!match) return null;

  const amountCents = parseMoneyCents(match[1]);
  if (amountCents === null) return null;

  const before = clean.slice(0, match.index).trim();
  const after = clean.slice(match.index + match[0].length).trim();

  // Try finding category in text after number, then text before number, then combined
  let category = findCategory(after, knownNames);
  if (!category && before) {
    category = findCategory(before, knownNames);
  }
  if (!category) {
    category = findCategory(`${before} ${after}`.trim(), knownNames);
  }

  const rawDesc = `${before} ${after}`.trim();
  const description = rawDesc
    .replace(/\b(?:em|no|na|de|do|da|com|pra|para|por)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return { amountCents, category, description };
}

const INCOME_KEYWORDS = [
  { source: "Salário", regex: /(?:sal[aá]riio|sal[aá]rio|ordenado|holerite|remunera[cç][aã]o|pagamento)/i },
  { source: "Auxílio alimentação", regex: /(?:aux[ií]lio\s+alimenta[cç][aã]o|vale\s+alimenta[cç][aã]o|alimenta[cç][aã]o|vale\s+refei[cç][aã]o|refei[cç][aã]o|\bvr\b|\bva\b|sodexo|alelo|ticket|flash|caju|swile|ben|pluxee)/i },
  { source: "Renda extra", regex: /(?:alguns?\s+a\s+mais|algum[as]?\s+a\s+mais|a\s+mais|rendas?\s+extras?|extras?|freela(?:ncer)?|bicos?|servi[cç]os?|bico|trabalho\s+extra)/i },
  { source: "Bônus / Comissão", regex: /(?:b[oô]nus|comiss[aã]o|plr|d[eé]cimo\s+terceiro|13[ºo]?|gratifica[cç][aã]o|premia[cç][aã]o)/i },
  { source: "Investimentos", regex: /(?:rendimentos?|investimentos?|dividendos?|juros|cdi)/i },
  { source: "Aluguel", regex: /(?:aluguel|loca[cç][aã]o)/i },
  { source: "Pensão", regex: /(?:pens[aã]o)/i },
];

function identifyIncomeSource(text) {
  if (!text) return null;
  for (const item of INCOME_KEYWORDS) {
    if (item.regex.test(text)) return item.source;
  }
  const cleaned = text
    .replace(/\b(?:recebi|ganhei|de|do|da|com|r\$|reais|em|no|na|tenho|minha|meu|renda|tem|e|mais|por|exemplo)\b/gi, " ")
    .replace(/[^\w\sáéíóúâêîôûãõç]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 2) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return null;
}

function parseIncomeText(text) {
  const raw = String(text ?? "").trim();
  let clean = raw.replace(/^\/(?:recebi|ganhei|renda|ganhos)(?:@[a-z0-9_]+)?\s*/i, "");
  clean = clean.replace(/^(?:hoje\s+)?(?:recebi|ganhei|entrou)\s+/i, "");

  const moneyRegex = /(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)/gi;
  const matches = [];
  let m;
  while ((m = moneyRegex.exec(clean)) !== null) {
    const cents = parseMoneyCents(m[1]);
    if (cents !== null && cents > 0) {
      matches.push({ cents, raw: m[0], start: m.index, end: m.index + m[0].length });
    }
  }

  if (!matches.length) return { items: [], totalCents: 0 };

  const segments = [];
  segments.push(clean.slice(0, matches[0].start));
  for (let i = 1; i < matches.length; i++) {
    segments.push(clean.slice(matches[i - 1].end, matches[i].start));
  }
  segments.push(clean.slice(matches[matches.length - 1].end));

  const items = [];

  if (matches.length === 1) {
    const surrounding = `${segments[0]} ${segments[1]}`.trim();
    const source = identifyIncomeSource(surrounding) || "Renda principal";
    items.push({ amountCents: matches[0].cents, source });
  } else {
    const firstHasSource = Boolean(identifyIncomeSource(segments[0]));
    for (let i = 0; i < matches.length; i++) {
      let source = null;
      if (firstHasSource) {
        // Form: [Source 0] [Amount 0] [Source 1] [Amount 1] ...
        source = identifyIncomeSource(segments[i]);
        if (!source && segments[i + 1]) {
          source = identifyIncomeSource(segments[i + 1]);
        }
      } else {
        // Form: [Amount 0] [Source 0] [Amount 1] [Source 1] ...
        source = identifyIncomeSource(segments[i + 1]);
        if (!source && segments[i]) {
          source = identifyIncomeSource(segments[i]);
        }
      }

      if (!source) {
        if (i === 0) source = "Salário";
        else if (i === 1) source = "Auxílio alimentação";
        else source = "Renda extra";
      }
      items.push({ amountCents: matches[i].cents, source });
    }
  }

  const totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);
  return { items, totalCents };
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
  parseIncomeText,
  monthsInclusiveUntil,
};
