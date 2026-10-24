// Тесты заданий Киры: расписания, запуски, повторы, пропуски, напоминания, инструменты ассистента.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { Nodes } from "../src/nodes.js";
import { JobsModel } from "../src/jobs/model.js";
import { createRunner } from "../src/jobs/runner.js";
import { createOutbox } from "../src/outbox.js";
import { createAgent } from "../src/ai/agent.js";
import { parseCron, nextCron, describeCron } from "../src/cron.js";
import { parseLocal, formatLocal } from "../src/time.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
const TZ = "Europe/Moscow";
let db, nodes, jobs, outbox, runner, agent;

const script = [];
const fakeLlm = {
  smartModel: "smart",
  async chat({ messages, tools }) {
    fakeLlm.lastTools = tools.map((t) => t.function.name);
    fakeLlm.lastMessages = messages;
    const next = script.shift();
    if (!next) return { message: { role: "assistant", content: "ок" } };
    if (next instanceof Error) throw next;
    return { message: typeof next === "function" ? next(messages) : next };
  },
};
const toolCall = (name, args) => ({
  role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const local = (d) => formatLocal(d, TZ);

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  await db.migrate();
  nodes = new Nodes(db, TZ);
  jobs = new JobsModel(db, TZ);
  outbox = createOutbox({ db });
  const deps = {};
  agent = createAgent({ db, nodes, jobs, outbox, deps, llm: fakeLlm, tz: TZ });
  runner = createRunner({ jobs, agent, outbox });
  deps.runner = runner;
  await db.set("owner", { user_id: 1, chat_id: 555, name: "Тест" });
});

after(async () => { if (db) await db.close(); });

const due = (id) => db.query("UPDATE jobs SET next_run_at = NOW(3) - INTERVAL 1 MINUTE WHERE id = ?", [id]);

test("cron: разбор, следующий запуск, описание", () => {
  const after = parseLocal("2026-10-24 19:50", TZ).utc; // суббота
  assert.equal(local(nextCron("30 8 * * *", after, TZ)), "2026-10-25 08:30");
  assert.equal(local(nextCron("0 18 * * 5", after, TZ)), "2026-10-30 18:00");
  assert.equal(local(nextCron("0 10 * * 1-5", after, TZ)), "2026-10-26 10:00");
  assert.equal(local(nextCron("0 12 1 * *", after, TZ)), "2026-11-01 12:00");
  assert.equal(local(nextCron("*/15 * * * *", after, TZ)), "2026-10-24 20:00");
  assert.equal(local(nextCron("0 20 * * *", after, TZ)), "2026-10-24 20:00");
  assert.equal(local(nextCron("0 9 29 2 *", after, TZ)), "2028-02-29 09:00");
  assert.equal(describeCron("30 8 * * *"), "каждый день в 08:30");
  assert.equal(describeCron("0 18 * * 5"), "по пт в 18:00");
  assert.equal(describeCron("0 10 * * 1-5"), "по будням в 10:00");
  assert.equal(describeCron("0 9 * * 1,3"), "по пн, ср в 09:00");
  assert.equal(describeCron("0 12 1 * *"), "каждое 1-е число в 12:00");
  assert.throws(() => parseCron("0 25 * * *"));
  assert.throws(() => parseCron("каждый день"));
});

test("создание: разовое, регулярное, интервал; проверки", { skip: !haveDb }, async () => {
  const once = await jobs.create({ title: "Позвонить маме", action: "remind", run_at: "2030-01-05 10:00", created_by: "owner" }, "bot");
  assert.equal(once.schedule_text, "разово, 2030-01-05 10:00");
  assert.equal(once.next_run, "2030-01-05 10:00");
  assert.equal(once.created_by_text, "Владелец");
  assert.equal(once.status, "active");
  assert.equal(once.exec_status, "scheduled");
  const weekly = await jobs.create({ title: "Итоги недели", action: "do", cron: "0 18 * * 5", until: "2030-12-31" }, "kira");
  assert.equal(weekly.created_by, "kira");
  assert.match(weekly.schedule_text, /^по пт в 18:00, до 2030-12-31$/);
  const every = await jobs.create({ title: "Проверка почты", action: "do", every_minutes: 120 }, "web");
  assert.equal(every.schedule_text, "каждые 2 ч");
  assert.equal(every.created_by, "owner");
  await assert.rejects(jobs.create({ title: "x", action: "remind" }), /когда выполнить/);
  await assert.rejects(jobs.create({ title: "x", action: "fly", run_at: "2030-01-01 10:00" }), /action/);
  await assert.rejects(jobs.create({ title: "x", action: "do", cron: "0 9 * *" }), /5 частей/);
  await assert.rejects(jobs.create({ title: "x", action: "do", every_minutes: 1 }), /от 5 минут/);
  // дата без времени — в 9:00
  const d = await jobs.create({ title: "y", action: "remind", run_at: "2030-02-01" }, "web");
  assert.equal(d.next_run, "2030-02-01 09:00");
});

