// Проверка ассистента с настоящим DeepSeek на тестовой базе (запускается в GitHub Actions, ai-check.yml).
// Прогоняет несколько типичных сообщений через того же бота, что работает в Telegram,
// и записывает ответы и получившиеся задачи. Пароли и ключи в вывод не попадают.

import http from "node:http";
import { createApp } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

const env = process.env;
const cfg = readConfig({ ...env, ADMIN_PASSWORD: "smoke-pass", BRIDGE_SECRET: "smoke-bridge" });
const db = await openDb({ host: env.TEST_DB_HOST || "127.0.0.1", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD, database: env.TEST_DB_NAME });
const app = createApp(cfg, { dbOverride: db });
const { nodes } = await app.services();
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const project = await nodes.create({ kind: "project", title: "SalesFox" }, "system");
await nodes.create({ kind: "task", title: "Отправить договор юристу", parent_id: project.id, due: "2026-01-10" }, "system");

let id = 1;
async function say(text) {
  const started = Date.now();
  const res = await fetch(`${base}/api/bridge/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": "smoke-bridge" },
    body: JSON.stringify({ update_id: id++, message: { message_id: id, text, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Проверка" } } }),
  });
  const data = await res.json();
  const answer = (data.actions || []).filter((a) => a.method === "sendMessage").map((a) => a.fallback_text).join("\n");
  const shown = text.startsWith("/start") ? "/start ***" : text;
  console.log(`\n>>> ${shown}\n(${((Date.now() - started) / 1000).toFixed(1)} с, HTTP ${res.status})\n${answer || JSON.stringify(data)}`);
}

console.log(`Модели: обычная ${cfg.deepseek.model}, умная ${cfg.deepseek.smartModel}`);
await say("/start smoke-pass");
await say("завтра в 11 созвон с Петром по SalesFox, до пятницы подготовить смету для Альфа-Строй, и купить корм коту");
await say("что у меня на завтра?");
await say("созвон с Петром перенеси на понедельник 15:00 и сделай важным");
await say("договор юристу я отправил");
await say("/plan");

// --- задания Киры ---
await say("напомни мне завтра в 9 утра позвонить в банк");
await say("каждую пятницу в 18:00 присылай мне итоги недели по SalesFox: что сделано, что зависло");
await say("через 2 дня проверь, сдвинулась ли смета для Альфа-Строй, и если нет — напиши мне");
await say("какие у тебя сейчас задания?");
await say("отмени напоминание про банк");

const svc = await app.services();
const weekly = (await svc.jobs.list({ status: "active" })).find((j) => /итог/i.test(j.title));
if (weekly) {
  console.log(`\n=== Запускаю задание #${weekly.id} «${weekly.title}» вручную — Кира выполняет сама`);
  const r = await svc.runner.runNow(weekly.id);
  console.log(`статус: ${r.status}\nитог для журнала: ${r.result}`);
  const sent = await db.query("SELECT text FROM outbox ORDER BY id DESC LIMIT 1");
  console.log(`сообщение владельцу:\n${sent[0]?.text || "(не отправлено)"}`);
} else {
  console.log("\n!!! Еженедельное задание не создано");
}

console.log("\n=== Задания после разговора");
for (const j of await svc.jobs.list({})) {
  console.log(`#${j.id} [${j.status}/${j.exec_status}] ${j.title} — ${j.action}, ${j.schedule_text}${j.next_run ? ", дальше " + j.next_run : ""}; кем: ${j.created_by}${j.links.length ? "; связи: " + j.links.map((l) => l.title).join(", ") : ""}`);
}

console.log("\n=== Задачи в базе после разговора");
for (const t of await nodes.list({ kind: "task", include_deleted: true, order: "created" })) {
  console.log(`#${t.id} [${t.status}] ${t.title}${t.due ? " — " + t.due : ""}${t.priority ? " !" + t.priority : ""}${t.parent_id ? " (в #" + t.parent_id + ")" : ""}`);
}
const [usage] = await db.query("SELECT meta FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1");
console.log("\nПоследний ответ, токены:", JSON.parse(usage.meta).usage);
server.close();
await db.close();
