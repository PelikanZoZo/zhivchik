// Вход на сайт. Пользователь один — владелец. Пароль берётся из ADMIN_PASSWORD (секрет GitHub → .env на хостинге).
// После входа браузер получает подписанную куку на 60 дней. Ключ подписи выводится из секретов,
// поэтому сессия переживает перезапуски, а смена пароля выкидывает все старые входы.

import crypto from "node:crypto";

const COOKIE = "kira_session";
const DAYS = 60;

export function createAuth({ adminPassword, bridgeSecret }) {
  const key = crypto.createHash("sha256").update(`kira-session:${bridgeSecret}:${adminPassword}`).digest();
  const fails = new Map(); // ip → { n, until }

  function sign(payload) {
    return crypto.createHmac("sha256", key).update(payload).digest("base64url");
  }

  return {
    COOKIE,

    enabled: !!adminPassword,

    checkPassword(password) {
      return !!adminPassword && safeEqual(String(password ?? ""), adminPassword);
    },

    // Простая защита от перебора: после 5 ошибок подряд с одного адреса — пауза 10 минут
    blocked(ip) {
      const f = fails.get(ip);
      return !!(f && f.until > Date.now());
    },
    fail(ip) {
      const f = fails.get(ip) || { n: 0, until: 0 };
      f.n += 1;
      if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
      fails.set(ip, f);
    },
    success(ip) {
      fails.delete(ip);
    },

    issue() {
      const payload = `owner.${Date.now() + DAYS * 86400e3}`;
      return `${payload}.${sign(payload)}`;
    },

    verify(token) {
      if (!token || !adminPassword) return false;
      const i = token.lastIndexOf(".");
      if (i < 0) return false;
      const payload = token.slice(0, i);
      if (!safeEqual(token.slice(i + 1), sign(payload))) return false;
      const exp = +payload.split(".")[1];
      return exp > Date.now();
    },

    cookieHeader(token, secure) {
      return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? "; Secure" : ""}`;
    },

    clearHeader() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
  };
}

export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
