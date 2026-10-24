// Очередь сообщений, которые Кира отправляет сама (напоминания, результаты заданий, утренний план).
// Сайт в Telegram не ходит: раз в минуту Cloudflare Worker забирает очередь и отправляет.

import { sendMessageActions } from "./telegram.js";

export function createOutbox({ db }) {
  // Отправить владельцу. Сообщение попадает и в переписку, чтобы Кира помнила, что писала.
  async function notifyOwner(text, kind = "") {
    const own = await db.get("owner", null);
    if (!own) return { sent: false, reason: "Владелец ещё не привязал бота" };
    await db.query("INSERT INTO outbox (chat_id, text, kind, created_at) VALUES (?, ?, ?, NOW(3))", [own.chat_id, text, kind]);
    await db.query(
      "INSERT INTO messages (channel, role, content, meta, created_at) VALUES ('telegram', 'assistant', ?, ?, NOW(3))",
      [text, JSON.stringify({ proactive: kind || true })],
    );
    return { sent: true };
  }

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

  return { notifyOwner, pending, ack };
}
