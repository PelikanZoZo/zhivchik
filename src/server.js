// Сервер Живчика. Запускается через app.js.
// Держит мир живым постоянно, сохраняет его и отдаёт страницу.
//
// Настройки — переменные окружения или файл .env рядом (см. .env.example).
// Без базы данных хранит всё в папке data/.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { World, VERSION } from "../public/sim/world.js";
import { createStore } from "./store/index.js";
import { createAuth, loginPage } from "./auth.js";

// Журнал: пишем в stderr — на хостинге он попадает в журнал ошибок, stdout там не сохраняется
const log = (...args) => console.error(`[живчик ${new Date().toISOString().slice(11, 19)} pid ${process.pid}]`, ...args);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

// ---------- настройки ----------
function loadDotEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();
const env = process.env;
const PORT = +(env.PORT || 3000);
const TPS = +(env.TPS || 20);                       // тиков жизни в секунду
const SAVE_EVERY = +(env.SAVE_EVERY_SEC || 5) * 1000; // часто: хостинг может остановить процесс в любой момент
const MAX_CATCHUP = +(env.MAX_CATCHUP_TICKS || 864000); // 12 часов при TPS=20
const CATCHUP_CHUNK = 2000;                               // тиков досчёта за один шаг таймера
const ADMIN_KEY = env.ADMIN_KEY || "";
const auth = createAuth(env);

// ---------- мир ----------
// Хостинг может запустить несколько копий приложения. Мир должен быть один, поэтому
// копии договариваются через базу: одна — «хозяин» (считает жизнь, сохраняет, публикует
// картинку мира), остальные — «зрители» (показывают опубликованное и передают команды хозяину).
// Если хозяин пропал, его место занимает другая копия.
const store = createStore(env, ROOT);
let world = null;        // есть только у хозяина
let live = null;         // у зрителя: последняя картинка от хозяина { view, details }
let leader = false;
let lastStep = Date.now();
let catchup = 0;         // сколько тиков ещё досчитать после сна
const timers = [];

async function boot() {
  const where = await store.init();
  log(`запуск, хранилище: ${where}`);
  if (await store.tryLead()) await becomeLeader();
  else becomeViewer();
}

async function becomeLeader() {
  timers.splice(0).forEach(clearInterval);
  leader = true;
  const saved = await store.load();
  if (saved && saved.world?.version === VERSION) {
    world = new World(saved.world);
    log(`загрузил мир: тик ${world.tick}, агентов ${world.agents.length}, сохранён ${Math.round((Date.now() - saved.savedAt) / 1000)} с назад`);
    // Пока никто не считал мир (хостинг усыпил, перезапуск), он должен был жить. Досчитываем частями,
    // не задерживая запуск: страница сразу открывается и видно, как мир «догоняет» время.
    catchup = Math.min(MAX_CATCHUP, Math.floor(((Date.now() - saved.savedAt) / 1000) * TPS));
    if (catchup > 0) world.note(`Мир проснулся. Догоняю ${catchup} тиков пропущенной жизни.`);
  } else {
    world = new World();
    log(saved ? `НОВЫЙ МИР: сохранение другой версии (${saved.world?.version})` : "НОВЫЙ МИР: сохранения нет");
  }
  lastStep = Date.now();
  log(`я хозяин мира, тик ${world.tick}, догоняю ${catchup} тиков`);
  await persist();
  timers.push(
    setInterval(run, 1000 / TPS),
    setInterval(persist, SAVE_EVERY),
    setInterval(publish, 200),
    setInterval(applyCommands, 500),
    setInterval(async () => {
      if (!(await store.stillLeader())) { log("потерял роль хозяина, выхожу"); process.exit(0); }
    }, 30000),
  );
}

function becomeViewer() {
  log("я зритель");
  let busy = false;
  timers.push(
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { live = (await store.readLive()) || live; } catch {}
      busy = false;
    }, 200),
    setInterval(async () => {
      try { if (await store.tryLead()) await becomeLeader(); } catch {}
    }, 5000),
  );
}

function stateView() {
  return { mode: "server", tps: TPS, catchup, ...world.view() };
}
function detailsView() {
  return { ...world.details(), locked: !!ADMIN_KEY };
}

let publishing = false;
async function publish() {
  if (publishing) return;
  publishing = true;
  try { await store.writeLive(world.tick, { view: stateView(), details: detailsView() }); } catch {}
  publishing = false;
}

async function applyCommands() {
  try {
    for (const c of await store.takeCommands()) {
      try { world.action(c.type, c); if (c.type === "reset") await persist(); } catch (e) { console.error("Команда не выполнена:", e.message); }
    }
  } catch {}
}

