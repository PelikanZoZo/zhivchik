// Тесты контактной книжки и сети: лояльность, комментарий об отношениях, модель связей от ИИ, пути знакомств.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
let db, server, base, cookie;
const cfg = { tz: "Europe/Moscow", morningTime: "08:30", assistantName: "Кира", adminPassword: "net-pass", bridgeSecret: "net-bridge", deepseek: {}, db: {} };

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

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const tick = () => call("GET", "/api/bridge/outbox", undefined, { "X-Bridge-Secret": cfg.bridgeSecret });
const mkPerson = async (title, fields = {}) => (await call("POST", "/api/items", { kind: "person", title, fields })).data.item;

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  const app = createApp(cfg, { llm: fakeLlm, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await call("POST", "/api/login", { password: cfg.adminPassword })).res.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

let petr, ivan, anna;

test("контакт: лояльность и комментарий об отношениях", { skip: !haveDb }, async () => {
  ivan = await mkPerson("Иван Петров", { company: "Альфа-Строй", position: "Генеральный директор" });
  anna = await mkPerson("Анна Ким", { company: "Альфа-Строй" });
  petr = await mkPerson("Пётр Сидоров", { loyalty: 5, relation: "Старый друг, вместе работали в Бета. Работает с Иваном Петровым из Альфа-Строй — они партнёры по гольф-клубу. Его жена Мария — юрист." });
  assert.equal(petr.fields.loyalty, 5);
  assert.equal((await call("POST", "/api/items", { kind: "person", title: "x", fields: { loyalty: 9 } })).status, 400);
  // ИИ-поля руками не поставить
  const r = await call("PATCH", `/api/items/${petr.id}`, { fields: { ai_influence: 5 } });
  assert.equal(r.data.item.fields.ai_influence, undefined);
});

test("ИИ строит модель связей по комментарию", { skip: !haveDb }, async () => {
  script.push((messages, req) => {
    assert.ok(req.json);
    assert.match(messages[1].content, /Мой комментарий об отношениях: Старый друг/);
    assert.match(messages[1].content, /Моя оценка лояльности: 5 из 5 \(Союзник\)/);
    assert.match(messages[1].content, new RegExp(`${ivan.id}: Иван Петров, Альфа-Строй`));
    return { role: "assistant", content: JSON.stringify({
      summary: "Близкий друг и бывший коллега, главный вход в Альфа-Строй.", influence: 4,
      approach: "Просить о прямом знакомстве с Иваном, не злоупотреблять.",
      relations: [
        { id: ivan.id, name: "Иван Петров", type: "партнёр", note: "гольф-клуб" },
        { id: null, name: "Мария Сидорова", type: "родственник", note: "жена, юрист", position: "юрист" },
      ],
    }) };
  });
  await tick();
  const p = (await call("GET", `/api/items/${petr.id}`)).data.item;
  assert.match(p.fields.ai_summary, /главный вход/);
  assert.equal(p.fields.ai_influence, 4);
  const ai = p.links.filter((l) => l.origin === "ai").map((l) => [l.title, l.role]).sort();
  assert.deepEqual(ai, [["Иван Петров", "партнёр"], ["Мария Сидорова", "родственник"]]);
  const maria = (await call("GET", "/api/items?kind=person&q=" + encodeURIComponent("Мария"))).data.items.find((x) => x.title === "Мария Сидорова");
  assert.equal(maria.fields.position, "юрист");
  // больше не пересчитывает, пока ничего не изменилось
  const n = seen.length;
  await tick();
  assert.equal(seen.length, n);
  // у Ивана связь видна с его стороны, версия Ивана не тронута (не уходит на пересчёт)
  const iv = (await call("GET", `/api/items/${ivan.id}`)).data.item;
  assert.ok(iv.links.some((l) => l.title === "Пётр Сидоров" && l.role === "партнёр"));
});

test("изменил комментарий — модель пересобрана, мои связи не тронуты", { skip: !haveDb }, async () => {
  await call("POST", `/api/items/${petr.id}/links`, { other_id: anna.id, role: "коллега" }); // моя связь
  await call("PATCH", `/api/items/${petr.id}`, { fields: { relation: "Старый друг. С Иваном Петровым поссорился в прошлом году." } });
  script.push({ role: "assistant", content: '```json\n{"summary": "Друг", "influence": 3, "approach": "Не через него", "relations": [{"id": ' + ivan.id + ', "name": "Иван Петров", "type": "конфликт", "note": "ссора"}]}\n```' });
  await tick();
  const p = (await call("GET", `/api/items/${petr.id}`)).data.item;
  const links = p.links.filter((l) => l.kind === "person").map((l) => [l.title, l.role, l.origin]).sort();
  assert.deepEqual(links, [["Анна Ким", "коллега", "owner"], ["Иван Петров", "конфликт", "ai"]]);
});

test("путь знакомств: через лояльных, в обход конфликтов", { skip: !haveDb }, async () => {
  const olga = await mkPerson("Ольга Лебедева", { loyalty: 4 });
  await call("POST", `/api/items/${olga.id}/links`, { other_id: anna.id, role: "подруга" });
  await call("POST", `/api/items/${anna.id}/links`, { other_id: ivan.id, role: "подчинённый" });
  const r = (await call("GET", `/api/items/${ivan.id}/paths`)).data;
  assert.equal(r.direct, false);
  // через Петра нельзя (конфликт); через Ольгу → Анна → Иван, и через Петра → Анна → Иван (Пётр лоялен 5)
  assert.ok(r.paths.length >= 1);
  assert.ok(r.paths.every((p) => !/конфликт/.test(p.chain)));
  assert.ok(r.paths.some((p) => /Анна Ким .*Иван Петров$/.test(p.chain)));
  const net = (await call("GET", "/api/network")).data;
  assert.ok(net.people.length >= 5);
  assert.ok(net.edges.some((e) => e.origin === "ai"));
  // сам лояльный — путь не нужен
  assert.equal((await call("GET", `/api/items/${olga.id}/paths`)).data.direct, true);
});

test("Кира: записывает отношения в комментарий и ищет путь", { skip: !haveDb }, async () => {
  await call("POST", "/api/bridge/update", { update_id: 1, message: { message_id: 1, text: cfg.adminPassword, chat: { id: 9, type: "private" }, from: { id: 9, first_name: "Я" } } }, { "X-Bridge-Secret": cfg.bridgeSecret });
  const tc = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  script.push(
    (messages) => {
      assert.match(messages[0].content, /Контактная книжка/);
      return tc("update_item", { id: ivan.id, fields: { loyalty: 2, relation: "Видел один раз на выставке, холодно ответил." } });
    },
    tc("network_path", { name: "Иван Петров" }),
    (messages) => {
      const r = JSON.parse(messages.at(-1).content);
      assert.ok(r.paths.length);
      return { role: "assistant", content: `Лучше через ${r.paths[0].start}` };
    },
  );
  const r = await call("POST", "/api/bridge/update", { update_id: 2, message: { message_id: 2, text: "Ивана видел раз на выставке, холодный. Как к нему выйти?", chat: { id: 9, type: "private" }, from: { id: 9, first_name: "Я" } } }, { "X-Bridge-Secret": cfg.bridgeSecret });
  assert.match(r.data.actions[0].params.text, /Лучше через/);
  const iv = (await call("GET", `/api/items/${ivan.id}`)).data.item;
  assert.equal(iv.fields.loyalty, 2);
});
