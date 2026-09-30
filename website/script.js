// State
let currentState = null;

// Format cents to BRL string
function formatBRL(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(cents || 0) / 100);
}

// Format date to local
function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  } catch (_) {
    return String(dateStr);
  }
}

// Tab navigation
const tabButtons = document.querySelectorAll(".studio-tab-btn");
const switchButtons = document.querySelectorAll(".studio-switch-btn");
const views = document.querySelectorAll(".studio-view");

function switchTab(targetId) {
  views.forEach((v) => {
    v.classList.toggle("is-active", v.id === targetId);
  });
  tabButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-target") === targetId);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-target");
    if (target) switchTab(target);
  });
});

switchButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-target");
    if (target) switchTab(target);
  });
});

// Mobile menu toggle
const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#primary-nav");

if (menuButton && navigation) {
  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    navigation.classList.toggle("is-open", !isOpen);
    const label = menuButton.querySelector(".sr-only");
    if (label) label.textContent = isOpen ? "Abrir navegação" : "Fechar navegação";
  });

  navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menuButton.setAttribute("aria-expanded", "false");
      navigation.classList.remove("is-open");
      const label = menuButton.querySelector(".sr-only");
      if (label) label.textContent = "Abrir navegação";
    });
  });
}

// Copy buttons
const liveStatus = document.querySelector(".copy-status");
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") || "";
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        document.execCommand("copy");
        field.remove();
      }
      button.textContent = "Copiado";
      if (liveStatus) liveStatus.textContent = `Comando copiado: ${text}`;
      window.setTimeout(() => { button.textContent = "Copiar"; }, 1800);
    } catch (_) {
      if (liveStatus) liveStatus.textContent = `Selecione e copie o comando: ${text}`;
    }
  });
});

// Chat Simulator Elements
const chatBody = document.getElementById("sim-chat-body");
const chatForm = document.getElementById("sim-form");
const chatInput = document.getElementById("sim-input");
const btnClearChat = document.getElementById("btn-clear-chat");
const btnResetBot = document.getElementById("btn-reset-bot");

