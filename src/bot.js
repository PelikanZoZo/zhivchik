// Логика Telegram-бота. На вход — «апдейт» Telegram (его пересылает Cloudflare Worker),
// на выход — список действий для Telegram (отправить сообщение, удалить сообщение…).
//
// Бот личный и без команд: с Кирой говорят обычным текстом.
// Владелец привязывается один раз — присылает пароль от сайта. Остальным бот не отвечает.

import { safeEqual } from "./auth.js";
import { sendMessageActions } from "./telegram.js";

const INTRO = "Пиши мне обычным текстом — дела, мысли, вопросы. Разложу на задачи, напомню, когда нужно, скажу, что горит, помогу спланировать день. Могу и сама следить за делами по расписанию — просто попроси.";

export function createBot({ db, agent, cfg, log = () => {} }) {
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
    if (!text) {
      return say(chatId, "Пока понимаю только текст. Голосовые, фото и документы научусь разбирать позже.");
    }

    try {
      const r = await agent.ask(text, { channel: "telegram", source: "bot" });
      return say(chatId, r.text);
    } catch (e) {
      log("ошибка ассистента:", e.message);
      return say(chatId, `Не получилось: ${e.message}`);
    }
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
