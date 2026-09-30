const fs = require("node:fs");
const path = require("node:path");

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadLocalEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!token || !secret || !baseUrl) {
    console.error("Configure TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET e PUBLIC_BASE_URL em .env.local antes de executar.");
    process.exitCode = 1;
    return;
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    console.error("PUBLIC_BASE_URL precisa começar com https://.");
    process.exitCode = 1;
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    console.error("TELEGRAM_WEBHOOK_SECRET deve conter de 1 a 256 caracteres: letras, números, _ ou -.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${baseUrl}/api/telegram`,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error(`Telegram não confirmou o webhook (HTTP ${response.status}). Confira a URL e o token sem compartilhá-los.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Webhook configurado para ${baseUrl}/api/telegram. O token não foi exibido.`);
}

main().catch((error) => {
  console.error("Não foi possível configurar o webhook:", error?.name || "Error");
  process.exitCode = 1;
});
