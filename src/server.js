// Сервер Киры. Запускается через app.js.
//
//   /                  — веб-интерфейс (public/)
//   /api/...           — API для веб-интерфейса (нужен вход по паролю)
//   /api/bridge/...    — мост для Cloudflare Worker'а (проверяется общий ключ BRIDGE_SECRET)
//   /api/health        — жив ли сайт и база
//
// Хостинг может запускать несколько копий приложения и усыплять их — поэтому всё состояние
// хранится в базе, а в памяти процесса ничего важного нет.

import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, loadDotEnv, readConfig } from "./config.js";
import { openDb } from "./db.js";
import { Nodes, ValidationError } from "./nodes.js";
import { createAuth, parseCookies, safeEqual } from "./auth.js";
import { createDeepSeek } from "./ai/deepseek.js";
import { createAgent } from "./ai/agent.js";
import { createBot } from "./bot.js";
import { JobsModel } from "./jobs/model.js";
import { createRunner, ensureSystemJobs, getMorningTime, setMorningTime } from "./jobs/runner.js";
import { createOutbox } from "./outbox.js";
import { TYPES, CORE, SECTIONS, PERSON_ROLES } from "./pm/schema.js";
import { createRiskAssessor } from "./pm/risk-ai.js";
import { createFiles } from "./pm/files.js";

export const VERSION = "0.1.0";

// Журнал: в stderr — на хостинге он попадает в журнал ошибок сайта
const log = (...args) => console.error(`[кира ${new Date().toISOString().slice(11, 19)} ${process.pid}]`, ...args);

