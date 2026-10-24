// Логика Telegram-бота. На вход — «апдейт» Telegram (его пересылает Cloudflare Worker),
// на выход — список действий для Telegram (отправить сообщение, удалить сообщение…).
//
// Бот личный и без команд: с Кирой говорят обычным текстом.
// Владелец привязывается один раз — присылает пароль от сайта. Остальным бот не отвечает.

import { safeEqual } from "./auth.js";
import { sendMessageActions, fileAction } from "./telegram.js";
import { FILE_KINDS } from "./storage.js";

const INTRO = "Пиши мне обычным текстом или голосом — дела, мысли, вопросы. Разложу на задачи, напомню, когда нужно, скажу, что горит, помогу спланировать день. Присылай документы и голосовые — сохраню в хранилище, прочитаю и найду, когда понадобятся.";
const DOC_CHARS = 15000; // сколько текста документа сразу показывать Кире (дальше — read_file)

export function createBot({ db, agent, cfg, storage, log = () => {} }) {
  async function owner() {
    return db.get("owner", null);
  }

  // Один и тот же апдейт может прийти повторно — обрабатываем только первый раз
  async function firstTime(updateId) {
    if (updateId === undefined) return true;
    const r = await db.query("INSERT IGNORE INTO tg_updates (update_id, received_at) VALUES (?, NOW(3))", [updateId]);
    return r.affectedRows === 1;
  }

  async function handle(update) {
    if (!(await firstTime(update.update_id))) return [];
    const msg = update.message;
    if (!msg || !msg.chat || msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return [];
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text ?? msg.caption ?? "").trim();
    const own = await owner();
    const isOwner = own && own.user_id === userId;

    // Кнопка «Старт» в Telegram присылает /start — это не команда, а знакомство
    const start = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/s);
    const candidate = start ? (start[1] || "").trim() : text;

    // Привязка: пароль от сайта (обычным сообщением)
    if (!isOwner) {
      if (candidate && cfg.adminPassword && safeEqual(candidate, cfg.adminPassword) && !(await tooManyFails(userId))) {
        await db.set("owner", {
          user_id: userId, chat_id: chatId,
          name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
          username: msg.from.username || null, since: new Date().toISOString(),
        });
        log(`владелец привязан: ${userId}`);
        return [
          deleteMsg(chatId, msg.message_id), // сообщение с паролем убираем из переписки
          ...say(chatId, `Готово, теперь я твоя. Сообщение с паролем удалила.\n\n${INTRO}`),
        ];
      }
      if (own) return []; // у бота уже есть владелец — чужим не отвечаем вовсе
      if (!candidate) return say(chatId, "Это личный бот. Чтобы я стала твоей, пришли мне пароль от сайта.");
      if (await tooManyFails(userId)) return [];
      await fail(userId);
      log(`неверный пароль от пользователя ${userId}`);
      return [deleteMsg(chatId, msg.message_id), ...say(chatId, "Это личный бот. Пароль не подошёл.")];
    }

    if (start && !candidate) return say(chatId, `Привет! Я на месте.\n\n${INTRO}`);

    const media = pickMedia(msg);
    if (media) return handleFile(msg, media, update.kira_file || {}, text);
    if (!text) return say(chatId, "Такое я пока не разбираю — пришли текстом, голосом или файлом.");

    return reply(chatId, text, { archive: { tg_chat_id: chatId, tg_message_id: msg.message_id } });
  }

  async function reply(chatId, text, opts = {}) {
    try {
      const r = await agent.ask(text, { channel: "telegram", source: "bot", ...opts });
      const files = [];
      for (const a of r.actions || []) {
        const f = storage && (await storage.row(a.file_id));
        if (f) files.push(fileAction(chatId, f, a.caption));
      }
      return [...say(chatId, r.text), ...files];
    } catch (e) {
      log("ошибка ассистента:", e.message);
      return say(chatId, `Не получилось: ${e.message}`);
    }
  }

  // Файл, голосовое, фото… Worker уже скачал его на сайт (kira_file.key) и распознал речь (kira_file.transcript)
  async function handleFile(msg, media, kf, caption) {
    const chatId = msg.chat.id;
    if (!storage) return say(chatId, "Хранилище сейчас недоступно, файл не сохранила.");
    let saved;
    try {
      saved = await storage.add({
        key: kf.key || null, size: kf.size || media.size || 0, sha256: kf.sha256 || null,
        name: media.name, mime: media.mime, source: "telegram",
        tg: { type: media.type, file_id: media.file_id, unique_id: media.unique_id, message_id: msg.message_id },
        duration: media.duration, caption: caption || null,
        transcript: kf.transcript || null,
        transcriptError: media.spoken && !kf.transcript ? kf.transcribe_error || kf.error || "не распознано" : null,
        note: kf.error ? downloadNote(kf.error) : null,
      });
    } catch (e) {
      log("хранилище:", e.message);
      return say(chatId, `Не смогла сохранить файл: ${e.message}`);
    }
    const f = (await storage.process(saved.file.id, { describe: false }).catch(() => null)) || saved.file;
    const archive = { msg_type: media.type === "voice" ? "voice" : media.type === "photo" ? "photo" : "file", file_id: f.id, tg_chat_id: chatId, tg_message_id: msg.message_id };
    const label = `#${f.id} «${f.name}»`;

    // Голосовое: расшифровка и есть сообщение
    if (media.spoken && media.type !== "document") {
      if (!f.text) {
        return say(chatId, `Сохранила ${media.type === "voice" ? "голосовое" : "запись"} в хранилище (${label}), но распознать не смогла${f.text_note ? `: ${f.text_note}` : ""}.`);
      }
      const head = `[${media.type === "voice" ? "Голосовое сообщение" : FILE_KINDS[f.kind]}${f.duration_sec ? ` ${fmtDur(f.duration_sec)}` : ""}, сохранено в хранилище как файл ${label}. Расшифровка:]`;
      return reply(chatId, `${head}\n${f.text}${caption ? `\n\n[Подпись:] ${caption}` : ""}`, {
        archive: { ...archive, text: f.text }, historyText: `${head}\n${f.text.slice(0, 3000)}`,
      });
    }

    // Альбом без подписи или фото без подписи — просто подтверждаем, без ИИ
    if ((msg.media_group_id && !caption) || (f.kind === "photo" && !caption)) {
      return say(chatId, `Сохранила в хранилище: ${label}.${saved.duplicate ? " (Такой уже был.)" : ""}`);
    }

    const info = [
      FILE_KINDS[f.kind], f.pages ? `${f.kind === "document" ? "стр./листов" : ""} ${f.pages}`.trim() : null,
      fmtSize(f.size), f.duration_sec ? fmtDur(f.duration_sec) : null,
    ].filter(Boolean).join(", ");
    const parts = [`[Владелец прислал файл ${label} (${info}). ${saved.duplicate ? "Такой файл уже был в хранилище — это он же." : "Сохранён в хранилище."}]`];
    if (f.text) {
      parts.push(`[Текст файла${f.text.length > DOC_CHARS ? `, начало — всего ${f.text.length} знаков, дальше через read_file` : ""}:]\n${f.text.slice(0, DOC_CHARS)}`);
    } else {
      parts.push(`[Текста нет: ${f.text_note || "формат без текста"}.]`);
    }
    parts.push(caption ? `[Подпись владельца:] ${caption}` : "[Подписи нет.]");
    return reply(chatId, parts.join("\n\n"), {
      archive: { ...archive, text: caption || f.name },
      historyText: `[Владелец прислал файл ${label} (${info}), сохранён в хранилище.]${caption ? `\n${caption}` : ""}`,
    });
  }

  async function tooManyFails(userId) {
    const f = await db.get(`auth_fail:${userId}`, null);
    return !!(f && f.until && f.until > Date.now());
  }

  async function fail(userId) {
    const f = (await db.get(`auth_fail:${userId}`, null)) || { n: 0 };
    f.n = (f.n || 0) + 1;
    if (f.n >= 5) { f.until = Date.now() + 60 * 60e3; f.n = 0; }
    await db.set(`auth_fail:${userId}`, f);
  }

  return { handle, owner };
}

