// Дела по расписанию. Своего «будильника» у сайта нет: хостинг может усыплять приложение.
// Поэтому раз в минуту сайт будит Cloudflare Worker (запрос за исходящими сообщениями),
// и в этот момент выполняется всё, чему подошло время.

import { localNow } from "./time.js";
import { sendMessageActions } from "./telegram.js";

const MORNING_WINDOW_MIN = 180; // если сайт был недоступен, утренний план ещё имеет смысл 3 часа

export function createJobs({ db, agent, cfg, log = () => {} }) {
  async function morningPlan() {
    const own = await db.get("owner", null);
    if (!own) return;
    const at = await db.get("morning_time", cfg.morningTime);
    if (!at || at === "off") return;
    const now = localNow(cfg.tz);
    const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
    const diff = mins(now.time) - mins(at);
    if (diff < 0 || diff > MORNING_WINDOW_MIN) return;
    if (!(await db.claimRun("morning", now.date))) return;
    log("утренний план: готовлю");
    try {
      const r = await agent.ask(
        "Доброе утро! Пришли мне план на сегодня: что просрочено, что на сегодня, с чего начать. Коротко.",
        { channel: "telegram", source: "system", smart: true },
      );
      await enqueue(own.chat_id, r.text, "morning");
    } catch (e) {
      log("утренний план не получился:", e.message);
      // разрешаем повторить на следующей минуте
      await db.query("DELETE FROM job_runs WHERE job = 'morning' AND run_key = ?", [now.date]);
    }
  }

  async function enqueue(chatId, text, kind = "") {
    await db.query("INSERT INTO outbox (chat_id, text, kind, created_at) VALUES (?, ?, ?, NOW(3))", [chatId, text, kind]);
  }

  async function runDue() {
    await morningPlan();
  }

  // Исходящие для Worker'а: действия Telegram с номерами, чтобы потом подтвердить отправку
  async function pending() {
    const rows = await db.query(
      "SELECT id, chat_id, text FROM outbox WHERE sent_at IS NULL AND created_at > NOW(3) - INTERVAL 1 DAY ORDER BY id LIMIT 20",
    );
    return rows.map((r) => ({ id: r.id, actions: sendMessageActions(r.chat_id, r.text) }));
  }

  async function ack(ids) {
    const list = (ids || []).map(Number).filter(Boolean);
    if (!list.length) return 0;
    const r = await db.query(`UPDATE outbox SET sent_at = NOW(3) WHERE id IN (${list.map(() => "?").join(",")})`, list);
    return r.affectedRows;
  }

  return { runDue, pending, ack, enqueue };
}