async function persist() {
  if (!leader || !world) return;
  const lives = world.lives.splice(0);
  try {
    await store.recordLives(lives);
    await store.save(world.toJSON());
  } catch (e) {
    world.lives.unshift(...lives);
    log("не удалось сохранить:", e.message);
  }
}

function run() {
  // Считаем по реальному времени: если таймер запоздал, догоняем, но не больше секунды за раз
  const now = Date.now();
  if (catchup > 0) {
    const n = Math.min(catchup, CATCHUP_CHUNK);
    for (let i = 0; i < n; i++) world.step();
    catchup -= n;
    if (!catchup) world.note("Пропущенная жизнь досчитана.");
  }
  let due = Math.min(TPS, Math.floor(((now - lastStep) / 1000) * TPS));
  if (due > 0) {
    lastStep += (due / TPS) * 1000;
    while (due-- > 0) world.step();
  }
  if (now - lastStep > 1000) lastStep = now;
}

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (chunk) => { s += chunk; if (s.length > 10000) reject(new Error("слишком большой запрос")); });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
async function readBody(req) {
  const s = await readRaw(req);
  return s ? JSON.parse(s) : {};
}
function redirect(res, to, cookie) {
  const h = { Location: to, "Cache-Control": "no-store" };
  if (cookie) h["Set-Cookie"] = cookie;
  res.writeHead(303, h);
  res.end();
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

// Хостинг (masterhost) запускает Node.js через NGINX Unit. Unit принимает только приложения,
// созданные через его модуль unit-http. Если модуль есть — работаем через него, иначе обычный http.
let createServer = http.createServer, underUnit = false;
try {
  createServer = createRequire(import.meta.url)("unit-http").createServer;
  underUnit = true;
} catch {}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    // ---- вход ----
    if (p === "/login" && req.method === "POST") {
      const form = new URLSearchParams(await readRaw(req));
      const r = auth.login(clientIp(req), form.get("username") || "", form.get("password") || "");
      if (!r.ok) return send(res, 401, loginPage(r.error), "text/html; charset=utf-8");
      return redirect(res, "/", auth.cookie(isHttps(req)));
    }
    if (p === "/logout") return redirect(res, "/login", auth.clearCookie());
    if (!auth.isLoggedIn(req)) {
      if (p.startsWith("/api/")) return send(res, 401, { error: "Нужно войти" });
      if (p === "/login") return send(res, 200, loginPage(), "text/html; charset=utf-8");
      return redirect(res, "/login");
    }
    if (p === "/login") return redirect(res, "/");

    if (p.startsWith("/api/") && !world && !live) return send(res, 503, { error: "Мир ещё просыпается, обнови через секунду." });

    if (p === "/api/state") return send(res, 200, world ? stateView() : live.view);
    if (p === "/api/details") return send(res, 200, world ? detailsView() : live.details);
    if (p === "/api/lives") return send(res, 200, await store.recentLives(Math.min(200, +(url.searchParams.get("limit") || 50))));
    if (p === "/api/action" && req.method === "POST") {
      const body = await readBody(req);
      if (ADMIN_KEY && body.key !== ADMIN_KEY) return send(res, 403, { error: "Нужен ключ управления. Его задаёт ADMIN_KEY в настройках сервера." });
      if (world) {
        world.action(body.type, body);
        if (body.type === "reset") await persist();
      } else {
        const { key, ...cmd } = body;
        await store.pushCommand(cmd); // хозяин выполнит в течение полсекунды
      }
      return send(res, 200, { ok: true });
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "Нет такого адреса" });

    // статические файлы из public/
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC)) return send(res, 403, "нет доступа", "text/plain; charset=utf-8");
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) return send(res, 404, "Не найдено", "text/plain; charset=utf-8");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

await boot();
if (underUnit) {
  server.listen();
  console.log("Живчик работает через NGINX Unit");
} else {
  server.listen(PORT, () => console.log(`Живчик слушает порт ${PORT}`));
}

// Самоперезапуск после выкладки: выкладка меняет tmp/restart.txt. Заметив это,
// сохраняем мир и выходим — хостинг сам поднимет процесс уже с новым кодом.
const RESTART_FILE = path.join(ROOT, "tmp", "restart.txt");
const mtime = () => { try { return fs.statSync(RESTART_FILE).mtimeMs; } catch { return 0; } };
const startedWith = mtime();
setInterval(async () => {
  if (mtime() !== startedWith) {
    log("выложена новая версия, сохраняю и выхожу");
    await persist();
    process.exit(0);
  }
}, 10000);

async function shutdown() {
  log(`остановка (${leader ? "хозяин, тик " + world?.tick : "зритель"}), сохраняю`);
  await persist();
  await store.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