function appendMessage(text, isUser = false) {
  if (!chatBody) return;
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isUser ? "bubble-user" : "bubble-bot"}`;
  
  if (isUser) {
    bubble.textContent = text;
  } else {
    const formatted = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    bubble.innerHTML = formatted;
  }

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const now = new Date();
  meta.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  bubble.appendChild(meta);

  chatBody.appendChild(bubble);
  chatBody.scrollTop = chatBody.scrollHeight;
}

// Send message to Bot
async function sendMessage(text) {
  if (!text || !text.trim()) return;
  const clean = text.trim();
  appendMessage(clean, true);

  if (chatInput) chatInput.value = "";

  try {
    const res = await fetch("/api/bot/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });
    const data = await res.json();
    if (data.ok && data.reply) {
      appendMessage(data.reply, false);
    } else {
      appendMessage(`⚠️ Erro: ${data.error || "Não foi possível processar a mensagem."}`, false);
    }
  } catch (err) {
    appendMessage(`⚠️ Falha na comunicação com o bot: ${err.message}`, false);
  }

  fetchBotState();
}

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (chatInput && chatInput.value) {
      sendMessage(chatInput.value);
    }
  });
}

// Quick action chips
document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-cmd]");
  if (chip) {
    const cmd = chip.getAttribute("data-cmd");
    if (cmd) {
      if (chatInput) chatInput.value = cmd;
      sendMessage(cmd);
    }
  }
});

// Clear chat
if (btnClearChat) {
  btnClearChat.addEventListener("click", () => {
    if (!chatBody) return;
    chatBody.innerHTML = `
      <div class="chat-date-divider">Chat limpo</div>
      <div class="bubble bubble-bot">
        💬 Histórico limpo. Pode continuar enviando mensagens e comandos normalmente.
        <div class="bubble-meta">Agora</div>
      </div>
    `;
  });
}

// Reset bot database
if (btnResetBot) {
  btnResetBot.addEventListener("click", async () => {
    if (!confirm("Tem certeza que deseja reiniciar os dados do bot para o estado inicial?")) return;
    try {
      const res = await fetch("/api/bot/reset", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        appendMessage("🔄 O banco do bot foi reiniciado! Você pode parear novamente usando /start.", false);
        fetchBotState();
      }
    } catch (err) {
      alert("Erro ao reiniciar: " + err.message);
    }
  });
}

// Fetch Bot State & Update UI
async function fetchBotState() {
  try {
    const res = await fetch("/api/bot/state");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    currentState = data;
    renderBotState(data);
  } catch (err) {
    console.warn("Could not fetch bot state:", err);
  }
}

function renderBotState(data) {
  // Top bar pairing status
  const pairDot = document.getElementById("bot-pair-dot");
  const pairLabel = document.getElementById("bot-pair-label");
  const isPaired = data.profile?.is_paired;
  const pairingCode = data.env?.pairing_code || "raposito123";

  if (pairDot && pairLabel) {
    if (isPaired) {
      pairDot.className = "pulse-dot";
      pairLabel.textContent = "Raposito Vinculado";
    } else {
      pairDot.className = "pulse-dot dot-warning";
      pairLabel.textContent = `Aguardando /start ${pairingCode}`;
    }
  }

  // Dashboard Month KPIs
  const m = data.month || {};
  const monthKeyEl = document.getElementById("dash-month-key");
  const spendingLimitEl = document.getElementById("kpi-spending-limit");
  const totalSpentEl = document.getElementById("kpi-total-spent");
  const remainingEl = document.getElementById("kpi-remaining");
  const incomeEl = document.getElementById("kpi-income");
  const fixedEl = document.getElementById("kpi-fixed");
  const savingsEl = document.getElementById("kpi-savings");
  const setupStatusEl = document.getElementById("dash-setup-status");

  if (monthKeyEl && m.monthKey) monthKeyEl.textContent = m.monthKey.slice(0, 7);
  if (spendingLimitEl) spendingLimitEl.textContent = m.spending_limit_cents !== null ? formatBRL(m.spending_limit_cents) : "R$ 0,00";
  if (totalSpentEl) totalSpentEl.textContent = formatBRL(m.total_spent_cents || 0);
  if (remainingEl) remainingEl.textContent = m.spending_limit_cents !== null ? formatBRL(m.remaining_cents) : "R$ 0,00";
  if (incomeEl) incomeEl.textContent = formatBRL(m.income_cents || 0);
  if (fixedEl) fixedEl.textContent = formatBRL(m.fixed_cents || 0);
  if (savingsEl) savingsEl.textContent = formatBRL(m.savings_cents || 0);

  if (setupStatusEl) {
    if (m.setup_step) {
      setupStatusEl.textContent = `Configurando: ${m.setup_step}`;
      setupStatusEl.style.background = "rgba(231,123,92,.2)";
      setupStatusEl.style.color = "#a44a30";
    } else if (m.spending_limit_cents !== null) {
      setupStatusEl.textContent = "Orçamento ativo";
      setupStatusEl.style.background = "rgba(132,170,136,.2)";
      setupStatusEl.style.color = "var(--pine)";
    } else {
      setupStatusEl.textContent = "Não configurado";
      setupStatusEl.style.background = "rgba(0,0,0,.06)";
      setupStatusEl.style.color = "#7b837d";
    }
  }

  // Incomes Mini List & Full List
  const incomesContainer = document.getElementById("dash-incomes-container");
  const incomesCountEl = document.getElementById("dash-incomes-count");
  const fullIncomesList = document.getElementById("full-incomes-list");
  const fullIncomesTotal = document.getElementById("full-incomes-total");
  const incomes = data.incomes || [];
  const totalIncomesCents = incomes.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0) || Number(m.income_cents || 0);

  if (incomesCountEl) incomesCountEl.textContent = String(incomes.length);
  if (fullIncomesTotal) fullIncomesTotal.textContent = `Total: ${formatBRL(totalIncomesCents)}`;

  if (incomesContainer) {
    if (!incomes.length && !m.income_cents) {
      incomesContainer.innerHTML = `<p style="margin:0;font-size:11px;color:#899187">Nenhum ganho cadastrado. Use <code>/configurar</code> ou envie <code>recebi 800 alimentação</code>.</p>`;
    } else if (!incomes.length && m.income_cents) {
      incomesContainer.innerHTML = `
        <div style="display:flex;justify-content:space-between;padding:6px 8px;background:#f8f7f2;border-radius:6px;font-size:11px">
          <strong>Renda informada</strong>
          <span style="font-weight:700;color:var(--pine)">${formatBRL(m.income_cents)}</span>
        </div>
      `;
    } else {
      incomesContainer.innerHTML = incomes.slice(0, 5).map((inc) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#f8f7f2;border-radius:6px;font-size:11px;margin-bottom:4px">
          <div>
            <strong style="color:var(--pine)">${inc.source}</strong>
            <small style="display:block;color:#889188;font-size:9px">${formatDate(inc.received_at)}</small>
          </div>
          <span style="font-weight:700;color:var(--pine)">${formatBRL(inc.amount_cents)}</span>
        </div>
      `).join("");
    }
  }

  if (fullIncomesList) {
    if (!incomes.length && !m.income_cents) {
      fullIncomesList.innerHTML = `<p style="font-size:13px;color:#899187">Nenhum ganho ou renda cadastrado ainda neste mês.</p>`;
    } else {
      const listToShow = incomes.length ? incomes : [{ source: "Renda principal", amount_cents: m.income_cents, received_at: m.today }];
      fullIncomesList.innerHTML = `
        <table class="expenses-mini-table" style="font-size:12px">
          <thead>
            <tr>
              <th>Data</th>
              <th>Fonte / Origem</th>
              <th style="text-align:right">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${listToShow.map((inc) => `
              <tr>
                <td>${formatDate(inc.received_at)}</td>
                <td style="font-weight:600;color:var(--pine)">${inc.source}</td>
                <td style="font-weight:700;color:var(--pine);text-align:right">${formatBRL(inc.amount_cents)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }
  }

  // Envelopes Mini List & Full List
  const envList = document.getElementById("dash-envelopes-list");
  const fullEnvList = document.getElementById("full-envelopes-list");
  const envelopes = data.envelopes || [];

  if (envList) {
    if (!envelopes.length) {
      envList.innerHTML = `<p style="margin:0;font-size:11px;color:#899187">Nenhuma caixinha criada. Envie <code>/configurar</code> ou <code>/limite 2500</code> no chat.</p>`;
    } else {
      envList.innerHTML = envelopes.map((env) => `
        <div class="envelope-mini-item">
          <div class="envelope-mini-labels">
            <strong>${env.name}</strong>
            <span>${formatBRL(env.remaining_cents)} restam (${env.percent}%)</span>
          </div>
          <div class="envelope-bar-track">
            <div class="envelope-bar-fill ${env.percent > 90 ? "bar-warning" : ""}" style="width:${Math.min(100, env.percent)}%"></div>
          </div>
        </div>
      `).join("");
    }
  }

  if (fullEnvList) {
    if (!envelopes.length) {
      fullEnvList.innerHTML = `<p style="font-size:13px;color:#899187">Nenhuma caixinha configurada neste mês ainda.</p>`;
    } else {
      fullEnvList.innerHTML = envelopes.map((env) => `
        <div class="dash-kpi" style="text-align:left;padding:14px">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <strong style="text-transform:capitalize;font-size:16px">${env.name}</strong>
            <span style="font-size:13px;font-weight:700;color:var(--pine)">Limite: ${formatBRL(env.limit_cents)}</span>
          </div>
          <div class="envelope-bar-track" style="height:10px;margin-bottom:8px">
            <div class="envelope-bar-fill ${env.percent > 90 ? "bar-warning" : ""}" style="width:${Math.min(100, env.percent)}%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b746c">
            <span>Gasto registrado: ${formatBRL(env.spent_cents)}</span>
            <span style="font-weight:600;color:${env.remaining_cents < 0 ? 'var(--coral)' : 'var(--pine)'}">Restante: ${formatBRL(env.remaining_cents)}</span>
          </div>
        </div>
      `).join("");
    }
  }

  // Recent Expenses
  const expContainer = document.getElementById("dash-expenses-container");
  const fullExpList = document.getElementById("full-expenses-list");
  const expenses = data.recentExpenses || [];

  if (expContainer) {
    if (!expenses.length) {
      expContainer.innerHTML = `<p style="margin:0;font-size:11px;color:#899187">Nenhum gasto anotado ainda. Teste dizendo “gastei 50 almoço” ou “uber 25”.</p>`;
    } else {
      expContainer.innerHTML = `
        <table class="expenses-mini-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Cat.</th>
              <th style="text-align:right">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${expenses.slice(0, 5).map((e) => `
              <tr>
                <td>${formatDate(e.spent_at)}</td>
                <td style="text-transform:capitalize">${e.category}${e.description ? ` <small style="color:#8a938b">(${e.description})</small>` : ""}</td>
                <td style="font-weight:700;color:var(--pine);text-align:right">${formatBRL(e.amount_cents)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }
  }

  if (fullExpList) {
    if (!expenses.length) {
      fullExpList.innerHTML = `<p style="font-size:13px;color:#899187">Nenhuma despesa registrada ainda.</p>`;
    } else {
      fullExpList.innerHTML = `
        <table class="expenses-mini-table" style="font-size:12px">
          <thead>
            <tr>
              <th>Data</th>
              <th>Categoria</th>
              <th>Descrição</th>
              <th style="text-align:right">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${expenses.map((e) => `
              <tr>
                <td>${formatDate(e.spent_at)}</td>
                <td style="font-weight:600;text-transform:capitalize">${e.category}</td>
                <td style="color:#687269">${e.description || "—"}</td>
                <td style="font-weight:700;color:var(--pine);text-align:right">${formatBRL(e.amount_cents)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }
  }

  // Goals
  const goalsContainer = document.getElementById("dash-goals-container");
  const goals = data.goals || [];

  if (goalsContainer) {
    if (!goals.length) {
      goalsContainer.innerHTML = `<p style="margin:0;font-size:11px;color:#899187">Nenhuma meta criada. Crie uma com <code>/meta Viagem 1200 2026-12-20</code>.</p>`;
    } else {
      goalsContainer.innerHTML = goals.map((g) => {
        const target = Number(g.target_cents || 0);
        const saved = Number(g.saved_cents || 0);
        const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
        return `
          <div style="margin-bottom:10px;padding:8px 10px;background:#fbfaf6;border-radius:10px;border:1px solid #ebe8dc">
            <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:var(--pine);margin-bottom:4px">
              <span>${g.name}</span>
              <span>${formatBRL(saved)} / ${formatBRL(target)} (${pct}%)</span>
            </div>
            <div class="envelope-bar-track" style="height:6px">
              <div class="envelope-bar-fill" style="width:${pct}%;background:var(--coral)"></div>
            </div>
            <div style="font-size:9px;color:#7e8780;margin-top:4px">Até ${formatDate(g.due_date)}</div>
          </div>
        `;
      }).join("");
    }
  }
}

// Webhook diagnostics buttons
const btnTestHealth = document.getElementById("btn-test-health");
const btnTestTelegramGet = document.getElementById("btn-test-telegram-get");
const endpointResult = document.getElementById("endpoint-test-result");

if (btnTestHealth && endpointResult) {
  btnTestHealth.addEventListener("click", async () => {
    endpointResult.textContent = "Testando GET /api/health...";
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      endpointResult.textContent = `HTTP ${res.status}\n` + JSON.stringify(data, null, 2);
    } catch (err) {
      endpointResult.textContent = "Erro na requisição: " + err.message;
    }
  });
}

if (btnTestTelegramGet && endpointResult) {
  btnTestTelegramGet.addEventListener("click", async () => {
    endpointResult.textContent = "Testando GET /api/telegram...";
    try {
      const res = await fetch("/api/telegram");
      const data = await res.json();
      endpointResult.textContent = `HTTP ${res.status}\n` + JSON.stringify(data, null, 2);
    } catch (err) {
      endpointResult.textContent = "Erro na requisição: " + err.message;
    }
  });
}

// Initial fetch
fetchBotState();
const yearEl = document.querySelector("#year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