test("связанные объекты и история изменений", { skip: !haveDb }, async () => {
  const p = await nodes.create({ kind: "project", title: "SalesFox" });
  const t = await nodes.create({ kind: "task", title: "Смета", parent_id: p.id });
  const j = await jobs.create({ title: "Проверить смету", action: "do", run_at: "2030-03-01 12:00", links: [t.id, p.id, 99999] }, "web");
  assert.deepEqual(j.links.map((l) => l.title), ["Смета", "SalesFox", null]);
  const u = await jobs.update(j.id, { run_at: "2030-03-02 15:00" }, "web");
  assert.equal(u.next_run, "2030-03-02 15:00");
  const c = await jobs.update(j.id, { status: "cancelled" }, "web");
  assert.equal(c.next_run, null);
  assert.equal(c.status_text, "Отменено");
  const back = await jobs.update(j.id, { status: "active" }, "web");
  assert.equal(back.next_run, "2030-03-02 15:00");
  const h = await jobs.history(j.id);
  assert.deepEqual(h.map((x) => x.action), ["update", "update", "update", "create"]);
});

test("напоминание: уходит владельцу, разовое закрывается", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Выпить таблетку", instruction: "Белая, после еды", action: "remind", run_at: "2030-01-01 09:00" }, "bot");
  await due(j.id);
  const done = await runner.runDue();
  assert.deepEqual(done.map((d) => [d.id, d.status]), [[j.id, "succeeded"]]);
  const [msg] = await db.query("SELECT text, chat_id FROM outbox ORDER BY id DESC LIMIT 1");
  assert.equal(msg.chat_id, 555);
  assert.equal(msg.text, "⏰ Выпить таблетку"); // служебная инструкция владельцу не уходит
  const after = await jobs.get(j.id);
  assert.equal(after.status, "done");
  assert.equal(after.run_count, 1);
  assert.equal(after.next_run, null);
  assert.equal((await runner.runDue()).length, 0); // второй раз не выполняется
});

test("напоминание: владелец получает ровно текст message, без кавычек и пояснений", { skip: !haveDb }, async () => {
  const j = await jobs.create({
    title: "Проверить стендовый сервер", action: "remind", run_at: "2030-01-01 09:00",
    instruction: "Напомнить владельцу проверить стендовый сервер (он просил через 5 минут).",
    message: "«Пора проверить стендовый сервер.»",
  }, "bot");
  assert.equal(j.message, "Пора проверить стендовый сервер.");
  await due(j.id);
  await runner.runDue();
  const [msg] = await db.query("SELECT text FROM outbox ORDER BY id DESC LIMIT 1");
  assert.equal(msg.text, "⏰ Пора проверить стендовый сервер.");
});

test("регулярное: после запуска — следующий по расписанию; лимит запусков", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Пинг", action: "remind", cron: "0 9 * * *", max_runs: 2 }, "web");
  await due(j.id);
  await runner.runDue();
  let a = await jobs.get(j.id);
  assert.equal(a.status, "active");
  assert.match(a.next_run, / 09:00$/);
  await due(j.id);
  await runner.runDue();
  a = await jobs.get(j.id);
  assert.equal(a.run_count, 2);
  assert.equal(a.status, "done"); // исчерпан лимит
});

