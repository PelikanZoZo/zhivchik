// Тесты системы управления: треки, проекты, миссии, стадии, цели, риски с оценкой ИИ, блокеры,
// действия, люди и роли, комментарии, вложения-файлы, инструменты Киры.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
let db, app, server, base, cookie;
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "kira-files-"));
const cfg = {
  tz: "Europe/Moscow", morningTime: "08:30", assistantName: "Кира",
  adminPassword: "pm-pass", bridgeSecret: "pm-bridge", deepseek: {}, db: {}, filesDir,
};

const script = [];
const seen = [];
const fakeLlm = {
  smartModel: "smart",
  async chat(req) {
    seen.push(req);
    const next = script.shift();
    if (!next) return { message: { role: "assistant", content: "ок" } };
    return { message: typeof next === "function" ? next(req.messages, req) : next };
  },
};
const toolCall = (name, args) => ({
  role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

async function call(method, p, body, headers = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(base + p, {
    method,
    headers: { ...(raw ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}
const mk = async (body) => {
  const r = await call("POST", "/api/items", body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.item;
};

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  app = createApp(cfg, { llm: fakeLlm, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call("POST", "/api/login", { password: cfg.adminPassword });
  cookie = r.res.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) server.close();
  if (db) await db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

let track, project, mission, stage1, stage2, task, person;

test("структура: трек → проект → стадии, миссия, цели; правила вложенности", { skip: !haveDb }, async () => {
  track = await mk({ kind: "track", title: "Развитие SalesFox" });
  project = await mk({ kind: "project", title: "Пилот с Альфа-Строй", parent_id: track.id, due: "2026-12-20" });
  stage1 = await mk({ kind: "stage", title: "Выход на ЛПР", parent_id: project.id, status: "active", position: 1 });
  stage2 = await mk({ kind: "stage", title: "Пилот", parent_id: project.id, position: 2 });
  mission = await mk({ kind: "mission", title: "Установить контакт с гендиректором Альфа-Строй", parent_id: project.id, stage_id: stage1.id });
  assert.equal(mission.status, "preparing");
  assert.equal(mission.status_label, "Подготовка");
  const m1 = await mk({ kind: "goal", title: "Первая встреча", parent_id: project.id, fields: { goal_type: "milestone" }, due: "2026-11-15" });
  const fin = await mk({ kind: "goal", title: "Подписан договор на пилот", parent_id: project.id, fields: { goal_type: "final", target: 1, unit: "договор" } });
  assert.equal(m1.fields.goal_type, "milestone");
  assert.equal(fin.due, null); // у цели может не быть дедлайна
  assert.equal(fin.fields.target, 1);
  const bad = [
    [{ kind: "stage", title: "x" }, /должна быть внутри/],
    [{ kind: "project", title: "x", parent_id: mission.id }, /нельзя положить в «Миссия»/],
    [{ kind: "track", title: "x", parent_id: project.id }, /нельзя положить/],
    [{ kind: "goal", title: "x", parent_id: project.id, fields: { goal_type: "big" } }, /milestone или final/],
    [{ kind: "risk", title: "x", parent_id: project.id, fields: { probability: 7 } }, /от 1 до 5/],
    [{ kind: "task", title: "x", parent_id: mission.id, stage_id: 999999 }, /Нет стадии/],
    [{ kind: "widget", title: "x" }, /Неизвестный вид/],
  ];
  for (const [body, re] of bad) {
    const r = await call("POST", "/api/items", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
  // стадия другого проекта не подходит
  const other = await mk({ kind: "project", title: "Другой" });
  const otherStage = await mk({ kind: "stage", title: "Чужая", parent_id: other.id });
  assert.match((await call("POST", "/api/items", { kind: "task", title: "x", parent_id: mission.id, stage_id: otherStage.id })).data.error, /другого проекта/);
  // текущая стадия одна
  await call("PATCH", `/api/items/${stage2.id}`, { status: "active" });
  assert.equal((await call("GET", `/api/items/${stage1.id}`)).data.item.status, "done");
});

test("задачи, подзадачи, блокер блокирует задачу, действие в журнал", { skip: !haveDb }, async () => {
  task = await mk({ kind: "task", title: "Собрать информацию о компании", parent_id: mission.id, due: "2026-11-01" });
  const sub = await mk({ kind: "task", title: "Выручка за 3 года", parent_id: task.id });
  assert.equal((await call("POST", "/api/items", { kind: "task", title: "x", parent_id: sub.id })).status, 400); // один уровень
  const blocker = await mk({ kind: "blocker", title: "Нет прямого телефона", parent_id: mission.id, fields: { waiting_for: "Пётр даст контакт" } });
  assert.ok(blocker.event_at); // «с какого числа» — по умолчанию сейчас
  await call("POST", `/api/items/${blocker.id}/links`, { other_id: task.id, role: "blocks" });
  let t = (await call("GET", `/api/items/${task.id}`)).data.item;
  assert.deepEqual(t.blocked_by.map((b) => b.title), ["Нет прямого телефона"]);
  assert.equal(t.home.title, "Установить контакт с гендиректором Альфа-Строй");
  await call("PATCH", `/api/items/${blocker.id}`, { status: "resolved" });
  t = (await call("GET", `/api/items/${task.id}`)).data.item;
  assert.equal(t.blocked_by.length, 0);
  const act = await mk({ kind: "action", title: "Позвонил в приёмную", parent_id: mission.id, event_at: "2026-10-24 15:00", fields: { result: "Секретарь дала почту" } });
  assert.equal(act.event_at, "2026-10-24 15:00");
  assert.equal(act.fields.result, "Секретарь дала почту");
  const ag = (await call("GET", "/api/agenda")).data;
  for (const k of ["goals_due", "blockers", "high_risks", "missions"]) assert.ok(Array.isArray(ag[k]), k);
  assert.ok(ag.missions.some((m) => m.id === mission.id));
});

test("люди: справочник, роли в объектах, один человек в нескольких местах", { skip: !haveDb }, async () => {
  person = await mk({ kind: "person", title: "Иван Петров", fields: { company: "Альфа-Строй", position: "Генеральный директор", phone: "+7 900 000-00-00" } });
  assert.equal((await call("POST", "/api/items", { kind: "person", title: "x", parent_id: project.id })).status, 400);
  await call("POST", `/api/items/${mission.id}/links`, { other_id: person.id, role: "ЛПР" });
  await call("POST", `/api/items/${person.id}/links`, { other_id: project.id, role: "ЛПР" }); // порядок не важен
  const again = await call("POST", `/api/items/${mission.id}/links`, { other_id: person.id, role: "ЛПР" });
  assert.equal(again.data.existed, true);
  const m = (await call("GET", `/api/items/${mission.id}`)).data.item;
  const l = m.links.find((x) => x.kind === "person");
  assert.equal(l.role, "ЛПР");
  assert.equal(l.fields.company, "Альфа-Строй");
  const p = (await call("GET", `/api/items/${person.id}`)).data.item;
  assert.deepEqual(p.links.map((x) => x.title).sort(), ["Пилот с Альфа-Строй", "Установить контакт с гендиректором Альфа-Строй"]);
  await call("DELETE", `/api/links/${l.link_id}`);
  assert.equal((await call("GET", `/api/items/${mission.id}`)).data.item.links.filter((x) => x.kind === "person").length, 0);
  const h = (await call("GET", `/api/items/${mission.id}/history`)).data.history;
  assert.ok(h.some((x) => x.action === "link") && h.some((x) => x.action === "unlink"));
});

test("комментарии", { skip: !haveDb }, async () => {
  await call("POST", `/api/items/${mission.id}/comments`, { text: "Заходить через Петра" });
  assert.equal((await call("POST", `/api/items/${mission.id}/comments`, { text: "  " })).status, 400);
  const m = (await call("GET", `/api/items/${mission.id}`)).data.item;
  assert.deepEqual(m.comments.map((c) => [c.author, c.text]), [["owner", "Заходить через Петра"]]);
  await call("DELETE", `/api/comments/${m.comments[0].id}`);
  assert.equal((await call("GET", `/api/items/${mission.id}`)).data.item.comments.length, 0);
});

test("вложения: файл и ссылка; файл отдаётся только после входа", { skip: !haveDb }, async () => {
  const content = Buffer.from("Отчёт о компании Альфа-Строй\n");
  const up = await call("POST", `/api/items/${mission.id}/upload`, content, { "X-File-Name": encodeURIComponent("справка.txt"), "Content-Type": "text/plain" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const att = up.data.item;
  assert.equal(att.kind, "attachment");
  assert.equal(att.fields.file_name, "справка.txt");
  assert.equal(att.fields.file_size, content.length);
  const dl = await call("GET", `/api/files/${att.id}`);
  assert.equal(dl.data, content.toString());
  assert.match(dl.res.headers.get("content-disposition"), /attachment; filename\*=UTF-8''/);
  const saved = cookie; cookie = null;
  assert.equal((await call("GET", `/api/files/${att.id}`)).status, 401);
  cookie = saved;
  // системные поля файла правкой не подменить
  await call("PATCH", `/api/items/${att.id}`, { fields: { file_key: "../../etc/passwd" } });
  assert.equal((await call("GET", `/api/files/${att.id}`)).data, content.toString());
  const link = await mk({ kind: "attachment", title: "Сайт компании", parent_id: mission.id, fields: { url: "https://alfa.example" } });
  assert.equal(link.fields.url, "https://alfa.example");
});

test("риск: оценка владельца и ИИ раздельно, ИИ оценивает новый и изменённый риск", { skip: !haveDb }, async () => {
  const risk = await mk({ kind: "risk", title: "Гендиректор не выйдет на связь", parent_id: mission.id, fields: { probability: 4, impact: 5, ai_probability: 1 } });
  assert.equal(risk.fields.ai_probability, undefined); // оценку ИИ руками не поставить
  assert.deepEqual(risk.risk, { mine: 20, ai: null, level: "high" });
  script.push((messages, req) => {
    assert.ok(req.json);
    assert.match(messages[1].content, /Оценка владельца: вероятность 4, влияние 5/);
    assert.match(messages[1].content, /Установить контакт с гендиректором/);
    return { role: "assistant", content: '{"probability": 3, "impact": 5, "comment": "Есть выход через Петра, вероятность ниже."}' };
  });
  await call("GET", "/api/bridge/outbox", undefined, { "X-Bridge-Secret": cfg.bridgeSecret });
  let r = (await call("GET", `/api/items/${risk.id}`)).data.item;
  assert.equal(r.fields.ai_probability, 3);
  assert.equal(r.fields.ai_impact, 5);
  assert.match(r.fields.ai_comment, /через Петра/);
  assert.deepEqual(r.risk, { mine: 20, ai: 15, level: "high" });
  // повторно не оценивает, пока риск не изменился
  const before = seen.length;
  await call("GET", "/api/bridge/outbox", undefined, { "X-Bridge-Secret": cfg.bridgeSecret });
  assert.equal(seen.length, before);
  // владелец поменял оценку — ИИ переоценивает
  await call("PATCH", `/api/items/${risk.id}`, { fields: { probability: 2 } });
  script.push({ role: "assistant", content: '{"probability": 2, "impact": 4, "comment": "Согласна."}' });
  await call("GET", "/api/bridge/outbox", undefined, { "X-Bridge-Secret": cfg.bridgeSecret });
  r = (await call("GET", `/api/items/${risk.id}`)).data.item;
  assert.equal(r.fields.probability, 2);
  assert.equal(r.fields.ai_impact, 4);
  const h = (await call("GET", `/api/items/${risk.id}/history`)).data.history;
  assert.ok(h.some((x) => x.source === "kira" && x.changes?.["fields.ai_probability"]));
});

test("Кира: журнал действия с людьми и закрытием задачи, человек с ролью, блокер", { skip: !haveDb }, async () => {
  await call("POST", "/api/bridge/update", { update_id: 1, message: { message_id: 1, text: cfg.adminPassword, chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Я" } } }, { "X-Bridge-Secret": cfg.bridgeSecret });
  script.push(
    (messages) => {
      assert.match(messages[0].content, /Модель системы/);
      assert.match(messages[0].content, /mission — Миссия/);
      assert.match(messages[0].content, new RegExp(`Миссии: #${mission.id} Установить контакт`));
      return toolCall("log_action", { parent_id: task.id, title: "Нашёл отчётность", result: "Выручка растёт 20% в год", people: ["Пётр Сидоров"], close_task: true });
    },
    toolCall("link_person", { item_id: mission.id, name: "Пётр Сидоров", role: "контакт", company: "Партнёр" }),
    toolCall("create_item", { kind: "blocker", title: "Ждём ответ секретаря", parent_id: mission.id, fields: { waiting_for: "секретарь" } }),
    { role: "assistant", content: "Записала." },
  );
  const r = await call("POST", "/api/bridge/update", { update_id: 2, message: { message_id: 2, text: "нашёл отчётность, выручка растёт, Пётр помог", chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Я" } } }, { "X-Bridge-Secret": cfg.bridgeSecret });
  assert.equal(r.data.actions[0].params.text, "Записала.");
  const t = (await call("GET", `/api/items/${task.id}`)).data.item;
  assert.equal(t.status, "done");
  const act = t.children.find((c) => c.kind === "action");
  assert.equal(act.fields.result, "Выручка растёт 20% в год");
  const actFull = (await call("GET", `/api/items/${act.id}`)).data.item;
  assert.deepEqual(actFull.links.map((l) => [l.title, l.role]), [["Пётр Сидоров", "участник"]]);
  const people = (await call("GET", "/api/items?kind=person")).data.items.filter((p) => p.title === "Пётр Сидоров");
  assert.equal(people.length, 1); // второй раз не заведён — нашёлся
  const m = (await call("GET", `/api/items/${mission.id}`)).data.item;
  assert.ok(m.links.some((l) => l.title === "Пётр Сидоров" && l.role === "контакт"));
  assert.ok(m.children.some((c) => c.kind === "blocker" && c.title === "Ждём ответ секретаря"));
});

test("миграция: старые заметки стали памятками, цели — в новых статусах", { skip: !haveDb }, async () => {
  // имитируем запись, созданную до новой модели
  await db.query("INSERT INTO nodes (kind, title, status, created_at, updated_at) VALUES ('note', 'старая заметка', 'active', NOW(3), NOW(3))");
  await db.query("UPDATE schema_version SET version = 2");
  await db.query("ALTER TABLE nodes DROP COLUMN stage_id, DROP COLUMN event_at");
  await db.query("DROP TABLE node_links, node_comments");
  await db.migrate();
  const memo = (await call("GET", "/api/items?kind=memo&q=старая")).data.items;
  assert.equal(memo.length, 1);
});

test("миграция: данные удалённой контактной книжки стёрты, в том числе из истории", { skip: !haveDb }, async () => {
  const meta = JSON.stringify({ company: "Альфа", loyalty: 5, relation: "Старый друг", ai_summary: "друг", ai_influence: 4 });
  const r = await db.query("INSERT INTO nodes (kind, title, status, meta, created_at, updated_at) VALUES ('person', 'Контакт', 'active', ?, NOW(3), NOW(3))", [meta]);
  await db.query("INSERT INTO node_history (node_id, version, action, source, changed_at, diff, snapshot) VALUES (?, 1, 'update', 'web', NOW(3), ?, ?)",
    [r.insertId, JSON.stringify({ "fields.relation": [null, "Старый друг"], "fields.company": [null, "Альфа"] }), JSON.stringify({ id: r.insertId, meta })]);
  await db.query("INSERT INTO node_links (a_id, b_id, role, origin, created_at) VALUES (?, ?, 'друг', 'ai', NOW(3))", [r.insertId, mission.id]);
  await db.query("UPDATE schema_version SET version = 4");
  await db.migrate();
  const [n] = await db.query("SELECT meta FROM nodes WHERE id = ?", [r.insertId]);
  assert.deepEqual(JSON.parse(n.meta), { company: "Альфа" });
  const [h] = await db.query("SELECT diff, snapshot FROM node_history WHERE node_id = ?", [r.insertId]);
  assert.ok(!/Старый друг|loyalty/.test(h.diff + h.snapshot));
  assert.match(h.diff, /fields.company/);
  assert.equal((await db.query("SELECT COUNT(*) AS c FROM node_links WHERE origin = 'ai'"))[0].c, 0);
});

test("схема для интерфейса", { skip: !haveDb }, async () => {
  const s = (await call("GET", "/api/schema")).data;
  assert.deepEqual(s.core, ["track", "project", "mission"]);
  assert.equal(s.types.blocker.label, "Блокер");
  assert.ok(s.person_roles.includes("ЛПР"));
});
