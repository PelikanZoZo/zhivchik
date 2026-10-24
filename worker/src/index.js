// Cloudflare Worker — мост между Telegram и сайтом.
//
// Зачем: с хостинга Telegram напрямую недоступен, а Cloudflare до него достаёт без проблем.
//
//   Telegram ──вебхук──▶ Worker ──▶ сайт /api/bridge/update ──▶ ответ: список действий ──▶ Worker выполняет в Telegram
//   Раз в минуту:        Worker ──▶ сайт /api/bridge/outbox  ──▶ что отправить самому (утренний план) ──▶ Telegram
//
// Файлы: если в сообщении документ, голосовое, аудио, фото или видео, Worker сначала скачивает его
// из Telegram и передаёт на сайт кусками (/api/bridge/upload). Голосовые и аудио распознаёт
// Workers AI (Whisper) — сайт получает и файл, и расшифровку (update.kira_file).
// Отправка файлов владельцу: по file_id Telegram, а если его нет — Worker берёт файл с сайта.
//
// Сайт и Worker проверяют друг друга общим ключом BRIDGE_SECRET.
// Telegram подписывает вебхуки ключом TG_WEBHOOK_SECRET — чужие запросы отбрасываются.
//
// Секреты Worker'а: TELEGRAM_BOT_TOKEN, BRIDGE_SECRET, TG_WEBHOOK_SECRET. Переменная: SITE_URL. Привязка: AI.

const ALLOWED = new Set([
  "sendMessage", "deleteMessage", "sendChatAction", "editMessageText", "answerCallbackQuery",
  "sendDocument", "sendVoice", "sendAudio", "sendPhoto", "sendVideo", "sendVideoNote",
]);
const CHUNK = 4 * 1024 * 1024; // хостинг принимает запросы до ~8 МБ
const TG_MAX = 20 * 1024 * 1024; // больше Telegram не даёт боту скачать
const WHISPER_MAX = 25 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    // Самопроверка распознавания (для выкладки): POST аудио, ключ моста в заголовке
    if (url.pathname === "/selftest/whisper" && request.method === "POST") {
      if (!env.BRIDGE_SECRET || request.headers.get("X-Bridge-Secret") !== env.BRIDGE_SECRET) return new Response("Forbidden", { status: 403 });
      const started = Date.now();
      try {
        const text = await transcribe(env, new Uint8Array(await request.arrayBuffer()));
        return Response.json({ ok: true, text, ms: Date.now() - started });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e), ms: Date.now() - started });
      }
    }
    if (url.pathname !== "/telegram" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.TG_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad request", { status: 400 });

    const msg = update.message;
    const chatId = msg?.chat?.id;
    const media = msg && pickMedia(msg);
    if (chatId && ((msg.text && !msg.text.startsWith("/start")) || media)) {
      ctx.waitUntil(tg(env, "sendChatAction", { chat_id: chatId, action: media?.spoken ? "record_voice" : media ? "upload_document" : "typing" }).catch(() => {}));
    }

    if (media && msg.chat.type === "private") {
      try {
        update.kira_file = await fetchMedia(env, media);
      } catch (e) {
        console.log("файл:", e.message);
        update.kira_file = { error: e.message };
      }
      if (chatId) ctx.waitUntil(tg(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}));
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

// ---------- файлы из Telegram ----------

function pickMedia(msg) {
  const m = msg.voice || msg.audio || msg.video_note || msg.video || msg.document
    || (msg.photo?.length ? msg.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a)) : null);
  if (!m) return null;
  const mime = m.mime_type || (msg.photo ? "image/jpeg" : msg.video_note ? "video/mp4" : "");
  const spoken = !!(msg.voice || msg.audio || msg.video_note || msg.video) || /^audio\//.test(mime);
  return { file_id: m.file_id, size: m.file_size || 0, name: m.file_name || "", mime, spoken };
}

