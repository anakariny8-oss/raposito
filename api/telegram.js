const { neon } = require("@neondatabase/serverless");
const { createMockDb } = require("../lib/mock-db");
const {
  normalizeText,
  parseMoneyCents,
  formatBRL,
  monthInfo,
  defaultEnvelopes,
  parseExpenseText,
  parseIncomeText,
  monthsInclusiveUntil,
} = require("../lib/domain");

let schemaPromise;
let mockSqlInstance = null;
const chatContexts = new Map();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_profile (
    singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
    owner_user_id text,
    owner_chat_id text,
    delete_pending boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `INSERT INTO bot_profile (singleton_id) VALUES (1) ON CONFLICT (singleton_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS monthly_configs (
    month_key date PRIMARY KEY,
    income_cents integer,
    fixed_cents integer,
    savings_cents integer,
    spending_limit_cents integer,
    setup_step text
  )`,
  `CREATE TABLE IF NOT EXISTS envelopes (
    month_key date NOT NULL,
    name text NOT NULL,
    limit_cents integer NOT NULL DEFAULT 0,
    PRIMARY KEY (month_key, name)
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id bigserial PRIMARY KEY,
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    category text NOT NULL,
    description text NOT NULL DEFAULT '',
    spent_at date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS expenses_spent_at_idx ON expenses (spent_at)`,
  `CREATE TABLE IF NOT EXISTS savings_goals (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    target_cents integer NOT NULL CHECK (target_cents > 0),
    saved_cents integer NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
    due_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS savings_goals_name_lower_idx ON savings_goals (lower(name))`,
  `CREATE TABLE IF NOT EXISTS incomes (
    id bigserial PRIMARY KEY,
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    source text NOT NULL DEFAULT 'Renda',
    received_at date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS incomes_received_at_idx ON incomes (received_at)`,
  `CREATE TABLE IF NOT EXISTS processed_updates (
    update_id bigint PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
  )`,
];

function getSql() {
  if (process.env.DATABASE_URL) {
    try {
      return neon(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[AI Studio] Failed to initialize Neon connection, falling back to mock:", error?.message || error);
    }
  }
  if (!mockSqlInstance) {
    mockSqlInstance = createMockDb();
  }
  return mockSqlInstance;
}

async function ensureSchema(sql) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const statement of SCHEMA) await sql.query(statement);
    })();
  }
  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && require("node:crypto").timingSafeEqual(left, right);
}

function getCommand(text) {
  const match = String(text ?? "").trim().match(/^\/(\w+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), rest: (match[2] || "").trim() } : null;
}

async function getProfile(sql) {
  const rows = await sql`SELECT owner_user_id, owner_chat_id, delete_pending FROM bot_profile WHERE singleton_id = 1`;
  return rows[0] || { owner_user_id: null, owner_chat_id: null, delete_pending: false };
}

async function ensureMonth(sql, monthKey) {
  const current = await sql`SELECT * FROM monthly_configs WHERE month_key = ${monthKey}::date LIMIT 1`;
  if (current[0]) return current[0];

  const previous = await sql`
    SELECT * FROM monthly_configs
    WHERE setup_step IS NULL AND spending_limit_cents IS NOT NULL
    ORDER BY month_key DESC LIMIT 1
  `;
  if (previous[0]) {
    const p = previous[0];
    await sql`
      INSERT INTO monthly_configs (month_key, income_cents, fixed_cents, savings_cents, spending_limit_cents, setup_step)
      VALUES (${monthKey}::date, ${p.income_cents}, ${p.fixed_cents}, ${p.savings_cents}, ${p.spending_limit_cents}, NULL)
      ON CONFLICT (month_key) DO NOTHING
    `;
    const previousKey = p.month_key instanceof Date
      ? p.month_key.toISOString().slice(0, 10)
      : String(p.month_key).slice(0, 10);
    const oldEnvelopes = await sql`SELECT name, limit_cents FROM envelopes WHERE month_key = ${previousKey}::date`;
    for (const envelope of oldEnvelopes) {
      await sql`
        INSERT INTO envelopes (month_key, name, limit_cents)
        VALUES (${monthKey}::date, ${envelope.name}, ${envelope.limit_cents})
        ON CONFLICT (month_key, name) DO NOTHING
      `;
    }
  } else {
    await sql`INSERT INTO monthly_configs (month_key) VALUES (${monthKey}::date) ON CONFLICT (month_key) DO NOTHING`;
  }
  const reread = await sql`SELECT * FROM monthly_configs WHERE month_key = ${monthKey}::date LIMIT 1`;
  return reread[0];
}

async function getEnvelopes(sql, monthKey) {
  return sql`SELECT name, limit_cents FROM envelopes WHERE month_key = ${monthKey}::date ORDER BY name`;
}

async function replaceEnvelopes(sql, monthKey, items) {
  await sql`DELETE FROM envelopes WHERE month_key = ${monthKey}::date`;
  for (const item of items) {
    await sql`
      INSERT INTO envelopes (month_key, name, limit_cents)
      VALUES (${monthKey}::date, ${item.name}, ${item.limitCents})
      ON CONFLICT (month_key, name) DO UPDATE SET limit_cents = EXCLUDED.limit_cents
    `;
  }
}

async function spendingByCategory(sql, monthKey) {
  return sql`
    SELECT category, COALESCE(SUM(amount_cents), 0)::int AS spent_cents
    FROM expenses
    WHERE spent_at >= ${monthKey}::date
      AND spent_at < (${monthKey}::date + INTERVAL '1 month')
    GROUP BY category
  `;
}

function moneyFromCommand(rest) {
  const match = String(rest).match(/(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)/i);
  return match ? parseMoneyCents(match[1]) : null;
}

async function startSetup(sql, monthKey) {
  await sql`
    INSERT INTO monthly_configs (month_key, setup_step)
    VALUES (${monthKey}::date, 'income')
    ON CONFLICT (month_key) DO UPDATE SET setup_step = 'income'
  `;
  return "Vamos montar seu orçamento do mês. Primeiro: qual é sua renda líquida mensal?\n\n💡 Você pode enviar um valor único (ex: 3500) ou detalhar várias fontes somadas (ex: 3500 salário + 800 auxílio alimentação).";
}

