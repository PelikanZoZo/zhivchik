// Сервер Живчика. Держит мир живым постоянно, сохраняет его и отдаёт страницу.
//
// Настройки — переменные окружения или файл .env рядом (см. .env.example).
// Без базы данных хранит всё в папке data/.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "./public/sim/world.js";
import { createStore } from "./src/store/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
const SAVE_EVERY = +(env.SAVE_EVERY_SEC || 30) * 1000;
const MAX_CATCHUP = +(env.MAX_CATCHUP_TICKS || 864000); // 12 часов при TPS=20
const CATCHUP_CHUNK = 2000;                               // тиков досчёта за один шаг таймера
const ADMIN_KEY = env.ADMIN_KEY || "";

// ---------- мир ----------
const store = createStore(env, ROOT);
let world;
let lastStep = Date.now();
let catchup = 0; // сколько тиков ещё досчитать после сна

async function boot() {
  const where = await store.init();
  const saved = await store.load();
  if (saved) {
    world = new World(saved.world);
    // Пока сервер спал (хостинг усыпил, перезапуск), мир должен был жить. Досчитываем частями,
    // не задерживая запуск: страница сразу открывается и видно, как мир «догоняет» время.
    catchup = Math.min(MAX_CATCHUP, Math.floor(((Date.now() - saved.savedAt) / 1000) * TPS));
    if (catchup > 0) world.note(`Сервер проснулся. Догоняю ${catchup} тиков пропущенной жизни.`);
  } else {
    world = new World();
  }
  console.log(`Живчик: мир на тике ${world.tick}, хранилище: ${where}`);
  await persist();
}

async function persist() {
  const lives = world.lives.splice(0);
  try {
    await store.recordLives(lives);
    await store.save(world.toJSON());
  } catch (e) {
    world.lives.unshift(...lives);
    console.error("Не удалось сохранить:", e.message);
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

async function readBody(req) {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 10000) throw new Error("слишком большой запрос"); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (!world) return send(res, 503, { error: "Мир ещё просыпается, обнови через секунду." });

    if (p === "/api/state") return send(res, 200, { mode: "server", tps: TPS, catchup, ...world.view() });
    if (p === "/api/details") return send(res, 200, { ...world.details(), locked: !!ADMIN_KEY });
    if (p === "/api/lives") return send(res, 200, await store.recentLives(Math.min(200, +(url.searchParams.get("limit") || 50))));
    if (p === "/api/action" && req.method === "POST") {
      const body = await readBody(req);
      if (ADMIN_KEY && body.key !== ADMIN_KEY) return send(res, 403, { error: "Нужен ключ управления. Его задаёт ADMIN_KEY в настройках сервера." });
      world.action(body.type, body);
      if (body.type === "reset") await persist();
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
setInterval(run, 1000 / TPS);
setInterval(persist, SAVE_EVERY);
server.listen(PORT, () => console.log(`Живчик слушает порт ${PORT}`));

async function shutdown() {
  console.log("Сохраняю мир перед остановкой…");
  await persist();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
