// Планировщик: расчёт связей и автосдвиг, график проекта, базовый план, план от Киры.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { dayNum, dayStr, earliestStart, propagate, createsCycle } from "../src/plan/schedule.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
let db, app, server, base, cookie;
const cfg = { tz: "Europe/Moscow", morningTime: "08:30", assistantName: "Кира", adminPassword: "п", bridgeSecret: "b", deepseek: {}, db: {}, filesDir: "/tmp/kira-plan-files" };
const script = [];
const fakeLlm = {
  smartModel: "s",
  async chat({ messages }) {
    const next = script.shift();
    if (!next) return { message: { role: "assistant", content: "ок" } };
    return { message: typeof next === "function" ? next(messages) : next };
  },
};
const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const lastTool = (messages) => JSON.parse(messages.at(-1).content);

async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie || "" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null), res };
}

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  app = createApp(cfg, { llm: fakeLlm, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await app.services();
  const login = await call("POST", "/api/login", { password: cfg.adminPassword });
  cookie = login.res.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test("расчёт: типы связей, задержка, вехи, цепочка, циклы", () => {
  const d = dayNum;
  const p = { start: d("2026-11-02"), finish: d("2026-11-06") }; // пн–пт
  const s = { start: d("2026-11-01"), finish: d("2026-11-03") }; // 3 дня
  assert.equal(dayStr(earliestStart(p, s, { type: "FS", lag: 0 })), "2026-11-07");
  assert.equal(dayStr(earliestStart(p, s, { type: "FS", lag: 2 })), "2026-11-09");
  assert.equal(dayStr(earliestStart(p, s, { type: "SS", lag: 1 })), "2026-11-03");
  assert.equal(dayStr(earliestStart(p, s, { type: "FF", lag: 0 })), "2026-11-04"); // закончить вместе: 4,5,6
  assert.equal(dayStr(earliestStart(p, { ...s, milestone: true, finish: s.start }, { type: "FS", lag: 0 })), "2026-11-06"); // веха — в последний день
  const items = new Map([
    [1, { start: d("2026-11-02"), finish: d("2026-11-04") }],
    [2, { start: d("2026-11-05"), finish: d("2026-11-06") }],
    [3, { start: d("2026-11-09"), finish: d("2026-11-09") }],
  ]);
  const links = [{ pred_id: 1, succ_id: 2, type: "FS", lag: 0 }, { pred_id: 2, succ_id: 3, type: "FS", lag: 0 }];
  items.get(1).finish = d("2026-11-06"); // задача 1 стала на 2 дня длиннее
  const moved = propagate(items, links, [1]);
  assert.equal(dayStr(items.get(2).start), "2026-11-07");
  assert.equal(dayStr(items.get(2).finish), "2026-11-08");
  assert.equal(dayStr(items.get(3).start), "2026-11-09"); // у 3-й был запас — не двигается
  assert.deepEqual([...moved.keys()], [2]);
  assert.equal(createsCycle(links, 3, 1), true);
  assert.equal(createsCycle(links, 1, 3), false);
});

test("график проекта: этапы — сводные, цели — вехи, риски у этапа, без дат — отдельно", { skip: !haveDb }, async () => {
  const { nodes } = await app.services();
  const pr = await nodes.create({ kind: "project", title: "Пилот" }, "web");
  const st1 = await nodes.create({ kind: "stage", title: "Подготовка", parent_id: pr.id }, "web");
  const st2 = await nodes.create({ kind: "stage", title: "Запуск", parent_id: pr.id }, "web");
  const t1 = await nodes.create({ kind: "task", title: "Собрать требования", parent_id: pr.id, stage_id: st1.id, start: "2026-11-02", due: "2026-11-04", fields: { progress: 50 } }, "web");
  const t2 = await nodes.create({ kind: "task", title: "Согласовать смету", parent_id: pr.id, stage_id: st1.id, start: "2026-11-05", due: "2026-11-06" }, "web");
  const t3 = await nodes.create({ kind: "task", title: "Развернуть стенд", parent_id: pr.id, stage_id: st2.id, start: "2026-11-09", due: "2026-11-13" }, "web");
  const g1 = await nodes.create({ kind: "goal", title: "Смета согласована", parent_id: pr.id, stage_id: st1.id, due: "2026-11-06" }, "web");
  await nodes.create({ kind: "risk", title: "Заказчик затянет согласование", parent_id: pr.id, stage_id: st1.id, fields: { probability: 4, impact: 4 } }, "web");
  await nodes.create({ kind: "task", title: "Без даты", parent_id: pr.id }, "web");
  const r = (await call("GET", `/api/plan?root=${pr.id}`)).data;
  const row = (id) => r.rows.find((x) => x.id === id);
  assert.equal(row(pr.id).type, "project");
  assert.deepEqual([row(st1.id).type, row(st1.id).start, row(st1.id).finish], ["project", "2026-11-02", "2026-11-06"]);
  assert.equal(row(t1.id).parent, st1.id);
  assert.equal(row(t1.id).duration, 3);
  assert.equal(row(t1.id).progress, 0.5);
  assert.equal(row(g1.id).type, "milestone");
  assert.equal(row(g1.id).parent, st1.id);
  assert.equal(row(st1.id).risks[0].level, "high");
  assert.deepEqual(r.undated.map((u) => u.title), ["Без даты"]);
  // порядок: этап 1, его задачи, веха; этап 2, его задача
  assert.deepEqual(r.rows.map((x) => x.id), [pr.id, st1.id, t1.id, t2.id, g1.id, st2.id, t3.id]);
  test.ids = { pr, st1, st2, t1, t2, t3, g1 };
});

test("связи и автосдвиг: перенос, «что уедет» без записи, перенос этапа целиком, циклы запрещены", { skip: !haveDb }, async () => {
  const { pr, st1, st2, t1, t2, t3, g1 } = test.ids;
  for (const [a, b] of [[t1, t2], [t2, g1], [t2, t3]]) {
    const r = await call("POST", "/api/plan/links", { pred_id: a.id, succ_id: b.id, type: "FS" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  // цикл и связь со сводной строкой — нельзя
  assert.match((await call("POST", "/api/plan/links", { pred_id: t3.id, succ_id: t1.id })).data.error, /замкнутый круг/);
  assert.match((await call("POST", "/api/plan/links", { pred_id: st1.id, succ_id: t3.id })).data.error, /сводная/);
  // «что уедет, если требования затянутся на 3 дня» — без записи
  const dry = (await call("PATCH", `/api/plan/items/${t1.id}`, { finish: "2026-11-07", dry_run: true })).data;
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.changed.map((c) => [c.title, c.to.start, c.shifted_days]), [
    ["Собрать требования", "2026-11-02", 0], ["Согласовать смету", "2026-11-08", 3], ["Смета согласована", "2026-11-09", 3], ["Развернуть стенд", "2026-11-10", 1],
  ]);
  assert.equal((await call("GET", `/api/plan?root=${pr.id}`)).data.rows.find((x) => x.id === t2.id).start, "2026-11-05", "ничего не записано");
  // теперь по-настоящему
  const res = (await call("PATCH", `/api/plan/items/${t1.id}`, { finish: "2026-11-07" })).data;
  assert.equal(res.changed.length, 4);
  const plan = (await call("GET", `/api/plan?root=${pr.id}`)).data;
  const row = (id) => plan.rows.find((x) => x.id === id);
  assert.deepEqual([row(t2.id).start, row(t2.id).finish], ["2026-11-08", "2026-11-09"]);
  assert.equal(row(g1.id).start, "2026-11-09");
  assert.deepEqual([row(t3.id).start, row(t3.id).finish], ["2026-11-10", "2026-11-14"]);
  assert.equal(row(t2.id).preds[0].id, t1.id);
  assert.equal(plan.links.length, 3);
  // даты этапа хранятся и вне графика
  const { nodes } = await app.services();
  const s1 = await nodes.get(st1.id);
  assert.deepEqual([s1.start, s1.due], ["2026-11-02", "2026-11-09"]);
  // перенос этапа 2 целиком на неделю вперёд
  await call("PATCH", `/api/plan/items/${st2.id}`, { start: "2026-11-17" });
  assert.equal((await nodes.get(t3.id)).start, "2026-11-17");
  // сдвиг предшественника назад последователей не тянет (они не «прилипают»)
  await call("PATCH", `/api/plan/items/${t1.id}`, { finish: "2026-11-04" });
  assert.equal((await nodes.get(t2.id)).start, "2026-11-08");
  // прогресс
  await call("PATCH", `/api/plan/items/${t2.id}`, { progress: 80 });
  assert.equal((await nodes.get(t2.id)).fields.progress, 80);
  // удалить связь
  const lid = plan.links.find((l) => l.source === t2.id && l.target === t3.id).id;
  await call("DELETE", `/api/plan/links/${lid}`);
  assert.equal((await call("GET", `/api/plan?root=${pr.id}`)).data.links.length, 2);
});

test("базовый план: снимок дат и отклонение факта", { skip: !haveDb }, async () => {
  const { pr, t1, t2 } = test.ids;
  const b = (await call("POST", "/api/plan/baseline", { root_id: pr.id, name: "Утверждённый" })).data;
  assert.equal(b.name, "Утверждённый");
  await call("PATCH", `/api/plan/items/${t1.id}`, { finish: "2026-11-09" }); // +5 дней, сдвинет смету
  const plan = (await call("GET", `/api/plan?root=${pr.id}`)).data;
  assert.equal(plan.baseline.name, "Утверждённый");
  const r2 = plan.rows.find((x) => x.id === t2.id);
  assert.deepEqual(r2.baseline, { start: "2026-11-08", finish: "2026-11-09" });
  assert.equal(r2.variance, 2);
  // общий график — все проекты
  const all = (await call("GET", "/api/plan")).data;
  assert.ok(all.rows.some((x) => x.id === pr.id && x.parent === 0));
});

test("Кира строит план проекта в диалоге и отвечает, что уедет", { skip: !haveDb }, async () => {
  const { nodes } = await app.services();
  const pr = await nodes.create({ kind: "project", title: "Внедрение у Альфа-Строй" }, "web");
  script.push(
    toolCall("build_plan", {
      root_id: pr.id, start: "2026-11-02",
      stages: [
        { title: "Обследование", tasks: [{ key: "a", title: "Интервью", days: 3 }, { key: "b", title: "Отчёт", days: 2, after: ["a"] }],
          goals: [{ title: "Отчёт принят" }], risks: [{ title: "Нет доступа к людям", probability: 3, impact: 4 }] },
        { title: "Пилот", tasks: [{ key: "c", title: "Настройка", days: 5 }, { key: "d", title: "Обучение", days: 2, after: ["c"] }] },
      ],
      final_goal: { title: "Пилот запущен" },
    }),
    (messages) => {
      const r = lastTool(messages);
      assert.deepEqual(r.created, { stages: 2, tasks: 4, goals: 2, risks: 1, links: 5 });
      assert.equal(r.finish, "2026-11-13");
      return toolCall("set_dates", { id: r.stages[0].id, start: "2026-11-09", dry_run: true });
    },
    (messages) => {
      const r = lastTool(messages);
      assert.equal(r.dry_run, true);
      assert.ok(r.changed.some((c) => c.title === "Пилот запущен" && c.shifted_days === 7));
      return { role: "assistant", content: "План готов: финиш 13 ноября; если начать на неделю позже — финиш 20-го." };
    },
  );
  const r = await call("POST", "/api/chat", { text: "распланируй внедрение у Альфа-Строй: обследование и пилот, старт 2 ноября" });
  assert.match(r.data.text, /План готов/);
  const plan = (await call("GET", `/api/plan?root=${pr.id}`)).data;
  const by = (t) => plan.rows.find((x) => x.text === t);
  assert.deepEqual([by("Интервью").start, by("Отчёт").start, by("Отчёт принят").start], ["2026-11-02", "2026-11-05", "2026-11-06"]);
  assert.deepEqual([by("Настройка").start, by("Обучение").finish, by("Пилот запущен").start], ["2026-11-07", "2026-11-13", "2026-11-13"]);
  assert.equal(by("Обследование").risks.length, 1);
  assert.equal(by("Пилот запущен").goal_type, "final");
  // ничего не записалось при «что если»
  assert.equal(by("Интервью").start, "2026-11-02");
});

test("build_plan подхватывает существующие этапы и цели по названию, не плодит дубли", { skip: !haveDb }, async () => {
  const { nodes, planner } = await app.services();
  const pr = await nodes.create({ kind: "project", title: "С этапами" }, "web");
  const st = await nodes.create({ kind: "stage", title: "Выход на ЛПР", parent_id: pr.id }, "web");
  const g = await nodes.create({ kind: "goal", title: "Первая встреча с гендиректором", parent_id: pr.id }, "web");
  const r = await planner.buildPlan(pr.id, { start: "2026-12-01", stages: [{ title: "выход на лпр", tasks: [{ title: "Найти контакт", days: 3 }], goals: [{ title: "Первая встреча с гендиректором" }] }] }, { source: "web" });
  assert.equal(r.reused, 2);
  assert.equal(r.created.stages, 0);
  assert.equal(r.created.goals, 0);
  const goal = await nodes.get(g.id);
  assert.deepEqual([goal.stage_id, goal.due.slice(0, 10)], [st.id, "2026-12-03"]);
  assert.equal((await nodes.list({ kind: "stage", parent_id: pr.id })).length, 1);
});

test("обрезанный по длине ответ модели — Киру просят сделать меньшими шагами", { skip: !haveDb }, async () => {
  let n = 0;
  script.push(() => { n++; return { role: "assistant", content: "" }; });
  const orig = fakeLlm.chat;
  fakeLlm.chat = async (args) => {
    const r = await orig(args);
    if (n === 1 && !r.finish) { n++; return { ...r, finish: "length" }; }
    return r;
  };
  script.push((messages) => { assert.match(messages.at(-1).content, /не поместился/); return { role: "assistant", content: "Построила по частям." }; });
  const r = await call("POST", "/api/chat", { text: "распланируй большой проект" });
  fakeLlm.chat = orig;
  assert.equal(r.data.text, "Построила по частям.");
});
