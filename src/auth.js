// Вход на сайт. Один пользователь.
//
// Пароль нигде не хранится — только его отпечаток scrypt (по нему пароль не восстановить).
// Логин и отпечаток можно переопределить переменными окружения AUTH_USER и AUTH_HASH.
// Новый отпечаток: node tools/hash-password.js 'новый пароль'
//
// После входа браузер получает подписанную куку на 30 дней.

import crypto from "node:crypto";

const DEFAULT_USER = "bystrde";
const DEFAULT_HASH = "scrypt$32768$JmsS64tvRdWMGlWwZ6/jTw==$vdXk1fIGGUPcXh9VmyaUNYCSv1mv2pMUEuH6NBG3Azwcg/WvHy7x9aSe/g2dffbkh4wJqTO+4xbpcTf5Fq/ieg==";

const COOKIE = "zh_session";
const SESSION_DAYS = 30;

export function createAuth(env) {
  const user = env.AUTH_USER || DEFAULT_USER;
  const stored = env.AUTH_HASH || DEFAULT_HASH;

  // Ключ подписи сессий должен быть секретным и одинаковым между перезапусками,
  // иначе после каждого сна сервера придётся входить заново.
  // Берём SESSION_SECRET, а если его нет — пароль базы (он есть только в настройках хостинга).
  const secretSource = env.SESSION_SECRET || env.DBPASS || env.DB_PASSWORD;
  const key = secretSource
    ? crypto.createHash("sha256").update("zhivchik-session:" + secretSource + stored).digest()
    : crypto.randomBytes(32);
  if (!secretSource) console.warn("Нет SESSION_SECRET: после перезапуска сервера придётся входить заново.");

  function checkPassword(password) {
    const [alg, n, salt, hash] = stored.split("$");
    if (alg !== "scrypt") return false;
    const N = +n, expected = Buffer.from(hash, "base64");
    const got = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
    return crypto.timingSafeEqual(got, expected);
  }

  function sign(payload) {
    return crypto.createHmac("sha256", key).update(payload).digest("base64url");
  }

  function issue() {
    const payload = `${user}.${Date.now() + SESSION_DAYS * 86400e3}`;
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (!token) return false;
    const i = token.lastIndexOf(".");
    if (i < 0) return false;
    const payload = token.slice(0, i), sig = token.slice(i + 1);
    const good = sign(payload);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
    const [u, exp] = payload.split(".");
    return u === user && +exp > Date.now();
  }

  // Защита от перебора: не больше 5 попыток в 10 минут с одного адреса
  const attempts = new Map();
  function allowAttempt(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60e3);
    attempts.set(ip, list);
    if (list.length >= 5) return false;
    list.push(now);
    return true;
  }

  return {
    isLoggedIn(req) {
      const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
      return verify(m && decodeURIComponent(m[1]));
    },
    login(ip, name, password) {
      if (!allowAttempt(ip)) return { ok: false, error: "Слишком много попыток. Подожди 10 минут." };
      const ok = name === user && checkPassword(password);
      if (!ok) return { ok: false, error: "Неверный логин или пароль." };
      attempts.delete(ip);
      return { ok: true };
    },
    cookie(secure) {
      return `${COOKIE}=${encodeURIComponent(issue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
    },
    clearCookie() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
  };
}

export function loginPage(error = "") {
  const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Вход</title>
<style>
  :root { --blue: #1f4fd1; --blue-deep: #163a9e; --ink: #0f1e45; --line: #c9d5f5; --bad: #c22f3a; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 16px;
    background: linear-gradient(160deg, var(--blue) 0%, var(--blue-deep) 100%);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
  }
  form { width: 100%; max-width: 340px; background: #fff; border-radius: 14px; padding: 28px 24px; display: grid; gap: 14px; box-shadow: 0 20px 50px rgba(5, 20, 70, .35); }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  label { display: grid; gap: 6px; font-size: 13px; color: #44527a; }
  input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: #fff; }
  input:focus { outline: 2px solid var(--blue); outline-offset: 1px; border-color: var(--blue); }
  button { font: inherit; font-weight: 600; padding: 11px; border: 0; border-radius: 8px; background: var(--blue); color: #fff; cursor: pointer; }
  button:hover { background: var(--blue-deep); }
  button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .error { margin: 0; color: var(--bad); font-size: 13px; }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Вход</h1>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <label for="username">Логин<input id="username" name="username" autocomplete="username" required autofocus></label>
    <label for="password">Пароль<input id="password" name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Войти</button>
  </form>
</body>
</html>`;
}
