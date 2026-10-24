// Настройки: переменные окружения, плюс файл .env рядом с app.js (его пишет выкладка).
// Понимает и наши имена переменных базы (DB_HOST), и те, что задаёт панель Masterhost (DBHOST).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = path.join(ROOT, ".env"), env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function readConfig(env = process.env) {
  const pick = (...names) => names.map((n) => env[n]).find((v) => v !== undefined && v !== "");
  return {
    port: +(env.PORT || 3000),
    db: {
      host: pick("DB_HOST", "DBHOST") || "localhost",
      port: +(pick("DB_PORT", "DBPORT") || 3306),
      user: pick("DB_USER", "DBUSER"),
      password: pick("DB_PASSWORD", "DBPASS", "DBPASSWORD") || "",
      database: pick("DB_NAME", "DBNAME"),
    },
    adminPassword: env.ADMIN_PASSWORD || "",
    bridgeSecret: env.BRIDGE_SECRET || "",
    deepseek: {
      key: env.DEEPSEEK_API_KEY || "",
      url: env.DEEPSEEK_URL || "https://api.deepseek.com",
      model: env.DEEPSEEK_MODEL || "deepseek-flash",
      smartModel: env.DEEPSEEK_SMART_MODEL || "deepseek-v4-pro",
    },
    tz: env.APP_TZ || "Europe/Moscow",
    morningTime: env.MORNING_TIME || "08:30",
    assistantName: env.ASSISTANT_NAME || "Кира",
    filesDir: env.FILES_DIR || "",
    web: {
      provider: env.WEB_SEARCH_PROVIDER || "",
      yandexKey: env.YANDEX_SEARCH_API_KEY || "",
      yandexFolder: env.YANDEX_FOLDER_ID || "",
      tavilyKey: env.TAVILY_API_KEY || "",
      braveKey: env.BRAVE_API_KEY || "",
      serperKey: env.SERPER_API_KEY || "",
    },
  };
}
