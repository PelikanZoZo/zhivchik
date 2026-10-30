// Личный чат с DeepSeek: ответ потоком, ничего не сохраняется (ни в переписке Киры, ни в архиве), без входа — нельзя.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
let db, app, server, base, cookie, fake, seen;

before(async () => {
  if (!haveDb) return;
  // поддельный DeepSeek: отвечает потоком, как настоящий
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = JSON.parse(body);
      if (seen.messages.at(-1).content === "сломайся") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [{ reasoning_content: "думаю" }, { content: "При" }, { content: "вет, " }, { content: "**Денис**!" }];
      for (const d of chunks) res.write(`data: ${JSON.stringify({ model: "deepseek-test", choices: [{ delta: d }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => fake.listen(0, r));
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  const cfg = { tz: "Europe/Moscow", morningTime: "08:30", assistantName: "Кира", adminPassword: "п", bridgeSecret: "b", db: {}, filesDir: "/tmp/kira-pc",
    deepseek: { key: "test", url: `http://127.0.0.1:${fake.address().port}`, model: "deepseek-flash", smartModel: "deepseek-pro" } };
  app = createApp(cfg, { llm: { smartModel: "s", chat: async () => ({ message: { role: "assistant", content: "ок" } }) }, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await app.services();
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "п" }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) server.close();
  if (fake) fake.close();
  if (db) await db.close();
});

const ask = (body, c = cookie) => fetch(base + "/api/private-chat", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c || "" }, body: JSON.stringify(body) });

test("ответ приходит потоком, рассуждения отдельно, модель выбирается", { skip: !haveDb }, async () => {
  const res = await ask({ messages: [{ role: "user", content: "привет" }, { role: "assistant", content: "x" }, { role: "user", content: "как дела" }], model: "pro", system: "Будь краток", temperature: 0.3 });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = (await res.text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  assert.equal(events.map((e) => e.content || "").join(""), "Привет, **Денис**!");
  assert.equal(events[0].reasoning, "думаю");
  assert.deepEqual(events.at(-1), { done: true, usage: { prompt_tokens: 5, completion_tokens: 4 }, model: "deepseek-test", finish: "stop" });
  assert.equal(seen.model, "deepseek-pro");
  assert.equal(seen.stream, true);
  assert.equal(seen.temperature, 0.3);
  assert.deepEqual(seen.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
});

test("ничего не сохраняется: ни переписка Киры, ни архив", { skip: !haveDb }, async () => {
  await (await ask({ messages: [{ role: "user", content: "секретный вопрос про Insurion" }] })).text();
  for (const t of ["messages", "dwh_messages", "outbox"]) {
    const rows = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "outbox" ? "text" : t === "messages" ? "content" : "text"} LIKE '%секретный%'`);
    assert.equal(rows[0].n, 0, t);
  }
});

test("без входа нельзя; ошибки DeepSeek и пустой запрос — понятным текстом", { skip: !haveDb }, async () => {
  assert.equal((await ask({ messages: [{ role: "user", content: "привет" }] }, "")).status, 401);
  const bad = await ask({ messages: [{ role: "user", content: "сломайся" }] });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /DeepSeek: 401 bad key/);
  const empty = await ask({ messages: [] });
  assert.equal(empty.status, 400);
});
