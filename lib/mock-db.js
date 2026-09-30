function createMockDb() {
  const store = {
    profile: { singleton_id: 1, owner_user_id: null, owner_chat_id: null, delete_pending: false },
    monthly_configs: new Map(),
    envelopes: [],
    expenses: [],
    incomes: [],
    savings_goals: [],
    processed_updates: new Set(),
    nextExpenseId: 1,
    nextIncomeId: 1,
    nextGoalId: 1,
  };

  const sql = async function (strings, ...values) {
    const raw = Array.isArray(strings) ? strings.join("?") : String(strings);
    const query = raw.replace(/\s+/g, " ").trim();

    // bot_profile
    if (query.includes("FROM bot_profile WHERE singleton_id = 1")) {
      return [{ ...store.profile }];
    }
    if (query.startsWith("UPDATE bot_profile")) {
      if (query.includes("owner_user_id = NULL")) {
        store.profile.owner_user_id = null;
        store.profile.owner_chat_id = null;
        store.profile.delete_pending = false;
      } else if (query.includes("owner_user_id =")) {
        store.profile.owner_user_id = String(values[0]);
        store.profile.owner_chat_id = String(values[1]);
      } else if (query.includes("delete_pending =")) {
        store.profile.delete_pending = Boolean(values[0]);
      }
      return [{ ...store.profile }];
    }

    // processed_updates
    if (query.includes("INSERT INTO processed_updates")) {
      const updateId = Number(values[0]);
      if (store.processed_updates.has(updateId)) {
        return [];
      }
      store.processed_updates.add(updateId);
      return [{ update_id: updateId }];
    }
    if (query.includes("DELETE FROM processed_updates")) {
      const updateId = Number(values[0]);
      store.processed_updates.delete(updateId);
      return [];
    }

    // monthly_configs
    if (query.includes("FROM monthly_configs WHERE month_key =")) {
      const key = String(values[0]);
      const conf = store.monthly_configs.get(key);
      return conf ? [{ ...conf }] : [];
    }
    if (query.includes("FROM monthly_configs WHERE setup_step IS NULL AND spending_limit_cents IS NOT NULL")) {
      const all = Array.from(store.monthly_configs.values())
        .filter((c) => c.setup_step === null && c.spending_limit_cents !== null)
        .sort((a, b) => b.month_key.localeCompare(a.month_key));
      return all[0] ? [{ ...all[0] }] : [];
    }
    if (query.startsWith("INSERT INTO monthly_configs")) {
      const key = String(values[0]);
      const existing = store.monthly_configs.get(key) || {
        month_key: key,
        income_cents: null,
        fixed_cents: null,
        savings_cents: null,
        spending_limit_cents: null,
        setup_step: null,
      };
      if (query.includes("income_cents")) {
        existing.income_cents = values[1];
        existing.fixed_cents = values[2];
        existing.savings_cents = values[3];
        existing.spending_limit_cents = values[4];
        existing.setup_step = values[5] ?? null;
      } else if (query.includes("spending_limit_cents")) {
        existing.spending_limit_cents = values[1];
        existing.setup_step = null;
      } else if (query.includes("setup_step")) {
        existing.setup_step = values[1] || "income";
      }
      store.monthly_configs.set(key, existing);
      return [{ ...existing }];
    }
    if (query.startsWith("UPDATE monthly_configs")) {
      const key = String(values[values.length - 1]);
      const existing = store.monthly_configs.get(key) || { month_key: key };
      if (query.includes("income_cents =") && query.includes("spending_limit_cents =")) {
        existing.income_cents = values[0];
        existing.spending_limit_cents = values[1];
      } else if (query.includes("income_cents =")) {
        existing.income_cents = values[0];
        existing.setup_step = "fixed";
      } else if (query.includes("fixed_cents =")) {
        existing.fixed_cents = values[0];
        existing.setup_step = "savings";
      } else if (query.includes("savings_cents =")) {
        existing.savings_cents = values[0];
        existing.spending_limit_cents = values[1];
        existing.setup_step = null;
      } else if (query.includes("setup_step = NULL")) {
        existing.setup_step = null;
      }
      store.monthly_configs.set(key, existing);
      return [{ ...existing }];
    }

    // envelopes
    if (query.includes("FROM envelopes WHERE month_key =")) {
      const key = String(values[0]);
      const rows = store.envelopes
        .filter((e) => e.month_key === key)
        .sort((a, b) => a.name.localeCompare(b.name));
      return rows.map((r) => ({ ...r }));
    }
    if (query.startsWith("DELETE FROM envelopes WHERE month_key =")) {
      const key = String(values[0]);
      store.envelopes = store.envelopes.filter((e) => e.month_key !== key);
      return [];
    }
    if (query.startsWith("INSERT INTO envelopes")) {
      const key = String(values[0]);
      const name = String(values[1]);
      const limit_cents = Number(values[2]);
      const idx = store.envelopes.findIndex((e) => e.month_key === key && e.name === name);
      if (idx >= 0) {
        store.envelopes[idx].limit_cents = limit_cents;
      } else {
        store.envelopes.push({ month_key: key, name, limit_cents });
      }
      return [];
    }

    // spendingByCategory
    if (query.includes("SUM(amount_cents)") && query.includes("FROM expenses")) {
      const key = String(values[0]);
      const catTotals = new Map();
      for (const exp of store.expenses) {
        if (exp.spent_at.startsWith(key.slice(0, 7))) {
          const current = catTotals.get(exp.category) || 0;
          catTotals.set(exp.category, current + Number(exp.amount_cents));
        }
      }
      return Array.from(catTotals.entries()).map(([category, spent_cents]) => ({
        category,
        spent_cents,
      }));
    }

    // expenses
    if (query.startsWith("INSERT INTO expenses")) {
      const exp = {
        id: store.nextExpenseId++,
        amount_cents: Number(values[0]),
        category: String(values[1]),
        description: String(values[2]),
        spent_at: String(values[3]),
        created_at: new Date(),
      };
      store.expenses.push(exp);
      return [{ ...exp }];
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY id DESC")) {
      if (query.includes("LIMIT 1") && !query.includes("LIMIT 10")) {
        const exp = store.expenses[store.expenses.length - 1];
        return exp ? [{ ...exp }] : [];
      }
      return [...store.expenses].reverse().slice(0, 10).map((e) => ({ ...e }));
    }
    if (query.startsWith("DELETE FROM expenses WHERE id =")) {
      const id = Number(values[0]);
      store.expenses = store.expenses.filter((e) => e.id !== id);
      return [];
    }

    // savings_goals
    if (query.includes("FROM savings_goals ORDER BY due_date, name")) {
      return [...store.savings_goals].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.name.localeCompare(b.name));
    }
    if (query.includes("FROM savings_goals WHERE lower(name) = lower(")) {
      const name = String(values[0]).toLowerCase();
      const goal = store.savings_goals.find((g) => g.name.toLowerCase() === name);
      return goal ? [{ id: goal.id }] : [];
    }
    if (query.startsWith("UPDATE savings_goals SET target_cents =")) {
      const target = Number(values[0]);
      const due = String(values[1]);
      const id = Number(values[2]);
      const goal = store.savings_goals.find((g) => g.id === id);
      if (goal) {
        goal.target_cents = target;
        goal.due_date = due;
      }
      return [];
    }
    if (query.startsWith("INSERT INTO savings_goals")) {
      const goal = {
        id: store.nextGoalId++,
        name: String(values[0]),
        target_cents: Number(values[1]),
        saved_cents: 0,
        due_date: String(values[2]),
        created_at: new Date(),
      };
      store.savings_goals.push(goal);
      return [{ ...goal }];
    }
    if (query.includes("SELECT id, name, target_cents, saved_cents FROM savings_goals")) {
      return store.savings_goals.map((g) => ({ ...g }));
    }
    if (query.startsWith("UPDATE savings_goals SET saved_cents =")) {
      const saved = Number(values[0]);
      const id = Number(values[1]);
      const goal = store.savings_goals.find((g) => g.id === id);
      if (goal) goal.saved_cents = saved;
      return [];
    }
    if (query.includes("SELECT due_date FROM savings_goals WHERE id =")) {
      const id = Number(values[0]);
      const goal = store.savings_goals.find((g) => g.id === id);
      return goal ? [{ due_date: goal.due_date }] : [];
    }

    // incomes
    if (query.startsWith("INSERT INTO incomes")) {
      const inc = {
        id: store.nextIncomeId++,
        amount_cents: Number(values[0]),
        source: String(values[1] || "Renda"),
        received_at: String(values[2]),
        created_at: new Date(),
      };
      store.incomes.push(inc);
      return [{ ...inc }];
    }
    if (query.includes("FROM incomes")) {
      const key = values[0] ? String(values[0]).slice(0, 7) : null;
      let rows = [...store.incomes];
      if (key) {
        rows = rows.filter((i) => i.received_at.startsWith(key));
      }
      return rows.map((r) => ({ ...r }));
    }

    // Delete all
    if (query.startsWith("DELETE FROM expenses")) { store.expenses = []; return []; }
    if (query.startsWith("DELETE FROM incomes")) { store.incomes = []; return []; }
    if (query.startsWith("DELETE FROM envelopes")) { store.envelopes = []; return []; }
    if (query.startsWith("DELETE FROM savings_goals")) { store.savings_goals = []; return []; }
    if (query.startsWith("DELETE FROM monthly_configs")) { store.monthly_configs.clear(); return []; }

    return [];
  };

  sql.query = async function () {
    return [];
  };

  return sql;
}

module.exports = { createMockDb };