async function continueSetup(sql, config, monthKey, text) {
  if (config.setup_step === "income") {
    const parsed = parseIncomeText(text);
    if (!parsed || !parsed.items.length || parsed.totalCents <= 0) {
      if (/sal[aá]riio|sal[aá]rio|aux[ií]lio|alimenta[cç][aã]o|vale|renda|ganho|extra|mais/i.test(text)) {
        return "Entendi que sua renda tem salário, auxílio e outros ganhos! 🦊\nPara somarmos tudo no orçamento, envie os valores juntos, por exemplo:\n• 3500 salário e 800 alimentação\n• salário 3500 auxílio alimentação 800\n• salário 3500, alimentação 800, extra 400\n\nQual é o valor do seu salário e benefícios?";
      }
      return "Não consegui ler o valor da renda. Envie um valor em reais (ex: 3500) ou detalhe as fontes somadas (ex: 3500 salário + 800 alimentação).";
    }

    const { today } = monthInfo();
    for (const item of parsed.items) {
      await sql`
        INSERT INTO incomes (amount_cents, source, received_at)
        VALUES (${item.amountCents}, ${item.source}, ${today}::date)
      `;
    }

    await sql`
      UPDATE monthly_configs
      SET income_cents = ${parsed.totalCents}, setup_step = 'fixed'
      WHERE month_key = ${monthKey}::date
    `;

    const summaryParts = parsed.items.length > 1
      ? `\nDetalhamento:\n${parsed.items.map(i => `• ${i.source}: ${formatBRL(i.amountCents)}`).join("\n")}`
      : "";

    return `Renda mensal registrada: ${formatBRL(parsed.totalCents)}.${summaryParts}\n\nAgora: quanto você paga, em média, de contas fixas por mês no total? Se não tiver, envie 0.`;
  }

  const amount = parseMoneyCents(text, { allowZero: true });
  if (amount === null) {
    return "Não consegui ler esse valor. Envie um valor em reais, por exemplo: 1500 ou 0.";
  }

  if (config.setup_step === "fixed") {
    await sql`UPDATE monthly_configs SET fixed_cents = ${amount}, setup_step = 'savings' WHERE month_key = ${monthKey}::date`;
    return "Quanto quer separar por mês para guardar? Se ainda não sabe, envie 0. Isso é só um plano; não faço transferências.";
  }
  if (config.setup_step === "savings") {
    const income = Number(config.income_cents || 0);
    const fixed = Number(config.fixed_cents || 0);
    const spendingLimit = income - amount;
    const variable = spendingLimit - fixed;
    if (spendingLimit <= 0 || variable < 0) {
      return `Esses valores não fecham: renda ${formatBRL(income)}, contas fixas ${formatBRL(fixed)} e valor para guardar ${formatBRL(amount)}. Envie outro valor mensal para guardar, ou use /configurar para recomeçar.`;
    }
    await sql`
      UPDATE monthly_configs
      SET savings_cents = ${amount}, spending_limit_cents = ${spendingLimit}, setup_step = NULL
      WHERE month_key = ${monthKey}::date
    `;
    await replaceEnvelopes(sql, monthKey, defaultEnvelopes(spendingLimit, fixed));
    return `Orçamento configurado para este mês.\nRenda total: ${formatBRL(income)}\nContas fixas reservadas: ${formatBRL(fixed)}\nPlanejado para guardar: ${formatBRL(amount)}\nTeto total de gastos: ${formatBRL(spendingLimit)}\n\nCaixinhas iniciais: contas = ${formatBRL(fixed)}; mercado 40%, transporte 15%, lazer 20%, viagem 15% e outros 10% do valor variável. São sugestões iniciais: ajuste com /caixinha nome valor.\n\nUse /saldo para consultar, /renda para ver seus ganhos ou /ajuda para ver os comandos.`;
  }
  return "Configuração do orçamento não encontrada. Envie /configurar para começar novamente.";
}

async function addIncome(sql, monthKey, today, text) {
  const parsed = parseIncomeText(text);
  if (!parsed || !parsed.items.length || parsed.totalCents <= 0) {
    return "Não consegui identificar o valor do ganho. Exemplo: “recebi 800 alimentação” ou “/recebi 500 freela”.";
  }

  for (const item of parsed.items) {
    await sql`
      INSERT INTO incomes (amount_cents, source, received_at)
      VALUES (${item.amountCents}, ${item.source}, ${today}::date)
    `;
  }

  const allIncomes = await sql`
    SELECT id, amount_cents, source, received_at
    FROM incomes
    WHERE received_at >= ${monthKey}::date AND received_at < (${monthKey}::date + INTERVAL '1 month')
  `;
  const totalIncomeCents = allIncomes.reduce((acc, r) => acc + Number(r.amount_cents || 0), 0);
  const config = await ensureMonth(sql, monthKey);

  const fixed = Number(config.fixed_cents || 0);
  const savings = Number(config.savings_cents || 0);
  let updatedLimit = totalIncomeCents - savings;
  if (updatedLimit <= 0) updatedLimit = totalIncomeCents;

  await sql`
    UPDATE monthly_configs
    SET income_cents = ${totalIncomeCents}, spending_limit_cents = ${updatedLimit}
    WHERE month_key = ${monthKey}::date
  `;

  if (config.spending_limit_cents !== null && config.spending_limit_cents !== undefined) {
    await replaceEnvelopes(sql, monthKey, defaultEnvelopes(updatedLimit, fixed));
  }

  const itemsDesc = parsed.items.map(i => `${formatBRL(i.amountCents)} (${i.source})`).join(", ");
  return `💰 Ganho anotado: ${itemsDesc}!\nRenda total do mês: ${formatBRL(totalIncomeCents)}.\nTeto total de gastos atualizado para: ${formatBRL(updatedLimit)}.\n\nConsulte /renda para ver todos os ganhos ou /saldo para o resumo.`;
}

