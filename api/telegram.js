const { neon } = require("@neondatabase/serverless");
const {
  normalizeText,
  parseMoneyCents,
  formatBRL,
  monthInfo,
  defaultEnvelopes,
  parseExpenseText,
  monthsInclusiveUntil,
} = require("../lib/domain");

let schemaPromise;

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
  `CREATE TABLE IF NOT EXISTS processed_updates (
    update_id bigint PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
  )`,
];

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
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
  const match = String(rest).match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i);
  return match ? parseMoneyCents(match[1]) : null;
}

async function startSetup(sql, monthKey) {
  await sql`
    INSERT INTO monthly_configs (month_key, setup_step)
    VALUES (${monthKey}::date, 'income')
    ON CONFLICT (month_key) DO UPDATE SET setup_step = 'income'
  `;
  return "Vamos montar seu orçamento do mês. Primeiro: qual é sua renda líquida mensal? Envie só o valor, por exemplo: 3500 ou R$ 3.500,00.";
}

async function continueSetup(sql, config, monthKey, text) {
  const amount = parseMoneyCents(text, { allowZero: true });
  if (amount === null) {
    return "Não consegui ler esse valor. Envie um valor em reais, por exemplo: 3500 ou R$ 3.500,00.";
  }

  if (config.setup_step === "income") {
    await sql`UPDATE monthly_configs SET income_cents = ${amount}, setup_step = 'fixed' WHERE month_key = ${monthKey}::date`;
    return "Quanto você paga, em média, de contas fixas por mês no total? Se não tiver, envie 0.";
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
    return `Orçamento configurado para este mês.\nRenda: ${formatBRL(income)}\nContas fixas reservadas: ${formatBRL(fixed)}\nPlanejado para guardar: ${formatBRL(amount)}\nTeto total de gastos: ${formatBRL(spendingLimit)}\n\nCaixinhas iniciais: contas = ${formatBRL(fixed)}; mercado 40%, transporte 15%, lazer 20%, viagem 15% e outros 10% do valor variável. São sugestões iniciais: ajuste com /caixinha nome valor.\n\nUse /saldo para consultar ou /ajuda para ver os comandos.`;
  }
  return "Configuração do orçamento não encontrada. Envie /configurar para começar novamente.";
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
  const [envelopes, byCategory] = await Promise.all([
    getEnvelopes(sql, monthKey),
    spendingByCategory(sql, monthKey),
  ]);
  const spentMap = new Map(byCategory.map((row) => [normalizeText(row.category), Number(row.spent_cents || 0)]));
  const totalSpent = byCategory.reduce((sum, row) => sum + Number(row.spent_cents || 0), 0);
  const limit = Number(config.spending_limit_cents);
  const lines = [
    `Resumo do mês (${monthKey.slice(0, 7)})`,
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
  const match = String(rest).match(/^(.+?)\s+(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s+(\d{4}-\d{2}-\d{2})$/i);
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
  const match = String(rest).match(/^(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s+(.+)$/i);
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
  const match = String(rest).match(/^(.+?)\s+(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)$/i);
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
    if (!process.env.PAIRING_CODE) return "O bot ainda não foi configurado. Defina um código secreto de pareamento na hospedagem.";
    if (!constantTimeEqual(suppliedCode, process.env.PAIRING_CODE)) {
      return "Bot privado. Para vincular, abra o bot com /start SEU_CODIGO_DE_PAREAMENTO. O código só deve ser usado por você.";
    }
    await sql`
      UPDATE bot_profile SET owner_user_id = ${fromId}, owner_chat_id = ${chatId}
      WHERE singleton_id = 1 AND owner_user_id IS NULL
    `;
    const after = await getProfile(sql);
    if (after.owner_user_id !== fromId) return "Este bot já foi vinculado a outra pessoa. Para sua segurança, não aceito mais pareamentos.";
    return "Bot vinculado somente à sua conta. Seus lançamentos ficam privados neste bot.\n\nEnvie /configurar para montar o orçamento do mês ou /ajuda para ver os comandos. Não faço transferências nem acesso sua conta bancária.";
  }

  if (profile.owner_user_id !== fromId || profile.owner_chat_id !== chatId) {
    return "Este é um bot privado e não está autorizado para esta conta.";
  }

  if (profile.delete_pending) {
    if (normalizeText(text) === "apagar tudo") {
      await sql`DELETE FROM expenses`;
      await sql`DELETE FROM envelopes`;
      await sql`DELETE FROM savings_goals`;
      await sql`DELETE FROM monthly_configs`;
      await sql`UPDATE bot_profile SET delete_pending = false WHERE singleton_id = 1`;
      return "Dados do orçamento, gastos, caixinhas e metas apagados. O pareamento do bot foi mantido.";
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

  if (command?.name === "ajuda" || command?.name === "start") {
    return "Comandos do seu bot financeiro:\n/configurar — renda, contas fixas e valor para guardar\n/limite 2500 — define o teto de gastos do mês\n/gastei 50 mercado almoço — registra uma despesa\n/caixinhas — mostra limites e saldos por categoria\n/caixinha mercado 800 — ajusta uma categoria\n/saldo — mostra quanto ainda pode gastar\n/meta São Paulo 1200 2026-12-20 — cria objetivo com prazo\n/guardar 100 São Paulo — registra quanto guardou\n/metas — mostra objetivos e ritmo mensal sugerido\n/desfazer — remove o último gasto\n/apagardados — solicita apagar os dados\n\nVocê também pode escrever “gastei R$ 50 no almoço”. Os valores são apenas registrados; nada é movimentado ou transferido. Sugestões de categorias são pontos de partida, não aconselhamento financeiro profissional.";
  }

  const { monthKey, today } = monthInfo();
  let config = await ensureMonth(sql, monthKey);

  if (command?.name === "configurar") return startSetup(sql, monthKey);

  if (command?.name === "limite") {
    const amount = moneyFromCommand(command.rest);
    return setManualLimit(sql, monthKey, amount);
  }

  if (command?.name === "cancelar" && config.setup_step) {
    await sql`UPDATE monthly_configs SET setup_step = NULL WHERE month_key = ${monthKey}::date`;
    return "Configuração cancelada. Seus lançamentos existentes foram mantidos. Para começar de novo, envie /configurar.";
  }

  if (config.setup_step && !text.startsWith("/")) {
    return continueSetup(sql, config, monthKey, text);
  }

  if (command?.name === "saldo") return reportBalance(sql, config, monthKey);

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

  if ((command && ["gastei", "paguei", "comprei"].includes(command.name)) || /^(?:hoje\s+)?(?:gastei|paguei|comprei)\b/i.test(text)) {
    if (config.spending_limit_cents === null || config.spending_limit_cents === undefined) {
      return "Antes de registrar gastos, defina seu orçamento com /configurar ou /limite valor.";
    }
    return addExpense(sql, monthKey, today, text);
  }

  if (config.setup_step) {
    return "Estamos configurando seu orçamento. Envie o valor pedido ou /cancelar para parar.";
  }
  return "Não entendi. Experimente “gastei R$ 50 no mercado” ou envie /ajuda.";
}

async function sendTelegramMessage(chatId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "telegram-caixinhas-bot" });
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
};
