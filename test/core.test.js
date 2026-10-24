// Тесты ядра на настоящей MySQL/MariaDB. Нужна пустая тестовая база:
//   TEST_DB_HOST, TEST_DB_USER, TEST_DB_PASSWORD, TEST_DB_NAME
// Без них тесты пропускаются. ИИ здесь поддельный — проверяем логику, а не модель.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { formatAgenda } from "../src/bot.js";
import { parseLocal, formatLocal, localNow, addDays } from "../src/time.js";
import { toHtml, splitText } from "../src/telegram.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
const TZ = "Europe/Moscow";

let db, app, server, base, cookie;
const cfg = {
  tz: TZ, morningTime: "08:30", assistantName: "Кира",
  adminPassword: "секрет-123", bridgeSecret: "bridge-xyz",
  deepseek: {}, db: {},
};

// Поддельная модель: по очереди отдаёт заранее заданные ответы и запоминает, что ей прислали
const script = [];
const seen = [];
const fakeLlm = {
  smartModel: "smart",
  async chat({ messages, model }) {
    seen.push({ messages, model });
    const next = script.shift();
    if (!next) return { message: { role: "assistant", content: "ок" } };
    return { message: typeof next === "function" ? next(messages) : next, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  },
};
const toolCall = (name, args, id = "c" + Math.random()) => ({
  role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const bridge = (method, path, body) => call(method, path, body, { "X-Bridge-Secret": cfg.bridgeSecret });

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  const tables = await db.query("SHOW TABLES");
  for (const t of tables) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  app = createApp(cfg, { llm: fakeLlm, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test("время: местная дата ↔ UTC", () => {
  const d = parseLocal("2026-10-25 14:30", TZ);
  assert.equal(d.utc.toISOString(), "2026-10-25T11:30:00.000Z");
  assert.equal(formatLocal(d.utc, TZ), "2026-10-25 14:30");
  const day = parseLocal("2026-10-25", TZ);
  assert.equal(day.hasTime, false);
  assert.equal(formatLocal(day.utc, TZ, false), "2026-10-25");
  assert.equal(parseLocal("завтра", TZ), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.match(localNow(TZ).date, /^\d{4}-\d{2}-\d{2}$/);
});

test("telegram: разметка и разбиение", () => {
  assert.equal(toHtml("*важно* и <тег> & `код`"), "<b>важно</b> и &lt;тег&gt; &amp; <code>код</code>");
  assert.equal(toHtml("2*3*4"), "2*3*4");
  const parts = splitText("абв ".repeat(3000));
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3800));
});

test("вход на сайт и защита API", { skip: !haveDb }, async () => {
  assert.equal((await call("GET", "/api/items")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "не тот" })).status, 401);
  const ok = await call("POST", "/api/login", { password: cfg.adminPassword });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("GET", "/api/items")).status, 200);
  assert.equal((await call("GET", "/api/health")).data.db, true);
});

test("записи: проект, задача, история, мягкое удаление", { skip: !haveDb }, async () => {
  const p = (await call("POST", "/api/items", { kind: "project", title: "SalesFox" })).data.item;
  const t = (await call("POST", "/api/items", { kind: "task", title: "Созвон", parent_id: p.id, due: "2026-11-02 10:00" })).data.item;
  assert.equal(t.due, "2026-11-02 10:00");
  assert.equal((await call("POST", "/api/items", { kind: "task", title: "" })).status, 400);
  assert.equal((await call("POST", "/api/items", { kind: "task", title: "x", status: "active" })).status, 400);
  const done = (await call("PATCH", `/api/items/${t.id}`, { status: "done" })).data.item;
  assert.equal(done.closed, true);
  assert.ok(done.completed);
  const h = (await call("GET", `/api/items/${t.id}/history`)).data.history;
  assert.deepEqual(h.map((x) => x.action), ["update", "create"]);
  assert.deepEqual(h[0].changes.status, ["todo", "done"]);
  const full = (await call("GET", `/api/items/${p.id}`)).data.item;
  assert.equal(full.children.length, 1);
  assert.equal((await call("PATCH", `/api/items/${p.id}`, { parent_id: t.id })).status, 400); // цикл
  await call("DELETE", `/api/items/${p.id}`);
  assert.equal((await call("GET", "/api/items?kind=task")).data.items.length, 0);
  await call("POST", `/api/items/${p.id}/restore`);
  assert.equal((await call("GET", "/api/items?kind=project")).data.items.length, 1);
});

test("мост: без ключа нельзя", { skip: !haveDb }, async () => {
  assert.equal((await call("POST", "/api/bridge/update", { update_id: 1 })).status, 403);
  assert.equal((await call("GET", "/api/bridge/outbox", undefined, { "X-Bridge-Secret": "wrong" })).status, 403);
});

const msg = (id, text, from = 111) => ({
  update_id: id,
  message: { message_id: id * 10, text, chat: { id: from, type: "private" }, from: { id: from, first_name: "Тест" } },
});

