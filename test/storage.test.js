// Хранилище файлов, чтение документов, голосовые, архив переписки (DWH) — на настоящей базе, ИИ поддельный.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { extractText, docType } from "../src/docs/extract.js";
import { stem, kindOf } from "../src/storage.js";
import { pickMedia } from "../src/bot.js";
import { fileAction } from "../src/telegram.js";

const env = process.env;
const haveDb = !!env.TEST_DB_NAME;
const FX = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "kira-files-"));

let db, app, server, base, cookie;
const cfg = {
  tz: "Europe/Moscow", morningTime: "08:30", assistantName: "Кира",
  adminPassword: "пароль-1", bridgeSecret: "bridge-s", deepseek: {}, db: {}, filesDir,
};

const script = [];
const seen = [];
const fakeLlm = {
  smartModel: "smart",
  async chat({ messages, json }) {
    seen.push({ messages, json });
    if (json) return { message: { role: "assistant", content: JSON.stringify({ summary: "Договор поставки между Альфа-Строй и SalesFox на 2 млн ₽", keywords: ["договор", "поставка", "Альфа-Строй"] }) } };
    const next = script.shift();
    if (!next) return { message: { role: "assistant", content: "ок" } };
    return { message: typeof next === "function" ? next(messages) : next };
  },
};
const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const lastTool = (messages) => JSON.parse(messages.at(-1).content);

