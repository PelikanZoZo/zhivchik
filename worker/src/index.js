// Cloudflare Worker — мост между Telegram и сайтом.
//
// Зачем: с хостинга Telegram напрямую недоступен, а Cloudflare до него достаёт без проблем.
//
//   Telegram ──вебхук──▶ Worker ──▶ сайт /api/bridge/update ──▶ ответ: список действий ──▶ Worker выполняет в Telegram
//   Раз в минуту:        Worker ──▶ сайт /api/bridge/outbox  ──▶ что отправить самому (утренний план) ──▶ Telegram
//
// Сайт и Worker проверяют друг друга общим ключом BRIDGE_SECRET.
// Telegram подписывает вебхуки ключом TG_WEBHOOK_SECRET — чужие запросы отбрасываются.
//
// Секреты Worker'а: TELEGRAM_BOT_TOKEN, BRIDGE_SECRET, TG_WEBHOOK_SECRET. Переменная: SITE_URL.

const ALLOWED = new Set(["sendMessage", "deleteMessage", "sendChatAction", "editMessageText", "answerCallbackQuery"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/telegram" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.TG_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad request", { status: 400 });

    const chatId = update.message?.chat?.id;
    if (chatId && update.message.text && !update.message.text.startsWith("/start")) {
      ctx.waitUntil(tg(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}));
    }

    let res;
    try {
      res = await site(env, "POST", "/api/bridge/update", update);
    } catch (e) {
      console.log("сайт не ответил:", e.message);
      // 500 — Telegram пришлёт это сообщение ещё раз позже; сайт не обработает его дважды
      return new Response("Site unavailable", { status: 500 });
    }
    await run(env, res.actions || []);
    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliverOutbox(env));
  },
};

async function deliverOutbox(env) {
  let data;
  try {
    data = await site(env, "GET", "/api/bridge/outbox");
  } catch (e) {
    console.log("очередь недоступна:", e.message);
    return;
  }
  const done = [];
  for (const item of data.items || []) {
    const ok = await run(env, item.actions || []);
    if (ok) done.push(item.id);
  }
  if (done.length) await site(env, "POST", "/api/bridge/ack", { ids: done }).catch((e) => console.log("ack:", e.message));
}

// Выполнить действия по порядку. Возвращает true, если все обязательные прошли.
async function run(env, actions) {
  let allOk = true;
  for (const a of actions) {
    if (!ALLOWED.has(a.method)) { console.log("неразрешённое действие:", a.method); continue; }
    let r = await tg(env, a.method, a.params);
    if (!r.ok && a.method === "sendMessage" && a.fallback_text && r.error_code === 400) {
      // Telegram не принял разметку — отправляем простым текстом
      const { parse_mode, text, ...rest } = a.params;
      r = await tg(env, "sendMessage", { ...rest, text: a.fallback_text });
    }
    if (!r.ok && !a.optional) {
      allOk = false;
      console.log(`telegram ${a.method}: ${r.error_code} ${r.description}`);
    }
  }
  return allOk;
}

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json().catch(() => ({ ok: false, error_code: res.status, description: "не JSON" }));
}

async function site(env, method, path, body) {
  const res = await fetch(env.SITE_URL.replace(/\/$/, "") + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": env.BRIDGE_SECRET, "User-Agent": "kira-bridge" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