async function listIncomes(sql, monthKey) {
  const incomes = await sql`
    SELECT id, amount_cents, source, received_at
    FROM incomes
    WHERE received_at >= ${monthKey}::date AND received_at < (${monthKey}::date + INTERVAL '1 month')
    ORDER BY received_at, id
  `;
  const config = await ensureMonth(sql, monthKey);
  const total = incomes.reduce((acc, r) => acc + Number(r.amount_cents || 0), 0) || Number(config.income_cents || 0);

  if (!incomes.length && !config.income_cents) {
    return "Ainda não há renda registrada neste mês. Envie /configurar ou “recebi 800 alimentação”.";
  }

  const lines = [`💰 Renda e Ganhos do Mês (${monthKey.slice(0, 7)}):`];
  if (incomes.length) {
    for (const inc of incomes) {
      const dateStr = inc.received_at instanceof Date ? inc.received_at.toISOString().slice(0, 10) : String(inc.received_at).slice(0, 10);
      lines.push(`• ${inc.source}: ${formatBRL(inc.amount_cents)} (${dateStr})`);
    }
  } else {
    lines.push(`• Renda informada: ${formatBRL(config.income_cents)}`);
  }
  lines.push("", `Total de renda recebida: ${formatBRL(total)}.`);
  lines.push("Adicione novos ganhos a qualquer momento: “recebi 800 alimentação” ou /recebi valor origem.");
  return lines.join("\n");
}

async function setManualLimit(sql, monthKey, amount) {
  if (amount === null || amount <= 0) return "Informe um limite positivo. Exemplo: /limite 2500";
  const config = await ensureMonth(sql, monthKey);
  const fixed = Math.min(Number(config.fixed_cents || 0), amount);
  await sql`
    INSERT INTO monthly_configs (month_key, spending_limit_cents, setup_step)
    VALUES (${monthKey}::date, ${amount}, NULL)
    ON CONFLICT (month_key) DO UPDATE SET spending_limit_cents = ${amount}, setup_step = NULL
  `;
  await replaceEnvelopes(sql, monthKey, defaultEnvelopes(amount, fixed));
  return `Limite de gastos deste mês definido em ${formatBRL(amount)}. Recriei as caixinhas iniciais; personalize com /caixinha nome valor. Use /saldo para consultar o restante.`;
}

async function reportBalance(sql, config, monthKey) {
  if (!config || config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
    return "Ainda não há orçamento mensal. Envie /configurar para informar renda, contas fixas e quanto quer guardar.";
  }
  const [envelopes, byCategory, allIncomes] = await Promise.all([
    getEnvelopes(sql, monthKey),
    spendingByCategory(sql, monthKey),
    sql`SELECT source, amount_cents FROM incomes WHERE received_at >= ${monthKey}::date AND received_at < (${monthKey}::date + INTERVAL '1 month')`,
  ]);
  const spentMap = new Map(byCategory.map((row) => [normalizeText(row.category), Number(row.spent_cents || 0)]));
  const totalSpent = byCategory.reduce((sum, row) => sum + Number(row.spent_cents || 0), 0);
  const limit = Number(config.spending_limit_cents);
  const totalIncome = allIncomes.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0) || Number(config.income_cents || 0);

  const lines = [
    `Resumo do mês (${monthKey.slice(0, 7)})`,
    `Renda total: ${formatBRL(totalIncome)}${allIncomes.length > 1 ? ` (${allIncomes.map(i => `${i.source}: ${formatBRL(i.amount_cents)}`).join(" + ")})` : ""}`,
    `Teto de gastos: ${formatBRL(limit)}`,
    `Gasto registrado: ${formatBRL(totalSpent)}`,
    `Ainda pode gastar: ${formatBRL(limit - totalSpent)}`,
  ];
  if (envelopes.length) {
    lines.push("", "Caixinhas:");
    for (const envelope of envelopes) {
      const spent = spentMap.get(normalizeText(envelope.name)) || 0;
      const remaining = Number(envelope.limit_cents) - spent;
      lines.push(`• ${envelope.name}: ${formatBRL(remaining)} de ${formatBRL(envelope.limit_cents)} restantes`);
    }
  } else {
    lines.push("", "Ainda não há caixinhas; use /caixinha nome valor para criá-las.");
  }
  return lines.join("\n");
}

async function listGoals(sql, now = new Date()) {
  const goals = await sql`SELECT id, name, target_cents, saved_cents, due_date FROM savings_goals ORDER BY due_date, name`;
  if (!goals.length) return "Você ainda não tem metas. Exemplo: /meta São Paulo 1200 2026-12-20";
  const lines = ["Metas e caixinhas de poupança:"];
  for (const goal of goals) {
    const target = Number(goal.target_cents);
    const saved = Number(goal.saved_cents);
    const needed = Math.max(0, target - saved);
    const dueDate = goal.due_date instanceof Date ? goal.due_date.toISOString().slice(0, 10) : String(goal.due_date).slice(0, 10);
    const months = monthsInclusiveUntil(dueDate, now);
    const monthly = months ? Math.ceil(needed / months) : needed;
    lines.push(`• ${goal.name}: ${formatBRL(saved)} de ${formatBRL(target)}; faltam ${formatBRL(needed)}; guardar cerca de ${formatBRL(monthly)}/mês até ${dueDate}.`);
  }
  return lines.join("\n");
}