const PUBLIC = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function createApp(cfg, { llm: llmOverride, dbOverride } = {}) {
  const auth = createAuth(cfg);
  const llm = llmOverride || createDeepSeek(cfg.deepseek);
  let ready = null; // промис готовности: база открыта и обновлена

  async function services() {
    if (!ready) {
      ready = (async () => {
        const db = dbOverride || (await openDb(cfg.db));
        const v = await db.migrate();
        log(`база готова, схема v${v}`);
        const nodes = new Nodes(db, cfg.tz);
        const jobs = new JobsModel(db, cfg.tz);
        const outbox = createOutbox({ db });
        const deps = {};
        const agent = createAgent({ db, nodes, jobs, outbox, deps, llm, tz: cfg.tz, name: cfg.assistantName, log });
        const runner = createRunner({ jobs, agent, outbox, log });
        deps.runner = runner;
        await ensureSystemJobs({ jobs, db, cfg });
        const bot = createBot({ db, agent, nodes, jobs, runner, cfg, log });
        const riskAi = createRiskAssessor({ db, nodes, llm, tz: cfg.tz, log });
        deps.riskAi = riskAi;
        const files = createFiles(cfg.filesDir || path.join(ROOT, "..", "files"));
        return { db, nodes, jobs, outbox, runner, agent, bot, riskAi, files };
      })().catch((e) => {
        ready = null; // следующая попытка — при следующем запросе
        throw e;
      });
    }
    return ready;
  }

  // ---------- маршруты ----------
  const routes = [];
  const route = (method, pattern, handler, access = "user", opts = {}) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, handler, access, opts });
  };

  route("GET", "/api/health", async () => {
    try {
      const { db } = await services();
      await db.query("SELECT 1");
      return { ok: true, db: true, version: VERSION };
    } catch (e) {
      log("health: база недоступна:", e.message);
      return { ok: false, db: false, version: VERSION, error: "База недоступна" };
    }
  }, "public");

  // --- вход ---
  route("POST", "/api/login", async ({ body, ip, res, secure }) => {
    if (!auth.enabled) throw httpError(503, "Пароль не настроен (ADMIN_PASSWORD)");
    if (auth.blocked(ip)) throw httpError(429, "Слишком много попыток, подожди 10 минут");
    await new Promise((r) => setTimeout(r, 300));
    if (!auth.checkPassword(body.password)) {
      auth.fail(ip);
      throw httpError(401, "Неверный пароль");
    }
    auth.success(ip);
    res.setHeader("Set-Cookie", auth.cookieHeader(auth.issue(), secure));
    return { ok: true };
  }, "public");

  route("POST", "/api/logout", async ({ res }) => {
    res.setHeader("Set-Cookie", auth.clearHeader());
    return { ok: true };
  }, "public");

  route("GET", "/api/me", async ({ user }) => ({ loggedIn: user, name: cfg.assistantName, tz: cfg.tz }), "public");

  // --- записи ---
  route("GET", "/api/items", async ({ query }) => {
    const { nodes } = await services();
    const f = {
      kind: query.kind || undefined,
      kinds: query.kinds ? query.kinds.split(",") : undefined,
      status: query.status ? query.status.split(",") : undefined,
      parent_id: query.parent_id ? +query.parent_id : undefined,
      stage_id: query.stage_id ? +query.stage_id : undefined,
      root: query.root === "1",
      query: query.q || undefined,
      tag: query.tag || undefined,
      order: query.order || "smart",
      limit: query.limit ? +query.limit : 300,
      include_deleted: query.deleted === "1",
    };
    if (query.open === "1") f.open = true;
    if (query.open === "0") f.open = false;
    return { items: await nodes.list(f) };
  });

  route("GET", "/api/overview", async ({ query }) => {
    const { nodes } = await services();
    const open = query.open === "1" ? true : query.open === "0" ? false : undefined;
    return { items: await nodes.overview({ kinds: query.kinds ? query.kinds.split(",") : undefined, open }) };
  });

  route("GET", "/api/schema", async () => ({ types: TYPES, core: CORE, sections: SECTIONS, person_roles: PERSON_ROLES }));

  route("GET", "/api/items/:id", async ({ params }) => {
    const { nodes } = await services();
    const item = await nodes.get(+params.id, { full: true });
    if (!item) throw httpError(404, "Нет такой записи");
    await nodes.withHomes([item]);
    return { item };
  });

  // Связи: человек с ролью, блокер → что блокирует, «связано»
  route("POST", "/api/items/:id/links", async ({ params, body }) => {
    const { nodes } = await services();
    return await nodes.link(+params.id, +body.other_id, body.role, "web", body.note || null);
  });

  route("DELETE", "/api/links/:id", async ({ params }) => {
    const { nodes } = await services();
    return await nodes.unlink(+params.id, "web");
  });

  route("POST", "/api/items/:id/comments", async ({ params, body }) => {
    const { nodes } = await services();
    return await nodes.addComment(+params.id, body.text, "owner");
  });

  route("DELETE", "/api/comments/:id", async ({ params }) => {
    const { nodes } = await services();
    return await nodes.removeComment(+params.id);
  });

  // Загрузка файла: тело запроса — сам файл, имя — в заголовке X-File-Name (в кодировке URI)
  route("POST", "/api/items/:id/upload", async ({ params, req }) => {
    const { nodes, files } = await services();
    const parent = await nodes.get(+params.id);
    if (!parent) throw httpError(404, "Нет такой записи");
    const name = decodeURIComponent(String(req.headers["x-file-name"] || "файл")).slice(0, 200);
    const saved = await files.save(req, name);
    const item = await nodes.create({
      kind: "attachment", title: name, parent_id: parent.id,
      fields: { file_name: name, file_size: saved.size, file_type: String(req.headers["content-type"] || "").slice(0, 100), file_key: saved.key },
      allowSystemFields: true,
    }, "web");
    return { item };
  }, "user", { raw: true });

  route("GET", "/api/files/:id", async ({ params, res, query }) => {
    const { nodes, files } = await services();
    const item = await nodes.get(+params.id);
    if (!item || item.kind !== "attachment" || !item.fields.file_key) throw httpError(404, "Нет такого файла");
    const file = files.resolve(item.fields.file_key);
    if (!file) throw httpError(404, "Файл не найден на диске");
    const type = item.fields.file_type || "application/octet-stream";
    const inline = query.inline === "1" && /^(image\/|application\/pdf|text\/plain)/.test(type);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": item.fields.file_size,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.fields.file_name || "file")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    });
    await new Promise((resolve, reject) => fsSync.createReadStream(file).on("error", reject).on("end", resolve).pipe(res));
    return undefined;
  });

  route("POST", "/api/items/:id/assess", async ({ params }) => {
    const { riskAi } = await services();
    return { item: await riskAi.assess(+params.id) };
  });

  route("POST", "/api/items", async ({ body }) => {
    const { nodes } = await services();
    return { item: await nodes.create(body, "web") };
  });

  route("PATCH", "/api/items/:id", async ({ params, body }) => {
    const { nodes } = await services();
    return { item: await nodes.update(+params.id, body, "web") };
  });

  route("DELETE", "/api/items/:id", async ({ params }) => {
    const { nodes } = await services();
    return await nodes.remove(+params.id, "web");
  });

  route("POST", "/api/items/:id/restore", async ({ params }) => {
    const { nodes } = await services();
    return { item: await nodes.restore(+params.id, "web") };
  });

  route("GET", "/api/items/:id/history", async ({ params }) => {
    const { nodes } = await services();
    return { history: await nodes.history(+params.id, 200) };
  });

  route("GET", "/api/agenda", async ({ query }) => {
    const { nodes } = await services();
    return await nodes.agenda({ days: +query.days || 7 });
  });

  route("GET", "/api/changes", async ({ query }) => {
    const { nodes } = await services();
    const days = Math.min(+query.days || 7, 90);
    return { changes: await nodes.changes({ since: new Date(Date.now() - days * 86400e3), limit: 300, root: query.root ? +query.root : undefined }) };
  });

  // --- ассистент на сайте ---
  route("GET", "/api/chat", async () => {
    const { db } = await services();
    const rows = await db.query(
      "SELECT id, role, content, created_at FROM messages WHERE channel = 'web' ORDER BY id DESC LIMIT 60",
    );
    const out = [];
    for (const r of rows) {
      if (r.role === "reset") break;
      if (r.role === "user" || r.role === "assistant") out.unshift({ id: r.id, role: r.role, text: r.content, at: r.created_at });
    }
    return { messages: out };
  });

  route("POST", "/api/chat", async ({ body }) => {
    const { agent } = await services();
    const text = String(body.text || "").trim();
    if (!text) throw httpError(400, "Пустое сообщение");
    const r = await agent.ask(text.slice(0, 8000), { channel: "web", source: "ai", smart: !!body.smart });
    return { text: r.text, tools: r.tools };
  });

  route("POST", "/api/chat/reset", async () => {
    const { agent } = await services();
    await agent.reset("web");
    return { ok: true };
  });

  route("GET", "/api/bot", async () => {
    const { db } = await services();
    const own = await db.get("owner", null);
    return {
      owner: own ? { name: own.name, username: own.username, since: own.since } : null,
      morning_time: await getMorningTime(await services()),
    };
  });

  route("PATCH", "/api/bot", async ({ body }) => {
    const svc = await services();
    const { db } = svc;
    if (body.morning_time !== undefined) {
      const t = String(body.morning_time);
      if (t !== "off" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw httpError(400, "Время в формате ЧЧ:ММ или off");
      await setMorningTime(svc, t, "web");
    }
    if (body.unlink_owner) await db.query("DELETE FROM kv WHERE k = 'owner'");
    return { ok: true };
  });

  // --- мост для Cloudflare Worker'а ---
  route("POST", "/api/bridge/update", async ({ body }) => {
    const { bot } = await services();
    return { actions: await bot.handle(body) };
  }, "bridge");

  // Раз в минуту: выполнить задания, которым подошло время, и отдать сообщения для отправки
  route("GET", "/api/bridge/outbox", async () => {
    const { runner, outbox } = await services();
    const { riskAi } = await services();
    try {
      await runner.runDue({ budgetMs: 45000 });
    } catch (e) {
      log("планировщик:", e.message);
    }
    try {
      await riskAi.runPending();
    } catch (e) {
      log("оценка рисков:", e.message);
    }
    return { items: await outbox.pending() };
  }, "bridge");

  route("POST", "/api/bridge/ack", async ({ body }) => {
    const { outbox } = await services();
    return { acked: await outbox.ack(body.ids) };
  }, "bridge");

  // --- задания Киры ---
  route("GET", "/api/jobs", async ({ query }) => {
    const { jobs } = await services();
    const status = query.status && query.status !== "all" ? query.status.split(",") : undefined;
    return { jobs: await jobs.list({ status, limit: +query.limit || 300 }) };
  });

  route("GET", "/api/jobs/:id", async ({ params }) => {
    const { jobs } = await services();
    const job = await jobs.get(+params.id);
    if (!job) throw httpError(404, "Нет такого задания");
    return { job, runs: await jobs.runs(+params.id, 50), history: await jobs.history(+params.id) };
  });

  route("POST", "/api/jobs", async ({ body }) => {
    const { jobs } = await services();
    return { job: await jobs.create({ ...body, created_by: "owner" }, "web") };
  });

  route("PATCH", "/api/jobs/:id", async ({ params, body }) => {
    const { jobs } = await services();
    const job = await jobs.get(+params.id);
    if (!job) throw httpError(404, "Нет такого задания");
    if (job.system && (body.action !== undefined || body.instruction !== undefined || body.title !== undefined)) {
      throw httpError(400, "У системного задания можно менять только расписание и статус");
    }
    return { job: await jobs.update(+params.id, body, "web") };
  });

  route("POST", "/api/jobs/:id/run", async ({ params }) => {
    const { runner, jobs } = await services();
    try {
      const r = await runner.runNow(+params.id);
      return { result: r, job: await jobs.get(+params.id) };
    } catch (e) {
      throw httpError(400, e.message);
    }
  });

  // ---------- обработка запроса ----------
  async function handler(req, res) {
    const url = new URL(req.url, "http://x");
    const started = Date.now();
    try {
      if (url.pathname.startsWith("/api/")) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw httpError(404, "Нет такого адреса");
        const m = url.pathname.match(r.re);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const cookies = parseCookies(req.headers.cookie);
        const user = auth.verify(cookies[auth.COOKIE]);
        if (r.access === "user" && !user) throw httpError(401, "Нужно войти");
        if (r.access === "bridge") {
          const key = req.headers["x-bridge-secret"] || "";
          if (!cfg.bridgeSecret || !safeEqual(key, cfg.bridgeSecret)) throw httpError(403, "Нет доступа");
        }
        if (r.access === "user" && req.method !== "GET" && !sameOrigin(req)) throw httpError(403, "Запрос с чужого сайта");
        const body = !r.opts.raw && ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readJson(req) : {};
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        const secure = req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;
        const out = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, user, ip, secure });
        if (out !== undefined) send(res, 200, out);
        if (r.access === "bridge") log(`${req.method} ${url.pathname} ${Date.now() - started} мс`);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (e) {
      const status = e.status || (e instanceof ValidationError ? 400 : 500);
      if (status >= 500) log(`${req.method} ${url.pathname}:`, e.stack || e.message);
      send(res, status, { error: status >= 500 && !e.expose ? "Внутренняя ошибка" : e.message });
    }
  }

  return { handler, services };
}