// Что за файл в сообщении (у фото — самый большой размер)
export function pickMedia(msg) {
  const name = (s) => (s ? String(s).slice(0, 200) : null);
  if (msg.voice) return { type: "voice", spoken: true, file_id: msg.voice.file_id, unique_id: msg.voice.file_unique_id, mime: msg.voice.mime_type || "audio/ogg", size: msg.voice.file_size, duration: msg.voice.duration, name: null };
  if (msg.audio) return { type: "audio", spoken: true, file_id: msg.audio.file_id, unique_id: msg.audio.file_unique_id, mime: msg.audio.mime_type || "audio/mpeg", size: msg.audio.file_size, duration: msg.audio.duration, name: name(msg.audio.file_name || [msg.audio.performer, msg.audio.title].filter(Boolean).join(" — ")) };
  if (msg.video_note) return { type: "video_note", spoken: true, file_id: msg.video_note.file_id, unique_id: msg.video_note.file_unique_id, mime: "video/mp4", size: msg.video_note.file_size, duration: msg.video_note.duration, name: null };
  if (msg.video) return { type: "video", spoken: true, file_id: msg.video.file_id, unique_id: msg.video.file_unique_id, mime: msg.video.mime_type || "video/mp4", size: msg.video.file_size, duration: msg.video.duration, name: name(msg.video.file_name) };
  if (msg.document) {
    const mime = msg.document.mime_type || "";
    return { type: "document", spoken: false, file_id: msg.document.file_id, unique_id: msg.document.file_unique_id, mime, size: msg.document.file_size, name: name(msg.document.file_name) || "Документ" };
  }
  if (msg.photo?.length) {
    const p = msg.photo.reduce((a, b) => ((b.file_size || b.width * b.height) > (a.file_size || a.width * a.height) ? b : a));
    return { type: "photo", spoken: false, file_id: p.file_id, unique_id: p.file_unique_id, mime: "image/jpeg", size: p.file_size, name: null };
  }
  return null;
}