async function fetchMedia(env, media) {
  if (media.size > TG_MAX) return { error: "file is too big (больше 20 МБ)" };
  const info = await tg(env, "getFile", { file_id: media.file_id });
  if (!info.ok) return { error: `getFile: ${info.description || info.error_code}` };
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`);
  if (!res.ok) return { error: `скачивание: HTTP ${res.status}` };
  const buf = new Uint8Array(await res.arrayBuffer());
  const out = {};

  // Сначала — на сайт (кусками)
  try {
    Object.assign(out, await uploadToSite(env, buf, media.name || info.result.file_path.split("/").pop() || "file", media.mime));
  } catch (e) {
    out.error = `на сайт не загрузился: ${e.message}`;
  }

  // Речь → текст
  if (media.spoken && env.AI) {
    if (buf.length > WHISPER_MAX) out.transcribe_error = "запись слишком длинная для распознавания";
    else {
      try {
        out.transcript = await transcribe(env, buf);
        if (!out.transcript) out.transcribe_error = "речь не распознана";
      } catch (e) {
        out.transcribe_error = String(e.message || e).slice(0, 200);
        console.log("распознавание:", out.transcribe_error);
      }
    }
  }
  return out;
}

async function uploadToSite(env, buf, name, mime) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  let last;
  for (let i = 0; i < total; i++) {
    const part = buf.subarray(i * CHUNK, Math.min(buf.length, (i + 1) * CHUNK));
    let attempt = 0;
    for (;;) {
      try {
        last = await site(env, "POST", "/api/bridge/upload", part, {
          "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Chunk": String(i), "X-Chunks": String(total),
          "X-File-Name": encodeURIComponent(name), "X-File-Type": encodeURIComponent(mime || ""),
        });
        break;
      } catch (e) {
        if (++attempt >= 3) throw e;
      }
    }
  }
  if (!last?.done) throw new Error("сайт не подтвердил файл");
  return { key: last.key, size: last.size, sha256: last.sha256 };
}

async function transcribe(env, buf) {
  try {
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(buf), task: "transcribe", vad_filter: true });
    const t = (r?.text || "").trim();
    if (t) return t;
  } catch (e) {
    console.log("whisper turbo:", e.message);
    if (buf.length > 4 * 1024 * 1024) throw e;
  }
  // запасной — обычный Whisper (принимает массив байт)
  const r = await env.AI.run("@cf/openai/whisper", { audio: [...buf] });
  return (r?.text || "").trim();
}

function toBase64(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- очередь и действия ----------

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
    if (!r.ok && a.fallback_file && r.error_code === 400) {
      // file_id не подошёл — загружаем файл с сайта документом
      const { fallback_file: ff } = a;
      const params = { chat_id: a.params.chat_id, document: ff };
      if (a.params.caption) params.caption = a.params.caption;
      r = await tg(env, "sendDocument", params);
    }
    if (!r.ok && !a.optional) {
      allOk = false;
      console.log(`telegram ${a.method}: ${r.error_code} ${r.description}`);
    }
  }
  return allOk;
}

async function tg(env, method, params) {
  // Файл с сайта ({kira_file: id}) — загрузка multipart
  const fileField = Object.keys(params || {}).find((k) => params[k] && typeof params[k] === "object" && params[k].kira_file);
  let init;
  if (fileField) {
    const ref = params[fileField];
    let blob;
    try {
      blob = await siteFile(env, ref.kira_file, ref.mime);
    } catch (e) {
      return { ok: false, error_code: 404, description: `файл с сайта: ${e.message}` };
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (k === fileField) form.append(k, blob, ref.name || "file");
      else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) };
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, init);
  return res.json().catch(() => ({ ok: false, error_code: res.status, description: "не JSON" }));
}

async function siteFile(env, id, mime) {
  const res = await fetch(env.SITE_URL.replace(/\/$/, "") + `/api/bridge/file/${+id}`, {
    headers: { "X-Bridge-Secret": env.BRIDGE_SECRET, "User-Agent": "kira-bridge" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: mime || "application/octet-stream" });
}

async function site(env, method, path, body, headers) {
  const raw = body instanceof Uint8Array;
  const res = await fetch(env.SITE_URL.replace(/\/$/, "") + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": env.BRIDGE_SECRET, "User-Agent": "kira-bridge", ...(headers || {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg += ` ${(await res.json()).error || ""}`; } catch {}
    throw new Error(msg.trim());
  }
  return res.json();
}