async function call(method, p, body, headers = {}, raw = false) {
  const res = await fetch(base + p, {
    method, headers: { ...(raw ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const bridge = (method, p, body, headers = {}, raw = false) => call(method, p, body, { "X-Bridge-Secret": cfg.bridgeSecret, ...headers }, raw);

async function bridgeUpload(buf, name, mime) {
  const id = "up" + Math.random().toString(36).slice(2, 12);
  const CH = 1000; // маленькие куски — проверить склейку
  const total = Math.ceil(buf.length / CH);
  let r;
  for (let i = 0; i < total; i++) {
    r = await bridge("POST", "/api/bridge/upload", buf.subarray(i * CH, (i + 1) * CH), {
      "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Chunk": String(i), "X-Chunks": String(total),
      "X-File-Name": encodeURIComponent(name), "X-File-Type": mime,
    }, true);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return r.data;
}

let uid = 500;
const update = (message) => ({ update_id: ++uid, message: { message_id: uid * 10, chat: { id: 77, type: "private" }, from: { id: 77, first_name: "Я" }, ...message } });

before(async () => {
  if (!haveDb) return;
  db = await openDb({ host: env.TEST_DB_HOST || "localhost", port: 3306, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || "", database: env.TEST_DB_NAME });
  for (const t of await db.query("SHOW TABLES")) await db.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  app = createApp(cfg, { llm: fakeLlm, dbOverride: db });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await app.services();
  await db.set("owner", { user_id: 77, chat_id: 77, name: "Я" });
  const login = await call("POST", "/api/login", { password: cfg.adminPassword });
  cookie = login.res.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) server.close();
  if (db) await db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

test("документы: docx, xlsx, pptx, pdf, текст в cp1251", async () => {
  const read = (f) => extractText(fs.readFileSync(path.join(FX, f)), { name: f });
  const d = await read("dogovor.docx");
  assert.equal(d.status, "ok");
  assert.match(d.text, /Договор поставки № 15/);
  assert.match(d.text, /Сумма \| 2 000 000 ₽/);
  const x = await read("smeta.xlsx");
  assert.match(x.text, /\[лист «Смета»\]\nПозиция\tСумма\nПилот\t1500000/);
  assert.equal(x.pages, 2);
  const p = await read("deck.pptx");
  assert.match(p.text, /\[слайд 1\]\nSalesFox\nАгентские продажи для B2B\nЗаметки: Сказать про пилот/);
  const pdf = await read("akt.pdf");
  assert.equal(pdf.pages, 2);
  assert.match(pdf.text, /\[стр\. 1\]\nАкт выполненных работ № 7/);
  assert.match(pdf.text, /\[стр\. 2\]\nСтраница два/);
  const cp = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» в windows-1251
  assert.equal((await extractText(cp, { name: "a.txt" })).text, "Привет");
  assert.equal((await extractText(Buffer.from("x"), { name: "old.doc" })).status, "unsupported");
  assert.equal(docType("photo.jpg", "image/jpeg"), null);
});

test("вид файла, основа слова, что за файл в сообщении", () => {
  assert.equal(kindOf({ tgType: "voice" }), "voice");
  assert.equal(kindOf({ mime: "application/pdf", name: "a.pdf" }), "document");
  assert.equal(kindOf({ name: "song.mp3" }), "audio");
  assert.equal(stem("договора"), "договор");
  assert.equal(stem("смету"), "смет");
  assert.equal(stem("2026"), "2026");
  const m = pickMedia({ photo: [{ file_id: "s", file_size: 10, width: 90, height: 90 }, { file_id: "b", file_size: 900, width: 900, height: 900 }] });
  assert.equal(m.file_id, "b");
  assert.equal(pickMedia({ voice: { file_id: "v", duration: 5 } }).spoken, true);
  assert.equal(pickMedia({ text: "hi" }), null);
  assert.deepEqual(fileAction(1, { id: 5, tg_type: "voice", tg_file_id: "VVV", name: "г.ogg" }, "вот").params, { chat_id: 1, voice: "VVV", caption: "вот" });
  assert.deepEqual(fileAction(1, { id: 5, name: "a.pdf", mime: "application/pdf" }).params.document, { kira_file: 5, name: "a.pdf", mime: "application/pdf" });
});

test("загрузка кусками: склейка, повтор куска, неверный порядок", { skip: !haveDb }, async () => {
  const { files } = await app.services();
  const parts = [Buffer.from("раз-"), Buffer.from("два-"), Buffer.from("три")];
  assert.deepEqual(await files.appendChunk(Readable.from([parts[0]]), { uploadId: "abcdefgh1", index: 0, total: 3, name: "a.txt" }), { done: false, next: 1 });
  assert.deepEqual(await files.appendChunk(Readable.from([parts[0]]), { uploadId: "abcdefgh1", index: 0, total: 3, name: "a.txt" }), { done: false, next: 1 });
  await files.appendChunk(Readable.from([parts[1]]), { uploadId: "abcdefgh1", index: 1, total: 3, name: "a.txt" });
  await files.appendChunk(Readable.from([parts[1]]), { uploadId: "abcdefgh1", index: 1, total: 3, name: "a.txt" }); // повтор — без дубля
  const r = await files.appendChunk(Readable.from([parts[2]]), { uploadId: "abcdefgh1", index: 2, total: 3, name: "a.txt" });
  assert.equal(r.done, true);
  assert.equal(fs.readFileSync(files.resolve(r.key), "utf8"), "раз-два-три");
  await assert.rejects(files.appendChunk(Readable.from([parts[1]]), { uploadId: "abcdefgh2", index: 1, total: 3, name: "a" }), /не найдена/);
  await assert.rejects(files.appendChunk(Readable.from([parts[1]]), { uploadId: "../../x", index: 0, total: 1, name: "a" }), /Неверный/);
});

test("документ из Telegram: сохраняется, читается, Кира отвечает по тексту", { skip: !haveDb }, async () => {
  const buf = fs.readFileSync(path.join(FX, "dogovor.docx"));
  const kf = await bridgeUpload(buf, "dogovor.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  script.push((messages) => {
    const u = messages.at(-1).content;
    assert.match(u, /Владелец прислал файл #\d+ «dogovor\.docx»/);
    assert.match(u, /Договор поставки № 15/);
    assert.match(u, /Подписи нет/);
    return { role: "assistant", content: "Договор поставки с Альфа-Строй на 2 млн, сохранила." };
  });
  const r = await bridge("POST", "/api/bridge/update", { ...update({ document: { file_id: "DOC1", file_unique_id: "U1", file_name: "dogovor.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_size: buf.length } }), kira_file: kf });
  assert.match(r.data.actions[0].params.text, /Договор поставки/);
  const [f] = await db.query("SELECT * FROM storage_files WHERE tg_file_id = 'DOC1'");
  assert.equal(f.kind, "document");
  assert.equal(f.text_status, "ok");
  assert.equal(f.sha256.length, 64);
  // описание — в фоне, при следующем такте
  await bridge("GET", "/api/bridge/outbox");
  const [d] = await db.query("SELECT summary, keywords FROM storage_files WHERE id = ?", [f.id]);
  assert.match(d.summary, /Договор поставки/);
  assert.match(d.keywords, /Альфа-Строй/);
  // тот же файл ещё раз — дубль не создаётся
  const kf2 = await bridgeUpload(buf, "copy.docx", "application/octet-stream");
  script.push({ role: "assistant", content: "Это тот же договор." });
  await bridge("POST", "/api/bridge/update", { ...update({ document: { file_id: "DOC2", file_unique_id: "U2", file_name: "copy.docx" } }), kira_file: kf2 });
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM storage_files"))[0].n, 1);
});

test("голосовое: расшифровка — это сообщение; файл в хранилище и в архиве", { skip: !haveDb }, async () => {
  const kf = await bridgeUpload(Buffer.from("OggS-fake-voice"), "voice.ogg", "audio/ogg");
  script.push((messages) => {
    const u = messages.at(-1).content;
    assert.match(u, /^\[Голосовое сообщение 0:07, сохранено в хранилище как файл #\d+ «Голосовое .+\.ogg»\. Расшифровка:\]\nНапомни завтра позвонить юристу/);
    return { role: "assistant", content: "Поставила напоминание на завтра." };
  });
  const r = await bridge("POST", "/api/bridge/update", { ...update({ voice: { file_id: "VOICE1", file_unique_id: "UV1", duration: 7, mime_type: "audio/ogg", file_size: 15 } }), kira_file: { ...kf, transcript: "Напомни завтра позвонить юристу по смете" } });
  assert.match(r.data.actions[0].params.text, /напоминание/);
  const [v] = await db.query("SELECT * FROM storage_files WHERE tg_file_id = 'VOICE1'");
  assert.equal(v.kind, "voice");
  assert.equal(v.text, "Напомни завтра позвонить юристу по смете");
  const arch = await db.query("SELECT direction, msg_type, text, file_id FROM dwh_messages WHERE file_id = ? OR (direction = 'out' AND text LIKE 'Поставила%')", [v.id]);
  assert.deepEqual(arch.map((a) => [a.direction, a.msg_type]), [["in", "voice"], ["out", "text"]]);
  assert.equal(arch[0].text, "Напомни завтра позвонить юристу по смете");
  // не распознано — честно говорим, Киру не зовём
  const r2 = await bridge("POST", "/api/bridge/update", { ...update({ voice: { file_id: "VOICE2", file_unique_id: "UV2", duration: 3 } }), kira_file: { error: "file is too big (больше 20 МБ)" } });
  assert.match(r2.data.actions[0].params.text, /Сохранила голосовое в хранилище .*распознать не смогла/);
});

test("Кира находит файл по смыслу и присылает его", { skip: !haveDb }, async () => {
  script.push(
    toolCall("find_files", { query: "договора с Альфа-Строем" }),
    (messages) => {
      const r = lastTool(messages);
      assert.equal(r.count, 1);
      assert.equal(r.files[0].name, "dogovor.docx");
      return toolCall("send_file", { id: r.files[0].id, caption: "Договор с Альфа-Строй" });
    },
    (messages) => {
      assert.equal(lastTool(messages).ok, true);
      return { role: "assistant", content: "Вот договор." };
    },
  );
  const r = await bridge("POST", "/api/bridge/update", update({ text: "пришли договор с альфастроем" }));
  assert.equal(r.data.actions.length, 2);
  assert.equal(r.data.actions[1].method, "sendDocument");
  assert.equal(r.data.actions[1].params.document, "DOC1"); // по file_id Telegram — без загрузки
  assert.equal(r.data.actions[1].params.caption, "Договор с Альфа-Строй");
  // голосовое — по расшифровке
  script.push(
    toolCall("find_files", { query: "юрист смета", kind: "voice" }),
    (messages) => {
      const r = lastTool(messages);
      assert.equal(r.files[0].kind, "voice");
      assert.match(r.files[0].snippet, /юристу/);
      return toolCall("read_file", { id: r.files[0].id });
    },
    (messages) => {
      assert.equal(lastTool(messages).text, "Напомни завтра позвонить юристу по смете");
      return { role: "assistant", content: "Нашла." };
    },
  );
  await bridge("POST", "/api/bridge/update", update({ text: "найди голосовое, где я говорил про юриста" }));
});

test("файл к проекту, переименование, поиск по переписке", { skip: !haveDb }, async () => {
  const { nodes, storage } = await app.services();
  const pr = await nodes.create({ kind: "project", title: "Пилот Альфа-Строй" }, "web");
  const [f] = await db.query("SELECT id FROM storage_files WHERE tg_file_id = 'DOC1'");
  script.push(
    toolCall("attach_file", { id: f.id, parent_id: pr.id }),
    (messages) => { assert.equal(lastTool(messages).ok, true); return toolCall("rename_file", { id: f.id, name: "Договор поставки №15 — Альфа-Строй.docx" }); },
    (messages) => { assert.equal(lastTool(messages).ok, true); return toolCall("search_chat_history", { query: "юристу" }); },
    (messages) => {
      const r = lastTool(messages);
      assert.ok(r.messages.some((m) => m.who === "владелец" && m.type === "voice"));
      return { role: "assistant", content: "Приложила и переименовала." };
    },
  );
  await bridge("POST", "/api/bridge/update", update({ text: "приложи договор к пилоту и назови нормально" }));
  const full = await nodes.get(pr.id, { full: true });
  const att = full.children.find((c) => c.kind === "attachment");
  assert.equal(att.fields.storage_id, f.id);
  assert.equal((await storage.get(f.id)).name, "Договор поставки №15 — Альфа-Строй.docx");
  // вложение скачивается
  const dl = await fetch(`${base}/api/files/${att.id}`, { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
});

test("сайт: загрузка кусками в хранилище, список, скачать, отправить в Telegram", { skip: !haveDb }, async () => {
  const buf = fs.readFileSync(path.join(FX, "akt.pdf"));
  const id = "web" + Date.now();
  const half = Math.ceil(buf.length / 2);
  let r = await call("POST", "/api/storage/upload", buf.subarray(0, half), { "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Chunk": "0", "X-Chunks": "2", "X-File-Name": encodeURIComponent("Акт №7.pdf"), "X-File-Type": "application/pdf" }, true);
  assert.equal(r.data.done, false);
  r = await call("POST", "/api/storage/upload", buf.subarray(half), { "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Chunk": "1", "X-Chunks": "2", "X-File-Name": encodeURIComponent("Акт №7.pdf"), "X-File-Type": "application/pdf" }, true);
  assert.equal(r.data.done, true);
  assert.equal(r.data.file.pages, 2);
  assert.equal(r.data.file.text_status, "ok");
  const list = await call("GET", "/api/storage?q=акта");
  assert.equal(list.data.files[0].name, "Акт №7.pdf");
  const one = await call("GET", `/api/storage/${r.data.file.id}`);
  assert.match(one.data.file.text, /GlowByte/);
  const dl = await fetch(`${base}/api/storage/${r.data.file.id}/download`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, buf.length);
  assert.equal((await call("POST", `/api/storage/${r.data.file.id}/send`)).status, 200);
  const out = await bridge("GET", "/api/bridge/outbox");
  const act = out.data.items.at(-1).actions[0];
  assert.equal(act.method, "sendDocument");
  assert.deepEqual(act.params.document, { kira_file: r.data.file.id, name: "Акт №7.pdf", mime: "application/pdf" });
  // Worker забирает файл с сайта
  const wf = await fetch(`${base}/api/bridge/file/${r.data.file.id}`, { headers: { "X-Bridge-Secret": cfg.bridgeSecret } });
  assert.equal(wf.status, 200);
  assert.equal((await fetch(`${base}/api/bridge/file/${r.data.file.id}`)).status, 403);
  assert.equal((await call("GET", "/api/storage", undefined, { Cookie: "" })).status, 401);
});

test("архив переписки: всё, что было — с сайта, из Telegram, сообщения Киры по заданиям", { skip: !haveDb }, async () => {
  const { outbox } = await app.services();
  script.push({ role: "assistant", content: "Привет с сайта" });
  await call("POST", "/api/chat", { text: "привет" });
  await outbox.notifyOwner("⏰ Позвонить юристу", "job:5");
  const r = await call("GET", "/api/dwh/messages?limit=500");
  const ms = r.data.messages;
  assert.ok(ms.some((m) => m.channel === "web" && m.author === "owner" && m.text === "привет"));
  assert.ok(ms.some((m) => m.type === "proactive" && m.job_id === 5));
  assert.ok(ms.some((m) => m.type === "file"));
  assert.equal(r.data.stats.messages, ms.length);
  const found = await call("GET", "/api/dwh/messages?q=юристу");
  assert.ok(found.data.messages.length >= 2);
  // «забыть разговор» не трогает архив
  const before = r.data.stats.messages;
  await call("POST", "/api/chat/reset");
  assert.equal((await call("GET", "/api/dwh/messages")).data.stats.messages, before);
});
