// DWH: постоянный архив всей переписки с Кирой — входящие и исходящие, из Telegram, с сайта,
// её сообщения по своим заданиям. В отличие от messages (короткая память разговора, которую
// можно «забыть»), отсюда ничего не стирается.

import { formatLocal, parseLocal, localDayBounds } from "./time.js";

export function createDwh({ db, tz }) {
  async function logMessage(m) {
    try {
      await db.query(
        `INSERT INTO dwh_messages (at, channel, direction, author, msg_type, text, file_id, job_id, tg_chat_id, tg_message_id, meta)
         VALUES (NOW(3), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.channel || "telegram", m.direction, m.author || (m.direction === "in" ? "owner" : "kira"), m.msg_type || "text",
          m.text ?? null, m.file_id || null, m.job_id || null, m.tg_chat_id || null, m.tg_message_id || null,
          m.meta ? JSON.stringify(m.meta) : null],
      );
    } catch {
      // архив не должен ронять разговор
    }
  }

  async function list({ query, from, to, channel, file_id, limit = 100, before } = {}) {
    const where = [];
    const params = [];
    if (channel) { where.push("channel = ?"); params.push(channel); }
    if (file_id) { where.push("file_id = ?"); params.push(+file_id); }
    if (before) { where.push("id < ?"); params.push(+before); }
    if (from) { const d = parseLocal(`${String(from).slice(0, 10)} 00:00`, tz); if (d) { where.push("at >= ?"); params.push(d.utc); } }
    if (to) { const d = String(to).slice(0, 10); if (parseLocal(`${d} 00:00`, tz)) { where.push("at <= ?"); params.push(localDayBounds(tz, d).end); } }
    const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    if (words.length) {
      where.push(`(${words.map(() => "text LIKE ?").join(" AND ")})`);
      params.push(...words.map((w) => `%${w.length > 5 ? w.slice(0, w.length - 2) : w}%`));
    }
    const rows = await db.query(
      `SELECT * FROM dwh_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
      [...params, Math.min(+limit || 100, 500)],
    );
    return rows.map((r) => ({
      id: r.id, at: formatLocal(new Date(r.at), tz), channel: r.channel, direction: r.direction, author: r.author,
      type: r.msg_type, text: r.text, file_id: r.file_id, job_id: r.job_id,
    }));
  }

  async function stats() {
    const [r] = await db.query("SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM dwh_messages");
    return { messages: Number(r.n), first: r.first ? formatLocal(new Date(r.first), tz) : null, last: r.last ? formatLocal(new Date(r.last), tz) : null };
  }

  return { logMessage, list, stats };
}
