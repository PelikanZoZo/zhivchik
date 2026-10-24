// Очередь сообщений, которые Кира отправляет сама (напоминания, результаты заданий, утренний план).
// Сайт в Telegram не ходит: раз в минуту Cloudflare Worker забирает очередь и отправляет.

import { sendMessageActions, fileAction } from "./telegram.js";

export function createOutbox({ db, dwh }) {
  // Отправить владельцу. Сообщение попадает и в переписку, чтобы Кира помнила, что писала, и в архив (DWH).
  async function notifyOwner(text, kind = "") {
    const own = await db.get("owner", null);
    if (!own) return { sent: false, reason: "Владелец ещё не привязал бота" };
    await db.query("INSERT INTO outbox (chat_id, text, kind, created_at) VALUES (?, ?, ?, NOW(3))", [own.chat_id, text, kind]);
    await db.query(
      "INSERT INTO messages (channel, role, content, meta, created_at) VALUES ('telegram', 'assistant', ?, ?, NOW(3))",
      [text, JSON.stringify({ proactive: kind || true })],
    );
    const job = String(kind).match(/^job(?:-fail)?:(\d+)/);
    await dwh?.logMessage({ channel: "telegram", direction: "out", msg_type: "proactive", text, job_id: job ? +job[1] : null, tg_chat_id: own.chat_id, meta: { kind } });
    return { sent: true };
  }

  // Отправить владельцу файл из хранилища (когда Кира пишет сама — из задания или с сайта)
  async function sendFile(file, caption = "", kind = "file") {
    const own = await db.get("owner", null);
    if (!own) return { sent: false, reason: "Владелец ещё не привязал бота" };
    const action = fileAction(own.chat_id, file, caption);
    await db.query("INSERT INTO outbox (chat_id, text, payload, kind, created_at) VALUES (?, ?, ?, ?, NOW(3))",
      [own.chat_id, caption || file.name, JSON.stringify(action), kind]);
    await dwh?.logMessage({ channel: "telegram", direction: "out", msg_type: "file", text: caption || file.name, file_id: file.id, tg_chat_id: own.chat_id });
    return { sent: true };
  }

  async function pending() {
    const rows = await db.query(
      "SELECT id, chat_id, text, payload FROM outbox WHERE sent_at IS NULL AND created_at > NOW(3) - INTERVAL 1 DAY ORDER BY id LIMIT 20",
    );
    return rows.map((r) => {
      if (r.payload) {
        try { return { id: r.id, actions: [JSON.parse(r.payload)] }; } catch {}
      }
      return { id: r.id, actions: sendMessageActions(r.chat_id, r.text) };
    });
  }

  async function ack(ids) {
    const list = (ids || []).map(Number).filter(Boolean);
    if (!list.length) return 0;
    const r = await db.query(`UPDATE outbox SET sent_at = NOW(3) WHERE id IN (${list.map(() => "?").join(",")})`, list);
    return r.affectedRows;
  }

  return { notifyOwner, sendFile, pending, ack };
}