async function createOrUpdateGoal(sql, rest, today) {
  const match = String(rest).match(/^(.+?)\s+(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)\s+(\d{4}-\d{2}-\d{2})$/i);
  if (!match) return "Formato: /meta nome valor AAAA-MM-DD. Exemplo: /meta São Paulo 1200 2026-12-20";
  const name = match[1].trim().slice(0, 60);
  const target = parseMoneyCents(match[2]);
  const due = match[3];
  if (!name || target === null || due <= today || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return "Confira o nome, o valor positivo e uma data futura no formato AAAA-MM-DD.";
  }
  const parsedDate = new Date(`${due}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== due) {
    return "A data da meta não parece válida. Use AAAA-MM-DD.";
  }
  const existing = await sql`SELECT id FROM savings_goals WHERE lower(name) = lower(${name}) LIMIT 1`;
  if (existing[0]) {
    await sql`UPDATE savings_goals SET target_cents = ${target}, due_date = ${due}::date WHERE id = ${existing[0].id}`;
  } else {
    await sql`INSERT INTO savings_goals (name, target_cents, due_date) VALUES (${name}, ${target}, ${due}::date)`;
  }
  return `Meta “${name}” salva: ${formatBRL(target)} até ${due}. Consulte /metas para ver o valor mensal sugerido.`;
}

async function addToGoal(sql, rest, now = new Date()) {
  const match = String(rest).match(/^(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)\s+(.+)$/i);
  if (!match) return "Formato: /guardar valor nome-da-meta. Exemplo: /guardar 100 São Paulo";
  const amount = parseMoneyCents(match[1]);
  const name = match[2].trim();
  if (amount === null) return "Informe um valor positivo para guardar.";
  const goals = await sql`SELECT id, name, target_cents, saved_cents FROM savings_goals`;
  const goal = goals.find((item) => normalizeText(item.name) === normalizeText(name));
  if (!goal) return `Não encontrei a meta “${name}”. Veja /metas ou crie uma com /meta nome valor AAAA-MM-DD.`;
  const saved = Number(goal.saved_cents) + amount;
  await sql`UPDATE savings_goals SET saved_cents = ${saved} WHERE id = ${goal.id}`;
  const needed = Math.max(0, Number(goal.target_cents) - saved);
  const dueRow = await sql`SELECT due_date FROM savings_goals WHERE id = ${goal.id}`;
  const dueDate = dueRow[0].due_date instanceof Date ? dueRow[0].due_date.toISOString().slice(0, 10) : String(dueRow[0].due_date).slice(0, 10);
  const months = monthsInclusiveUntil(dueDate, now);
  const monthly = months ? Math.ceil(needed / months) : needed;
  return `Anotado: ${formatBRL(amount)} guardados para “${goal.name}”.\nTotal da meta: ${formatBRL(saved)} de ${formatBRL(goal.target_cents)}.\nFaltam ${formatBRL(needed)}; cerca de ${formatBRL(monthly)}/mês até ${dueDate}. Não movi dinheiro.`;
}

async function setEnvelope(sql, monthKey, rest, config) {
  if (!config || config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
    return "Defina primeiro o orçamento com /configurar ou /limite valor.";
  }
  const match = String(rest).match(/^(.+?)\s+(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)$/i);
  if (!match) return "Formato: /caixinha nome valor. Exemplo: /caixinha mercado 800";
  const name = match[1].trim().toLowerCase().slice(0, 40);
  const amount = parseMoneyCents(match[2], { allowZero: true });
  if (!name || amount === null) return "Informe o nome da caixinha e um valor válido.";
  const envelopes = await getEnvelopes(sql, monthKey);
  const existingName = envelopes.find((item) => normalizeText(item.name) === normalizeText(name))?.name;
  const canonical = existingName || name;
  const otherLimits = envelopes
    .filter((item) => normalizeText(item.name) !== normalizeText(canonical))
    .reduce((sum, item) => sum + Number(item.limit_cents), 0);
  if (otherLimits + amount > Number(config.spending_limit_cents)) {
    return `Não alterei: as caixinhas somariam ${formatBRL(otherLimits + amount)}, acima do teto mensal de ${formatBRL(config.spending_limit_cents)}. Reduza outra caixinha ou ajuste /limite.`;
  }
  await sql`
    INSERT INTO envelopes (month_key, name, limit_cents)
    VALUES (${monthKey}::date, ${canonical}, ${amount})
    ON CONFLICT (month_key, name) DO UPDATE SET limit_cents = EXCLUDED.limit_cents
  `;
  return `Caixinha “${canonical}” definida em ${formatBRL(amount)}. O limite total das caixinhas não passa do seu teto mensal.`;
}

async function addExpense(sql, monthKey, today, text) {
  const envelopes = await getEnvelopes(sql, monthKey);
  const parsed = parseExpenseText(text, envelopes.map((item) => item.name));
  if (!parsed) return "Não consegui identificar o valor. Exemplo: “gastei R$ 50 no mercado”.";
  if (!parsed.category) {
    return `Não reconheci a categoria. Use uma caixinha existente (${envelopes.map((item) => item.name).join(", ") || "crie uma com /caixinha nome valor"}). Exemplo: “gastei ${formatBRL(parsed.amountCents)} no mercado”.`;
  }
  const canonical = envelopes.find((item) => normalizeText(item.name) === normalizeText(parsed.category))?.name;
  if (!canonical) {
    return `A categoria “${parsed.category}” ainda não tem caixinha. Crie-a com /caixinha ${parsed.category} valor e envie o gasto novamente.`;
  }
  if (!parsed.category || !parsed.amountCents) return "Confira o valor e tente novamente.";
  await sql`
    INSERT INTO expenses (amount_cents, category, description, spent_at)
    VALUES (${parsed.amountCents}, ${canonical}, ${parsed.description}, ${today}::date)
  `;
  const config = await ensureMonth(sql, monthKey);
  const rows = await spendingByCategory(sql, monthKey);
  const totalSpent = rows.reduce((sum, row) => sum + Number(row.spent_cents || 0), 0);
  const categorySpent = Number(rows.find((row) => normalizeText(row.category) === normalizeText(canonical))?.spent_cents || 0);
  const categoryLimit = Number(envelopes.find((item) => item.name === canonical).limit_cents);
  const totalRemaining = Number(config.spending_limit_cents || 0) - totalSpent;
  const categoryRemaining = categoryLimit - categorySpent;
  let note = "";
  if (categoryRemaining < 0) note = `\nAtenção: você passou ${formatBRL(Math.abs(categoryRemaining))} da caixinha “${canonical}”.`;
  else if (categoryRemaining === 0) note = `\nA caixinha “${canonical}” chegou ao limite.`;
  if (totalRemaining < 0) note += `\nAtenção: o teto mensal foi ultrapassado em ${formatBRL(Math.abs(totalRemaining))}.`;
  return `Despesa anotada: ${formatBRL(parsed.amountCents)} em ${canonical}.\nAinda pode gastar no mês: ${formatBRL(totalRemaining)}.\nRestante em ${canonical}: ${formatBRL(categoryRemaining)}.${note}`;
}

async function handleText(sql, message) {
  const text = String(message.text || "").trim();
  const command = getCommand(text);
  const fromId = String(message.from?.id ?? "");
  const chatId = String(message.chat?.id ?? "");
  const profile = await getProfile(sql);

  if (!profile.owner_user_id) {
    const start = text.match(/^\/start(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
    const suppliedCode = (start?.[1] || "").trim();
    const expectedCode = process.env.PAIRING_CODE || "raposito123";
    if (!constantTimeEqual(suppliedCode, expectedCode)) {
      return `🦊 Olá! Eu sou o Raposito, seu bot privado de orçamento e caixinhas.\n\nPara vincular com segurança sua conta, envie:\n/start ${expectedCode}\n\nDepois disso, somente você poderá consultar e registrar lançamentos aqui.`;
    }
    await sql`
      UPDATE bot_profile SET owner_user_id = ${fromId}, owner_chat_id = ${chatId}
      WHERE singleton_id = 1 AND owner_user_id IS NULL
    `;
    const after = await getProfile(sql);
    if (after.owner_user_id !== fromId) return "Este bot já foi vinculado a outra pessoa. Para sua segurança, não aceito mais pareamentos.";
    return "🦊✅ Raposito vinculado com sucesso à sua conta!\nSeus lançamentos ficam privados neste bot.\n\nEnvie /configurar para montar o orçamento do mês ou /ajuda para ver os comandos. Não faço transferências nem acesso sua conta bancária.";
  }

  if (profile.owner_user_id !== fromId || profile.owner_chat_id !== chatId) {
    return "Este é um bot privado e não está autorizado para esta conta.";
  }

  if (profile.delete_pending) {
    if (normalizeText(text) === "apagar tudo") {
      await sql`DELETE FROM expenses`;
      await sql`DELETE FROM incomes`;
      await sql`DELETE FROM envelopes`;
      await sql`DELETE FROM savings_goals`;
      await sql`DELETE FROM monthly_configs`;
      await sql`UPDATE bot_profile SET delete_pending = false WHERE singleton_id = 1`;
      return "Dados do orçamento, gastos, rendas, caixinhas e metas apagados. O pareamento do Raposito foi mantido.";
    }
    if (command?.name === "cancelar") {
      await sql`UPDATE bot_profile SET delete_pending = false WHERE singleton_id = 1`;
      return "Exclusão cancelada; seus dados continuam salvos.";
    }
    return "Para apagar todos os dados, envie exatamente APAGAR TUDO. Para manter, envie /cancelar.";
  }

  if (command?.name === "apagardados") {
    await sql`UPDATE bot_profile SET delete_pending = true WHERE singleton_id = 1`;
    return "Isso apagará todos os lançamentos, orçamentos, caixinhas e metas deste bot. Para confirmar, envie exatamente APAGAR TUDO. Para cancelar, envie /cancelar.";
  }

  if (command?.name === "ajuda" || (command?.name === "start" && profile.owner_user_id === fromId)) {
    return "🦊 Comandos do Raposito:\n/configurar — renda (com múltiplas fontes), contas fixas e reserva\n/limite 2500 — define o teto de gastos do mês\n/saldo — resumo do mês com renda total e saldo por caixinha\n/renda — lista todos os ganhos e rendas do mês\n/recebi 800 alimentação — anota um ganho ou renda extra\n/caixinhas — mostra limites e saldos por categoria\n/caixinha mercado 800 — ajusta uma categoria\n/extrato — lista os últimos gastos registrados\n/meta São Paulo 1200 2026-12-20 — cria objetivo com prazo\n/guardar 100 São Paulo — registra quanto guardou\n/metas — mostra objetivos e ritmo mensal sugerido\n/desfazer — remove o último gasto\n/cancelar — cancela ação ou configuração em andamento\n/apagardados — solicita apagar os dados\n\n💡 Registre gastos e ganhos com fala natural:\n• “recebi 800 vale alimentação”\n• “ganhei 3500 salário”\n• “gastei R$ 50 no almoço”\n• “uber 25”\n• “mercado 120 compras semanais”\n• “almoço 35”\n• /gastei 50 mercado\n\nOs valores são apenas registrados; nada é movimentado ou transferido.";
  }

  const { monthKey, today } = monthInfo();
  let config = await ensureMonth(sql, monthKey);

  if (command?.name === "configurar") return startSetup(sql, monthKey);

  if (command?.name === "limite") {
    const amount = moneyFromCommand(command.rest);
    return setManualLimit(sql, monthKey, amount);
  }

  if (command && ["renda", "ganhos", "entradas"].includes(command.name)) {
    return listIncomes(sql, monthKey);
  }

  const parsedCandidateIncome = (!text.startsWith("/") || (command && ["recebi", "ganhei", "entrou", "renda", "ganhos"].includes(command.name)))
    ? parseIncomeText(text)
    : null;

  const mentionsIncomePattern = /(?:sal[aá]riio|sal[aá]rio|aux[ií]lio|alimenta[cç][aã]o|vale\s*alimenta|vale\s*refei|\bvr\b|\bva\b|renda|ganho|recebi|ganhei|entrou|freela|bico|extra|investimento|rendimento|dividendo|b[oô]nus|comiss[aã]o|pens[aã]o|aluguel)/i.test(text);

  if (command?.name === "cancelar" && config.setup_step) {
    await sql`UPDATE monthly_configs SET setup_step = NULL WHERE month_key = ${monthKey}::date`;
    return "Configuração cancelada. Seus lançamentos existentes foram mantidos. Para começar de novo, envie /configurar.";
  }

  if (config.setup_step && !text.startsWith("/")) {
    return continueSetup(sql, config, monthKey, text);
  }

  const envelopes = await getEnvelopes(sql, monthKey);
  const parsedCandidateExpense = (!command || ["gastei", "paguei", "comprei"].includes(command.name))
    ? parseExpenseText(text, envelopes.map((item) => item.name))
    : null;

  // Conversational greetings
  const isGreeting = /^(?:oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|e\s+a[ií]|opa|fala\s+a[ií]|hey|hello)[!.]?$/i.test(text);
  if (isGreeting) {
    return "🦊 Olá! Eu sou o Raposito, seu assistente de orçamento e caixinhas.\n\nComo posso te ajudar hoje?\n• Registrar ganhos: “3500 salário e 800 alimentação” ou “recebi 800 alimentação”\n• Registrar gastos: “gastei 50 almoço” ou “uber 25”\n• Acrescentar: “acrescente 800 alimentação” ou “acrescente caixinha mercado 800”\n• Consultar: /saldo, /renda ou /caixinhas.";
  }

  // Conversational thanks
  const isThanks = /^(?:obrigad[oa]|valeu|show|perfeito|beleza|ok|t[aá]\s+bom|combinado|entendi)[!.]?$/i.test(text);
  if (isThanks) {
    return "🦊 De nada! Sempre à disposição. Qualquer despesa, ganho ou ajuste de caixinha, é só mandar aqui.";
  }

  // Conversational help / how it works
  const isHowWorks = /^(?:como\s+funciona|o\s+que\s+voc[eê]\s+faz|quem\s+[eé]\s+voc[eê]|como\s+usar|me\s+ajuda)[?.]?$/i.test(text);
  if (isHowWorks) {
    return "🦊 Eu sou o Raposito! Te ajudo a controlar seu orçamento pelo Telegram:\n\n1️⃣ Ganhos e Rendas: diga “3500 salário e 800 alimentação” ou “recebi 800 alimentação”.\n2️⃣ Gastos: diga “gastei 50 almoço” ou “uber 25”.\n3️⃣ Acrescentar: diga “acrescente 800 alimentação”, “acrescente caixinha mercado 800” ou apenas “acrescente isso”.\n4️⃣ Consultas: use /saldo, /renda, /caixinhas e /metas.";
  }

  // Handle "acrescente isso" / "adicione isso" / "pode acrescentar"
  const isAcrescenteIsso = /^(?:por\s+favor\s+)?(?:pode\s+)?(?:acrescente|acrescentar|adicione|adicionar|coloque|colocar|inclua|incluir|some|somar|bota|botar|insira|inserir|registre|registrar)(?:\s+(?:isso|isso\s+a[ií]|a[ií]))?(?:\s+por\s+favor)?[.!]?$/i.test(text);

  if (isAcrescenteIsso) {
    const ctx = chatContexts.get(chatId);
    if (ctx && ctx.parsedIncome && ctx.parsedIncome.items && ctx.parsedIncome.items.length > 0) {
      for (const item of ctx.parsedIncome.items) {
        await sql`
          INSERT INTO incomes (amount_cents, source, received_at)
          VALUES (${item.amountCents}, ${item.source}, ${today}::date)
        `;
      }
      const allIncomes = await sql`
        SELECT id, amount_cents, source, received_at
        FROM incomes
        WHERE received_at >= ${monthKey}::date AND received_at < (${monthKey}::date + INTERVAL '1 month')
      `;
      const totalIncomeCents = allIncomes.reduce((acc, r) => acc + Number(r.amount_cents || 0), 0);
      const fixed = Number(config.fixed_cents || 0);
      const savings = Number(config.savings_cents || 0);
      let updatedLimit = totalIncomeCents - savings;
      if (updatedLimit <= 0) updatedLimit = totalIncomeCents;

      await sql`
        UPDATE monthly_configs
        SET income_cents = ${totalIncomeCents}, spending_limit_cents = ${updatedLimit}
        WHERE month_key = ${monthKey}::date
      `;
      if (config.spending_limit_cents !== null && config.spending_limit_cents !== undefined) {
        await replaceEnvelopes(sql, monthKey, defaultEnvelopes(updatedLimit, fixed));
      }
      chatContexts.delete(chatId);
      const itemsDesc = ctx.parsedIncome.items.map(i => `${formatBRL(i.amountCents)} (${i.source})`).join(", ");
      return `🦊 Feito! Acrescentei ${itemsDesc} aos seus ganhos!\n\nRenda total do mês: ${formatBRL(totalIncomeCents)}.\nTeto total de gastos atualizado para: ${formatBRL(updatedLimit)}.\n\nConsulte /renda para ver todos os ganhos ou /saldo para o resumo.`;
    }

    if (ctx && ctx.parsedExpense && ctx.parsedExpense.amountCents && ctx.parsedExpense.category) {
      await sql`
        INSERT INTO expenses (amount_cents, category, description, spent_at)
        VALUES (${ctx.parsedExpense.amountCents}, ${ctx.parsedExpense.category}, ${ctx.parsedExpense.description || ""}, ${today}::date)
      `;
      chatContexts.delete(chatId);
      return `🦊 Feito! Acrescentei a despesa de ${formatBRL(ctx.parsedExpense.amountCents)} em ${ctx.parsedExpense.category}.\nConsulte /saldo para ver o resumo.`;
    }

    if (ctx && ctx.mentionsIncome) {
      return "🦊 Entendido! Para eu acrescentar na sua renda, envie os valores correspondentes, por exemplo:\n• “3500 salário e 800 alimentação”\n• “salário 3500 auxílio alimentação 800”\n• Ou diga um por um: “acrescente 800 alimentação”\n\nEnvie agora os valores que eu registro imediatamente!";
    }

    return "🦊 O que você deseja acrescentar?\nDiga o que gostaria de registrar, por exemplo:\n• Um ganho ou renda: “acrescente 800 alimentação” ou “acrescente 500 freela”\n• Um gasto: “acrescente 50 almoço” ou “acrescente uber 25”\n• Uma caixinha: “acrescente caixinha mercado 800”\n• Uma meta: “acrescente meta Viagem 1200 2026-12-20”\n\nEnvie o que deseja acrescentar agora que eu anoto para você!";
  }

  // Handle "acrescente [conteúdo]" / "adicione [conteúdo]" / "coloque [conteúdo]"
  const addPrefixMatch = text.match(/^(?:por\s+favor\s+)?(?:pode\s+)?(?:acrescente|acrescentar|adicione|adicionar|coloque|colocar|inclua|incluir|some|somar|bota|botar|insira|inserir|registre|registrar)(?:\s+(?:isso|isso\s+a[ií]|a[ií]))?(?:\s*[:,-])?\s+(.+)$/i);
  if (addPrefixMatch) {
    const cleanAction = addPrefixMatch[1].trim();

    // Check if adding to caixinha (envelope)
    const caixinhaDirect = cleanAction.match(/^(?:mais\s+)?(?:uma\s+)?(?:caixinha|envelope)\s+(.+)$/i);
    if (caixinhaDirect) {
      return setEnvelope(sql, monthKey, caixinhaDirect[1], config);
    }

    const caixinhaIncrement = cleanAction.match(/^(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)\s+(?:na|para\s+a|no)\s+(?:caixinha|envelope)\s+(.+)$/i)
      || cleanAction.match(/(?:na|para\s+a|no)\s+(?:caixinha|envelope)\s+(.+?)\s+(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)$/i);
    if (caixinhaIncrement) {
      const amountToAdd = parseMoneyCents(caixinhaIncrement[1] || caixinhaIncrement[2]);
      const targetName = (caixinhaIncrement[1] && caixinhaIncrement[2] ? (cleanAction.includes(caixinhaIncrement[1]) && cleanAction.indexOf(caixinhaIncrement[1]) === 0 ? caixinhaIncrement[2] : caixinhaIncrement[1]) : (caixinhaIncrement[2] || caixinhaIncrement[1])).trim().toLowerCase();
      if (amountToAdd !== null && targetName) {
        const envList = await getEnvelopes(sql, monthKey);
        const existing = envList.find((item) => normalizeText(item.name) === normalizeText(targetName));
        const newLimit = (existing ? Number(existing.limit_cents) : 0) + amountToAdd;
        const nameToUse = existing ? existing.name : targetName;
        return setEnvelope(sql, monthKey, `${nameToUse} ${newLimit / 100}`, config);
      }
    }

    // Check if adding to meta (savings goal)
    const goalDirect = cleanAction.match(/^meta\s+(.+)$/i);
    if (goalDirect) {
      return createOrUpdateGoal(sql, goalDirect[1], today);
    }
    const goalIncrement = cleanAction.match(/^(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)\s+(?:na|para\s+a)\s+meta\s+(.+)$/i)
      || cleanAction.match(/(?:na|para\s+a)\s+meta\s+(.+?)\s+(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,2})?)$/i);
    if (goalIncrement) {
      const amountToAdd = parseMoneyCents(goalIncrement[1] || goalIncrement[2]);
      const targetGoal = (cleanAction.indexOf("meta") < cleanAction.indexOf(goalIncrement[1] || "") ? (goalIncrement[1] || goalIncrement[2]) : (goalIncrement[2] || goalIncrement[1])).trim();
      if (amountToAdd !== null && targetGoal) {
        return addToGoal(sql, `${amountToAdd / 100} ${targetGoal}`);
      }
    }

    // Check if income
    const parsedAddIncome = parseIncomeText(cleanAction);
    const hasIncomeClue = /(?:sal[aá]riio|sal[aá]rio|aux[ií]lio|alimenta[cç][aã]o|vale|vr|va|renda|ganho|freela|bico|extra|comiss[aã]o|b[oô]nus)/i.test(cleanAction);
    const hasExpenseClue = /(?:gasto|despesa|paguei|comprei|almo[cç]o|jantar|lanche|uber|t[aá]xi|gasolina|farm[aá]cia)/i.test(cleanAction);

    if (parsedAddIncome && parsedAddIncome.items && parsedAddIncome.items.length > 0 && (hasIncomeClue || !hasExpenseClue)) {
      return addIncome(sql, monthKey, today, cleanAction);
    }

    // Check if expense
    const parsedAddExpense = parseExpenseText(cleanAction, envelopes.map((item) => item.name));
    if (parsedAddExpense && parsedAddExpense.amountCents && parsedAddExpense.category) {
      if (config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
        return "Antes de registrar gastos, defina seu orçamento com /configurar ou /limite valor.";
      }
      return addExpense(sql, monthKey, today, cleanAction);
    }
  }

  // Save context for following interactions
  chatContexts.set(chatId, {
    text,
    parsedIncome: parsedCandidateIncome,
    parsedExpense: parsedCandidateExpense,
    mentionsIncome: mentionsIncomePattern,
    timestamp: Date.now(),
  });

  // Natural explanation if user asks or talks about their income sources without numbers
  if (mentionsIncomePattern && (!parsedCandidateIncome || !parsedCandidateIncome.items.length) && !text.startsWith("/") && !/^(?:gastei|paguei|comprei)\b/i.test(text)) {
    return "🦊 O Raposito reconhece várias fontes de renda somadas (salário, auxílio alimentação, freelas e rendas extras)!\n\n💡 Como enviar:\n• No orçamento inicial: use /configurar e envie:\n  “3500 salário e 800 alimentação”\n  ou “salário 3500 auxílio alimentação 800”\n\n• Ao receber ganhos no mês:\n  “recebi 800 alimentação”\n  “recebi 500 freela”\n\n• Para consultar todos os ganhos: use /renda ou /saldo.\n\nEnvie seus valores agora ou digite /configurar para iniciar!";
  }

  const isIncomeKeyword = (command && ["recebi", "ganhei", "entrou"].includes(command.name))
    || /^(?:hoje\s+)?(?:recebi|ganhei|entrou)\b/i.test(text)
    || (parsedCandidateIncome && parsedCandidateIncome.items.length > 0 && mentionsIncomePattern && !/^(?:gastei|paguei|comprei)\b/i.test(text));

  if (isIncomeKeyword && parsedCandidateIncome && parsedCandidateIncome.items.length > 0) {
    if (config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
      for (const item of parsedCandidateIncome.items) {
        await sql`
          INSERT INTO incomes (amount_cents, source, received_at)
          VALUES (${item.amountCents}, ${item.source}, ${today}::date)
        `;
      }
      await sql`
        UPDATE monthly_configs
        SET income_cents = ${parsedCandidateIncome.totalCents}, setup_step = 'fixed'
        WHERE month_key = ${monthKey}::date
      `;
      const summaryParts = parsedCandidateIncome.items.length > 1
        ? `\nDetalhamento:\n${parsedCandidateIncome.items.map(i => `• ${i.source}: ${formatBRL(i.amountCents)}`).join("\n")}`
        : "";
      return `🦊 Renda mensal registrada: ${formatBRL(parsedCandidateIncome.totalCents)}.${summaryParts}\n\nAgora: quanto você paga, em média, de contas fixas por mês no total? Se não tiver, envie 0.`;
    }
    return addIncome(sql, monthKey, today, text);
  }

  if (command?.name === "saldo") return reportBalance(sql, config, monthKey);

  if (command?.name === "extrato" || command?.name === "gastos" || command?.name === "historico") {
    const expenses = await sql`
      SELECT id, amount_cents, category, description, spent_at
      FROM expenses
      WHERE spent_at >= ${monthKey}::date AND spent_at < (${monthKey}::date + INTERVAL '1 month')
      ORDER BY id DESC
      LIMIT 10
    `;
    if (!expenses.length) return "Nenhum gasto registrado neste mês ainda. Para registrar: “gastei R$ 50 no almoço” ou “uber 25”.";
    const lines = ["Últimos gastos registrados neste mês:"];
    for (const exp of expenses) {
      const dateStr = exp.spent_at instanceof Date ? exp.spent_at.toISOString().slice(0, 10) : String(exp.spent_at).slice(0, 10);
      const desc = exp.description ? ` (${exp.description})` : "";
      lines.push(`• ${dateStr}: ${formatBRL(exp.amount_cents)} em ${exp.category}${desc}`);
    }
    lines.push("", "Use /desfazer para remover o último lançamento ou /saldo para o resumo.");
    return lines.join("\n");
  }

  if (command?.name === "caixinhas") {
    if (config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
      return "Ainda não há orçamento mensal. Envie /configurar para começar.";
    }
    const envelopes = await getEnvelopes(sql, monthKey);
    const spentRows = await spendingByCategory(sql, monthKey);
    const spentMap = new Map(spentRows.map((row) => [normalizeText(row.category), Number(row.spent_cents || 0)]));
    if (!envelopes.length) return "Você ainda não criou caixinhas. Use /caixinha nome valor.";
    return ["Caixinhas deste mês:", ...envelopes.map((item) => {
      const spent = spentMap.get(normalizeText(item.name)) || 0;
      return `• ${item.name}: limite ${formatBRL(item.limit_cents)}; gasto ${formatBRL(spent)}; restante ${formatBRL(Number(item.limit_cents) - spent)}`;
    }), "", `Use /caixinha nome valor para ajustar. Teto total: ${formatBRL(config.spending_limit_cents)}.`].join("\n");
  }

  if (command?.name === "caixinha") return setEnvelope(sql, monthKey, command.rest, config);
  if (command?.name === "meta") return createOrUpdateGoal(sql, command.rest, today);
  if (command?.name === "metas") return listGoals(sql);
  if (command?.name === "guardar") return addToGoal(sql, command.rest);

  if (command?.name === "desfazer") {
    const latest = await sql`SELECT id, amount_cents, category FROM expenses ORDER BY id DESC LIMIT 1`;
    if (!latest[0]) return "Não há despesa para desfazer.";
    await sql`DELETE FROM expenses WHERE id = ${latest[0].id}`;
    return `Removi o último lançamento: ${formatBRL(latest[0].amount_cents)} em ${latest[0].category}. Consulte /saldo para conferir.`;
  }

  const isExpenseKeyword = (command && ["gastei", "paguei", "comprei"].includes(command.name)) || /^(?:hoje\s+)?(?:gastei|paguei|comprei)\b/i.test(text);
  const parsedCandidate = parsedCandidateExpense;

  if (isExpenseKeyword || (parsedCandidate && parsedCandidate.category && !text.startsWith("/"))) {
    if (config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
      return "Antes de registrar gastos, defina seu orçamento com /configurar ou /limite valor.";
    }
    return addExpense(sql, monthKey, today, text);
  }

  if (config.setup_step) {
    return "Estamos configurando seu orçamento. Envie o valor pedido ou /cancelar para parar.";
  }
  return "Não entendi. Experimente “gastei R$ 50 no mercado”, “uber 25” ou envie /ajuda.";
}

async function sendTelegramMessage(chatId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn(`[AI Studio] TELEGRAM_BOT_TOKEN not configured — mock message to chat ${chatId}: ${text}`);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
}

async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "raposito-bot" });
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const provided = req.headers["x-telegram-bot-api-secret-token"];
  if (!expected || !constantTimeEqual(provided, expected)) return res.status(401).json({ ok: false });

  let sql;
  let updateId;
  try {
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) return res.status(400).json({ ok: false });
    const message = update?.message;
    if (!message?.chat?.id || !message?.from?.id || message.chat.type !== "private" || !message.text) {
      return res.status(200).json({ ok: true });
    }

    sql = getSql();
    await ensureSchema(sql);
    const claimed = await sql`
      INSERT INTO processed_updates (update_id) VALUES (${updateId})
      ON CONFLICT (update_id) DO NOTHING RETURNING update_id
    `;
    if (!claimed.length) return res.status(200).json({ ok: true, duplicate: true });

    const reply = await handleText(sql, message);
    if (reply) await sendTelegramMessage(message.chat.id, reply);
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (sql && Number.isSafeInteger(updateId)) {
      try { await sql`DELETE FROM processed_updates WHERE update_id = ${updateId}`; } catch (_) { /* retry will be handled by Telegram */ }
    }
    console.error("Telegram bot request failed", error?.name || "Error");
    return res.status(500).json({ ok: false });
  }
}

handler.handleText = handleText;
handler.getSql = getSql;
handler.getProfile = getProfile;
handler.ensureSchema = ensureSchema;
handler.reportBalance = reportBalance;
handler.getEnvelopes = getEnvelopes;
handler.spendingByCategory = spendingByCategory;
handler.ensureMonth = ensureMonth;
handler.listGoals = listGoals;
handler.clearContexts = function() {
  chatContexts.clear();
};

module.exports = handler;