test("бот: привязка владельца и чужие", { skip: !haveDb }, async () => {
  let r = await bridge("POST", "/api/bridge/update", msg(100, "привет", 222));
  assert.match(r.data.actions[0]?.params.text || "", /Это личный бот/); // владельца ещё нет — подсказываем
  r = await bridge("POST", "/api/bridge/update", msg(101, "/start неверно", 222));
  assert.equal(r.data.actions[0].method, "deleteMessage");
  assert.match(r.data.actions[1].params.text, /не подошёл/);
  r = await bridge("POST", "/api/bridge/update", msg(102, `/start ${cfg.adminPassword}`, 111));
  assert.equal(r.data.actions[0].method, "deleteMessage");
  assert.match(r.data.actions[1].params.text, /твоя/);
  r = await bridge("POST", "/api/bridge/update", msg(103, "привет", 222));
  assert.deepEqual(r.data.actions, []); // чужим молчим
  r = await bridge("POST", "/api/bridge/update", msg(102, `/start ${cfg.adminPassword}`, 111));
  assert.deepEqual(r.data.actions, []); // повтор того же апдейта не обрабатывается
  const owner = (await call("GET", "/api/bot")).data.owner;
  assert.equal(owner.name, "Тест");
});

test("бот: ассистент создаёт задачу через инструмент", { skip: !haveDb }, async () => {
  script.push(
    toolCall("create_item", { kind: "task", title: "Купить подарок маме", due: "2026-11-05", priority: 2 }),
    (messages) => {
      const last = JSON.parse(messages.at(-1).content);
      return { role: "assistant", content: `Создала: *${last.created.title}* на ${last.created.due}` };
    },
  );
  const r = await bridge("POST", "/api/bridge/update", msg(200, "надо купить подарок маме до 5 ноября"));
  assert.match(r.data.actions[0].params.text, /<b>Купить подарок маме<\/b> на 2026-11-05/);
  const tasks = (await call("GET", "/api/items?kind=task&q=подарок")).data.items;
  assert.equal(tasks.length, 1);
  const h = (await call("GET", `/api/items/${tasks[0].id}/history`)).data.history;
  assert.equal(h[0].source, "bot");
  // Во втором сообщении модель видит историю разговора
  script.push({ role: "assistant", content: "Помню." });
  await bridge("POST", "/api/bridge/update", msg(201, "что я только что просил?"));
  const ctx = seen.at(-1).messages;
  assert.equal(ctx[0].role, "system");
  assert.ok(ctx.some((m) => m.role === "user" && /подарок маме/.test(m.content)));
  // /new — забывает разговор
  await bridge("POST", "/api/bridge/update", msg(202, "/new"));
  script.push({ role: "assistant", content: "Чисто." });
  await bridge("POST", "/api/bridge/update", msg(203, "ну что"));
  assert.ok(!seen.at(-1).messages.some((m) => /подарок маме/.test(m.content || "") && m.role === "user"));
});

test("бот: ошибки инструментов доходят до модели, неизвестные команды не ломают", { skip: !haveDb }, async () => {
  script.push(toolCall("update_item", { id: 99999, status: "done" }), (messages) => {
    const last = JSON.parse(messages.at(-1).content);
    return { role: "assistant", content: `Ошибка: ${last.error}` };
  });
  const r = await bridge("POST", "/api/bridge/update", msg(300, "закрой задачу 99999"));
  assert.match(r.data.actions[0].params.text, /Нет записи #99999/);
  const t = await bridge("POST", "/api/bridge/update", msg(301, "/today"));
  assert.match(t.data.actions[0].params.text, /Скоро|Сегодня|ничего|Важное|Просрочено/);
});

test("утренний план: один раз в день через очередь", { skip: !haveDb }, async () => {
  const now = localNow(TZ);
  await db.set("morning_time", now.time); // «сейчас» — время утреннего плана
  script.push({ role: "assistant", content: "План: 1. Подарок маме" });
  let r = await bridge("GET", "/api/bridge/outbox");
  assert.equal(r.data.items.length, 1);
  assert.match(r.data.items[0].actions[0].params.text, /План/);
  assert.equal(r.data.items[0].actions[0].params.chat_id, 111);
  assert.equal(seen.at(-1).model, "smart");
  r = await bridge("GET", "/api/bridge/outbox");
  assert.equal(r.data.items.length, 1); // пока не подтверждено — отдаётся снова, но второй раз не генерируется
  await bridge("POST", "/api/bridge/ack", { ids: [r.data.items[0].id] });
  r = await bridge("GET", "/api/bridge/outbox");
  assert.equal(r.data.items.length, 0);
});

test("сводка дня текстом", () => {
  const text = formatAgenda({
    overdue: [{ title: "Старое", due: "2026-10-20", priority: 3 }], today_tasks: [{ title: "Звонок", due: "2026-10-24 15:00" }],
    upcoming: [], important_no_date: [], in_progress: [],
  });
  assert.match(text, /Просрочено \(1\)/);
  assert.match(text, /Звонок — 15:00/);
});

test("статика: код и .env не отдаются", { skip: !haveDb }, async () => {
  for (const p of ["/../.env", "/%2e%2e/.env", "/../src/server.js", "/.env"]) {
    const r = await fetch(base + p);
    const text = await r.text();
    assert.ok(!/BRIDGE|import http/.test(text), p);
  }
});
