// Логика Telegram-бота. На вход — «апдейт» Telegram (его пересылает Cloudflare Worker),
// на выход — список действий для Telegram (отправить сообщение, удалить сообщение…).
//
// Бот личный. Владелец привязывается один раз: /start <пароль от сайта>.
// Остальным бот не отвечает вовсе.

import { safeEqual } from "./auth.js";
import { sendMessageActions } from "./telegram.js";
import { localNow } from "./time.js";
import { getMorningTime, setMorningTime } from "./jobs/runner.js";

const HELP = [
  "Пиши как есть — дела, мысли, вопросы. Я разложу на задачи, отвечу, что горит, помогу спланировать.",
  "",
  "Команды:",
  "/plan — план на сегодня",
  "/today — что на сегодня, без обдумывания",
  "/new — начать разговор с чистого листа (задачи не трогаются)",
  "/jobs — мои задания: что и когда я сделаю сама",
  "/morning 08:30 — во сколько присылать утренний план (/morning off — не присылать)",
  "/help — эта подсказка",
].join("\n");

export function createBot({ db, agent, nodes, jobs, runner, cfg, log = () => {} }) {
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

    // Привязка владельца
    const start = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/s);
    if (start) {
      const password = (start[1] || "").trim();
      if (isOwner && !password) return say(chatId, `Привет! Я на месте.\n\n${HELP}`);
      if (!password) return own ? [] : say(chatId, "Это личный бот. Чтобы стать его владельцем, отправь: /start <пароль от сайта>");
      if (await tooManyFails(userId)) return [];
      if (!safeEqual(password, cfg.adminPassword)) {
        await fail(userId);
        log(`неверный пароль в /start от пользователя ${userId}`);
        return [deleteMsg(chatId, msg.message_id), ...say(chatId, "Пароль не подошёл.")];
      }
      await db.set("owner", {
        user_id: userId, chat_id: chatId,
        name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
        username: msg.from.username || null, since: new Date().toISOString(),
      });
      log(`владелец привязан: ${userId}`);
      return [
        deleteMsg(chatId, msg.message_id), // сообщение с паролем убираем из переписки
        ...say(chatId, `Готово, теперь я твоя. Сообщение с паролем удалила.\n\n${HELP}`),
      ];
    }

    if (!own) return say(chatId, "Это личный бот. Чтобы стать его владельцем, отправь: /start <пароль от сайта>");
    if (!isOwner) return []; // чужим не отвечаем

    if (!text) {
      return say(chatId, "Пока понимаю только текст. Голосовые, фото и документы научусь разбирать позже.");
    }

    try {
      if (/^\/help(@\w+)?$/.test(text)) return say(chatId, HELP);
      if (/^\/new(@\w+)?$/.test(text)) {
        await agent.reset("telegram");
        return say(chatId, "Начали с чистого листа. Задачи на месте, я просто забыла наш разговор.");
      }
      if (/^\/today(@\w+)?$/.test(text)) return say(chatId, formatAgenda(await nodes.agenda({ days: 1 })));
      if (/^\/jobs(@\w+)?$/.test(text)) return say(chatId, formatJobs(await jobs.list({ status: "active", limit: 50 })));
      const morning = text.match(/^\/morning(?:@\w+)?(?:\s+(\S+))?$/);
      if (morning) return say(chatId, await setMorning(morning[1]));
      if (/^\/plan(@\w+)?$/.test(text)) {
        const d = localNow(cfg.tz);
        const r = await agent.ask(`Составь мне план на сегодня (${d.date}, ${d.weekday}).`, { channel: "telegram", source: "bot", smart: true });
        return say(chatId, r.text);
      }
      const r = await agent.ask(text, { channel: "telegram", source: "bot" });
      return say(chatId, r.text);
    } catch (e) {
      log("ошибка ассистента:", e.message);
      return say(chatId, `Не получилось: ${e.message}`);
    }
  }

  async function setMorning(arg) {
    if (!arg) {
      const t = await getMorningTime({ jobs });
      return t === "off" ? "Утренний план выключен. Включить: /morning 08:30" : `Утренний план приходит в ${t}.`;
    }
    if (/^(off|выкл|нет)$/i.test(arg)) {
      await setMorningTime({ jobs }, "off", "bot");
      return "Утренний план больше не присылаю.";
    }
    const m = arg.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return "Не поняла время. Пример: /morning 08:30";
    const t = `${m[1].padStart(2, "0")}:${m[2]}`;
    await setMorningTime({ jobs }, t, "bot");
    return `Хорошо, план на день буду присылать в ${t}.`;
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