test("выполнение ИИ: инструменты, сообщение владельцу, итог в журнал", { skip: !haveDb }, async () => {
  const t = await nodes.create({ kind: "task", title: "Отправить КП", due: "2030-01-10" });
  const j = await jobs.create({ title: "Проверить КП", instruction: "Если задача не закрыта — напомни", action: "do", run_at: "2030-01-09 18:00", links: [t.id] }, "kira");
  await due(j.id);
  script.push(
    (messages) => {
      assert.match(messages[1].content, /Задание #\d+: Проверить КП/);
      assert.match(messages[1].content, /Отправить КП/); // связанная задача в контексте
      assert.match(messages[0].content, /выполняешь своё задание сама/);
      return toolCall("send_message", { text: "КП ещё не отправлено, срок завтра" });
    },
    { role: "assistant", content: "Напомнила про КП." },
  );
  const [r] = await runner.runDue();
  assert.equal(r.status, "succeeded");
  assert.ok(fakeLlm.lastTools.includes("send_message"));
  assert.ok(!fakeLlm.lastTools.includes("run_job_now"));
  const runs = await jobs.runs(j.id);
  assert.equal(runs[0].result, "Напомнила про КП.");
  assert.equal(runs[0].meta.tools[0].tool, "send_message");
  const [m] = await db.query("SELECT text FROM outbox ORDER BY id DESC LIMIT 1");
  assert.equal(m.text, "КП ещё не отправлено, срок завтра");
});

test("ошибка: два повтора, потом отказ и сообщение владельцу", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Сломанное", action: "do", run_at: "2030-01-01 10:00" }, "web");
  for (let i = 1; i <= 3; i++) {
    await due(j.id);
    script.push(new Error("DeepSeek: 503"));
    const [r] = await runner.runDue();
    assert.equal(r.status, "failed");
    const a = await jobs.get(j.id);
    if (i < 3) {
      assert.equal(a.exec_status, "retrying");
      assert.ok(a.next_run);
    } else {
      assert.equal(a.exec_status, "failed");
      assert.equal(a.next_run, null);
      assert.equal(a.status, "active"); // не выполнено — остаётся видимым
    }
  }
  const [m] = await db.query("SELECT text FROM outbox ORDER BY id DESC LIMIT 1");
  assert.match(m.text, /Не смогла выполнить задание #\d+ «Сломанное»: DeepSeek: 503/);
});

test("опоздавшее регулярное пропускается, разовое выполняется", { skip: !haveDb }, async () => {
  const rec = await jobs.create({ title: "Ежедневное", action: "remind", cron: "0 9 * * *" }, "web");
  const one = await jobs.create({ title: "Разовое", action: "remind", run_at: "2030-01-01 09:00" }, "web");
  await db.query("UPDATE jobs SET next_run_at = NOW(3) - INTERVAL 10 HOUR WHERE id IN (?, ?)", [rec.id, one.id]);
  const res = await runner.runDue();
  const by = Object.fromEntries(res.map((r) => [r.id, r.status]));
  assert.equal(by[rec.id], "skipped");
  assert.equal(by[one.id], "succeeded");
  const a = await jobs.get(rec.id);
  assert.equal(a.status, "active");
  assert.equal(a.run_count, 0);
  assert.match(a.next_run, / 09:00$/);
});

test("захват: одно задание не выполняется дважды", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Одно", action: "remind", run_at: "2030-01-01 09:00" }, "web");
  await due(j.id);
  assert.equal(await jobs.claim(j.id), true);
  assert.equal(await jobs.claim(j.id), false);
});

test("выполнить сейчас", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Позже", action: "remind", run_at: "2031-01-01 09:00" }, "web");
  const r = await runner.runNow(j.id);
  assert.equal(r.status, "succeeded");
  assert.equal((await jobs.get(j.id)).status, "done");
  await assert.rejects(runner.runNow(j.id), /не активно/);
});

test("ассистент в разговоре ставит задание по просьбе владельца", { skip: !haveDb }, async () => {
  script.push(
    toolCall("create_job", { title: "Позвонить Петру", action: "remind", run_at: "2030-05-05 10:00", created_by: "owner" }),
    { role: "assistant", content: "Напомню 5 мая в 10:00." },
  );
  const r = await agent.ask("напомни 5 мая 2030 в 10 позвонить Петру", { channel: "web" });
  assert.equal(r.text, "Напомню 5 мая в 10:00.");
  assert.ok(fakeLlm.lastTools.includes("create_job") && fakeLlm.lastTools.includes("run_job_now"));
  assert.ok(!fakeLlm.lastTools.includes("send_message"));
  const list = await jobs.list({ status: "active" });
  const j = list.find((x) => x.title === "Позвонить Петру");
  assert.equal(j.created_by, "owner");
  assert.equal(j.next_run, "2030-05-05 10:00");
  // ближайшие задания видны Кире в системном промпте
  const sp = await agent.systemPrompt();
  assert.match(sp, /Твои ближайшие задания: .*Позвонить Петру/);
});

test("при выполнении задания нельзя наплодить заданий", { skip: !haveDb }, async () => {
  const j = await jobs.create({ title: "Плодить", action: "do", run_at: "2030-01-01 10:00" }, "web");
  await due(j.id);
  const mk = (i) => toolCall("create_job", { title: `Новое ${i}`, action: "remind", run_at: "2031-01-01 10:00" });
  script.push(mk(1), mk(2), mk(3), mk(4), { role: "assistant", content: "Готово" });
  await runner.runDue();
  const runs = await jobs.runs(j.id);
  const results = runs[0].meta.tools.map((t) => t.ok);
  assert.deepEqual(results, [true, true, true, false]);
  const kids = (await jobs.list({})).filter((x) => /^Новое/.test(x.title));
  assert.ok(kids.every((k) => k.created_by === "kira"));
});