function downloadNote(err) {
  return /too big|20 ?MB|больше/i.test(err) ? "Файл больше 20 МБ — Telegram не даёт боту его скачать; переслать могу, прочитать — нет" : `Не скачался: ${String(err).slice(0, 200)}`;
}

function fmtSize(n) {
  n = Number(n) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;
}

function fmtDur(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function say(chatId, text) {
  return sendMessageActions(chatId, text);
}

function deleteMsg(chatId, messageId) {
  return { method: "deleteMessage", params: { chat_id: chatId, message_id: messageId }, optional: true };
}

export function formatJobs(list) {
  if (!list.length) return "Активных заданий нет. Попроси, например: «каждую пятницу в 18:00 присылай итоги недели».";
  return "*Мои задания*\n" + list.map((j) =>
    `• #${j.id} ${j.title}\n   ${j.schedule_text}${j.next_run ? `; дальше: ${j.next_run}` : ""}${j.exec_status === "failed" || j.exec_status === "retrying" ? " ⚠️" : ""}`,
  ).join("\n");
}

// Сводка без ИИ — быстро и бесплатно
export function formatAgenda(a) {
  const line = (t) => `• ${t.title}${t.due ? ` — ${t.due.length > 10 ? t.due.slice(11) : "весь день"}` : ""}${t.priority >= 3 ? " ❗" : ""}`;
  const lineDated = (t) => `• ${t.title} — ${t.due}${t.priority >= 3 ? " ❗" : ""}`;
  const parts = [];
  if (a.overdue.length) parts.push(`*Просрочено (${a.overdue.length})*\n${a.overdue.map(lineDated).join("\n")}`);
  if (a.today_tasks.length) parts.push(`*Сегодня*\n${a.today_tasks.map(line).join("\n")}`);
  if (a.in_progress.length) parts.push(`*В работе*\n${a.in_progress.map((t) => `• ${t.title}`).join("\n")}`);
  if (a.important_no_date.length) parts.push(`*Важное без срока*\n${a.important_no_date.map((t) => `• ${t.title}`).join("\n")}`);
  if (a.upcoming.length) parts.push(`*Скоро*\n${a.upcoming.map(lineDated).join("\n")}`);
  return parts.length ? parts.join("\n\n") : "На сегодня ничего не запланировано.";
}