// ---------- помощники ----------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw httpError(413, "Слишком большой запрос");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Тело запроса — не JSON");
  }
}

async function serveStatic(pathname, res) {
  // Отдаём только файлы из public/, никаких выходов наружу (.env и код не видны)
  let rel = decodeURIComponent(pathname).replace(/\\/g, "/");
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  const inside = file.startsWith(PUBLIC + path.sep);
  let data;
  let target = file;
  if (inside && !path.basename(file).startsWith(".")) data = await fs.readFile(file).catch(() => null);
  if (!data) {
    // Адреса интерфейса (/project/5 и т.п.) — отдаём приложение
    if (path.extname(rel)) { send(res, 404, { error: "Нет такого файла" }); return; }
    target = path.join(PUBLIC, "index.html");
    data = await fs.readFile(target);
  }
  const ext = path.extname(target);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  res.end(data);
}

// ---------- запуск (если файл запущен как приложение) ----------
const isMain = process.argv[1] && /app\.js$|server\.js$/.test(process.argv[1]);
if (isMain && !process.env.KIRA_NO_LISTEN) {
  loadDotEnv();
  const cfg = readConfig();
  const app = createApp(cfg);

  // Masterhost запускает Node.js через NGINX Unit: он принимает только сервер из модуля unit-http,
  // который слушает не порт, а сам Unit. Если модуля нет (локально) — обычный http на порту.
  let server;
  try {
    const unit = createRequire(import.meta.url)("unit-http");
    server = unit.createServer(app.handler);
    server.listen();
    log(`работаю через NGINX Unit, версия ${VERSION}`);
  } catch {
    server = http.createServer(app.handler);
    server.listen(cfg.port, () => log(`слушаю порт ${cfg.port}, версия ${VERSION}`));
  }
  app.services().catch((e) => log("база пока недоступна:", e.message));

  // Выкладка меняет tmp/restart.txt — заметив это, процесс выходит, и хостинг поднимает его уже с новым кодом
  const restartFile = path.join(ROOT, "tmp", "restart.txt");
  const mtime = () => { try { return fsSync.statSync(restartFile).mtimeMs; } catch { return 0; } };
  const startedWith = mtime();
  setInterval(() => {
    if (mtime() !== startedWith) {
      log("выложена новая версия, перезапускаюсь");
      process.exit(0);
    }
  }, 10000).unref();
}
