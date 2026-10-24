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
  const shown = text === "smoke-pass" ? "*** (пароль)" : text;
  console.log(`\n>>> ${shown}\n(${((Date.now() - started) / 1000).toFixed(1)} с, HTTP ${res.status})\n${answer || JSON.stringify(data)}`);
}

console.log(`Модели: обычная ${cfg.deepseek.model}, умная ${cfg.deepseek.smartModel}`);
await say("/start");
await say("smoke-pass");

// --- интернет ---
console.log(`\n=== Поиск в интернете: сервисы по порядку — ${(await import("../src/ai/web.js")).webProviders(cfg.web).join(", ")}`);
for (const q of ["Что Глоубайт сделали для ТБанк", "какие главные новости про Т-Банк за последнюю неделю?"]) {
  await say(q);
  const [m] = await db.query("SELECT meta FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1");
  const meta = JSON.parse(m?.meta || "{}");
  console.log("инструменты:", (meta.tools || []).map((t) => `${t.tool}${t.args?.query ? `(«${t.args.query}»)` : t.args?.url ? `(${t.args.url})` : ""}${t.ok ? "" : " ✗ " + t.error}`).join(", "), "| токены:", meta.usage);
}
// --- тон по контексту ---
await say("короче я спросил у ChatGPT, как лучше составить смету, он норм подсказал");
await say("смету для Альфа-Строй перенеси на понедельник, опять не успеваю");
await say("Альфа-Строй отказались от пилота, минус два миллиона в плане на квартал");
if (env.SMOKE === "web") { server.close(); await db.close(); process.exit(0); }
await say("завтра в 11 созвон с Петром по SalesFox, до пятницы подготовить смету для Альфа-Строй, и купить корм коту");
await say("что у меня на завтра?");
await say("созвон с Петром перенеси на понедельник 15:00 и сделай важным");
await say("договор юристу я отправил");
await say("составь мне план на сегодня");
await say("присылай утренний план в 7:30");
await say("давай начнём разговор с чистого листа");

// --- система управления: треки, проекты, миссии, риски, действия, блокеры ---
await say("заведи трек «Развитие SalesFox», а в нём проект «Пилот с Альфа-Строй» со стадиями: подготовка, выход на ЛПР, пилот, договор. Сейчас идёт подготовка. Финальная цель — подписанный договор на пилот к 20 декабря, промежуточная — первая встреча с гендиректором");
await say("заведи миссию в этом проекте: выйти и установить контакт с гендиректором Альфа-Строй Иваном Петровым, он ЛПР");
await say("риск по миссии: гендиректор не выйдет на разговор без рекомендации. Я оцениваю вероятность 4, влияние 5");
await say("сегодня в 15:00 позвонил в приёмную Альфа-Строй, секретарь дала только общую почту");
await say("мешает: нет прямого телефона гендиректора, ждём, когда Пётр Сидоров даст контакт");
await say("что у нас по миссии с гендиректором?");

{
  const svc0 = await app.services();
  const n = await svc0.riskAi.runPending();
  console.log(`\n=== Кира оценила рисков: ${n}`);
  for (const r of await svc0.nodes.list({ kind: "risk" })) {
    console.log(`«${r.title}»: моя ${r.fields.probability}×${r.fields.impact}, Киры ${r.fields.ai_probability}×${r.fields.ai_impact} — ${r.fields.ai_comment}`);
  }
  console.log("\n=== Структура");
  const all = await svc0.nodes.list({ kinds: ["track", "project", "mission", "stage", "goal", "task", "risk", "blocker", "action", "memo", "person"], limit: 500, order: "created" });
  for (const o of all.filter((x) => !["task"].includes(x.kind) || x.parent_id)) {
    console.log(`#${o.id} ${o.kind} [${o.status}] ${o.title}${o.parent_id ? ` (в #${o.parent_id})` : ""}${o.due ? ` срок ${o.due}` : ""}${o.event_at && o.kind === "action" ? ` когда ${o.event_at}` : ""}${Object.keys(o.fields || {}).length ? " " + JSON.stringify(o.fields) : ""}`);
  }
  const m = all.find((x) => x.kind === "mission");
  if (m) console.log("люди миссии:", (await svc0.nodes.linksOf(m.id)).map((l) => `${l.title} — ${l.role}`).join("; "));
}

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
