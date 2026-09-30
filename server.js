const express = require("express");
const path = require("node:path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const healthHandler = require("./api/health");
const telegramHandler = require("./api/telegram");
const { monthInfo } = require("./lib/domain");

// Official Telegram Webhook and Health check endpoints
app.all("/api/health", (req, res) => healthHandler(req, res));
app.all("/api/telegram", (req, res) => telegramHandler(req, res));

// Interactive Bot Simulator endpoint: allows chatting directly with the bot
app.post("/api/bot/chat", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const fromId = String(req.body.from_id || "123456789");
    const chatId = String(req.body.chat_id || "123456789");

    if (!text) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    const sql = telegramHandler.getSql();
    await telegramHandler.ensureSchema(sql);

    const message = {
      message_id: Date.now(),
      chat: { id: chatId, type: "private" },
      from: { id: fromId, first_name: "Você" },
      text: text,
      date: Math.floor(Date.now() / 1000),
    };

    const reply = await telegramHandler.handleText(sql, message);
    return res.json({ ok: true, reply, text });
  } catch (error) {
    console.error("Bot chat error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Bot live state: budget, envelopes, goals, recent expenses, pairing info
app.get("/api/bot/state", async (req, res) => {
  try {
    const sql = telegramHandler.getSql();
    await telegramHandler.ensureSchema(sql);
    const profile = await telegramHandler.getProfile(sql);
    const { monthKey, today } = monthInfo();
    const config = await telegramHandler.ensureMonth(sql, monthKey);
    const envelopes = await telegramHandler.getEnvelopes(sql, monthKey);
    const spentByCategory = await telegramHandler.spendingByCategory(sql, monthKey);
    const spentMap = new Map(spentByCategory.map((r) => [r.category.toLowerCase(), Number(r.spent_cents || 0)]));
    const totalSpentCents = spentByCategory.reduce((acc, r) => acc + Number(r.spent_cents || 0), 0);

    const goals = await sql`SELECT id, name, target_cents, saved_cents, due_date FROM savings_goals ORDER BY due_date, name`;
    const incomes = await sql`
      SELECT id, amount_cents, source, received_at
      FROM incomes
      WHERE received_at >= ${monthKey}::date AND received_at < (${monthKey}::date + INTERVAL '1 month')
      ORDER BY id DESC
    `;
    const recentExpenses = await sql`
      SELECT id, amount_cents, category, description, spent_at
      FROM expenses
      WHERE spent_at >= ${monthKey}::date AND spent_at < (${monthKey}::date + INTERVAL '1 month')
      ORDER BY id DESC
      LIMIT 10
    `;

    const envelopesWithProgress = envelopes.map((env) => {
      const limit = Number(env.limit_cents || 0);
      const spent = spentMap.get(env.name.toLowerCase()) || 0;
      const remaining = limit - spent;
      const percent = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
      return {
        name: env.name,
        limit_cents: limit,
        spent_cents: spent,
        remaining_cents: remaining,
        percent,
      };
    });

    const spendingLimit = Number(config?.spending_limit_cents || 0);
    const remainingBudget = spendingLimit - totalSpentCents;

    return res.json({
      ok: true,
      profile: {
        is_paired: Boolean(profile?.owner_user_id),
        owner_user_id: profile?.owner_user_id || null,
        owner_chat_id: profile?.owner_chat_id || null,
        delete_pending: Boolean(profile?.delete_pending),
      },
      month: {
        monthKey,
        today,
        income_cents: config?.income_cents ?? null,
        fixed_cents: config?.fixed_cents ?? null,
        savings_cents: config?.savings_cents ?? null,
        spending_limit_cents: config?.spending_limit_cents ?? null,
        setup_step: config?.setup_step ?? null,
        total_spent_cents: totalSpentCents,
        remaining_cents: remainingBudget,
      },
      envelopes: envelopesWithProgress,
      goals: goals || [],
      incomes: incomes || [],
      recentExpenses: recentExpenses || [],
      env: {
        pairing_code: process.env.PAIRING_CODE || "raposito123",
        has_telegram_token: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        has_database_url: Boolean(process.env.DATABASE_URL),
        has_webhook_secret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
        public_base_url: process.env.PUBLIC_BASE_URL || "",
      },
    });
  } catch (error) {
    console.error("Bot state error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Reset bot state for clean testing
app.post("/api/bot/reset", async (req, res) => {
  try {
    const sql = telegramHandler.getSql();
    await telegramHandler.ensureSchema(sql);
    await sql`DELETE FROM expenses`;
    await sql`DELETE FROM incomes`;
    await sql`DELETE FROM envelopes`;
    await sql`DELETE FROM savings_goals`;
    await sql`DELETE FROM monthly_configs`;
    await sql`UPDATE bot_profile SET owner_user_id = NULL, owner_chat_id = NULL, delete_pending = false WHERE singleton_id = 1`;
    return res.json({ ok: true, message: "Dados do bot reiniciados com sucesso!" });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Serve static files from website directory
const websiteDir = path.join(__dirname, "website");
app.use(express.static(websiteDir));

// Fallback to index.html for unmatched requests
app.use((req, res) => {
  res.sendFile(path.join(websiteDir, "index.html"));
});

const PORT = 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Telegram Caixinhas Bot running at http://${HOST}:${PORT}`);
});
