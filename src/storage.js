// Хранилище: все файлы, которые владелец присылает Кире (документы, голосовые, аудио, фото, видео)
// или загружает на сайт. Для каждого файла хранится его текст (из документа или расшифровка голосового),
// краткое описание и ключевые слова от ИИ — по ним Кира находит нужный файл.
//
// Сам файл лежит на диске (pm/files.js), в Telegram его можно переслать заново по file_id без загрузки.

import { extractText } from "./docs/extract.js";
import { formatLocal, parseLocal, localDayBounds } from "./time.js";
import { extractJson } from "./pm/risk-ai.js";

export const FILE_KINDS = { document: "Документ", voice: "Голосовое", audio: "Аудио", photo: "Фото", video: "Видео", other: "Файл" };
const TEXT_STATUS = { pending: "ещё не прочитан", ok: "текст есть", empty: "текста нет", unsupported: "формат без текста", failed: "не прочитался" };

export function kindOf({ tgType, mime = "", name = "" }) {
  if (tgType === "voice") return "voice";
  if (tgType === "audio") return "audio";
  if (tgType === "photo") return "photo";
  if (tgType === "video" || tgType === "video_note" || tgType === "animation") return "video";
  const m = mime.toLowerCase();
  const ext = (name.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
  if (m.startsWith("audio/") || [".mp3", ".ogg", ".oga", ".opus", ".m4a", ".wav", ".flac", ".aac"].includes(ext)) return "audio";
  if (m.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"].includes(ext)) return "photo";
  if (m.startsWith("video/") || [".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(ext)) return "video";
  if (ext || m) return "document";
  return "other";
}

const SPOKEN = new Set(["voice", "audio", "video"]);

export function createStorage({ db, files, llm, tz, log = () => {} }) {
  async function row(id) {
    return (await db.query("SELECT * FROM storage_files WHERE id = ?", [id]))[0] || null;
  }

  // Новый файл. Если такой же (по содержимому) уже есть — возвращает его, новый дубль удаляется.
  async function add(f) {
    if (f.sha256) {
      const same = (await db.query("SELECT * FROM storage_files WHERE sha256 = ? AND deleted_at IS NULL ORDER BY id LIMIT 1", [f.sha256]))[0];
      if (same) {
        if (f.key && f.key !== same.file_key) await files.remove(f.key);
        if (!same.tg_file_id && f.tg?.file_id) {
          await db.query("UPDATE storage_files SET tg_type = ?, tg_file_id = ?, tg_unique_id = ?, tg_message_id = ? WHERE id = ?",
            [f.tg.type, f.tg.file_id, f.tg.unique_id || null, f.tg.message_id || null, same.id]);
        }
        return { file: await row(same.id), duplicate: true };
      }
    }
    const name = String(f.name || defaultName(f)).slice(0, 255);
    const kind = f.kind || kindOf({ tgType: f.tg?.type, mime: f.mime, name });
    const r = await db.query(
      `INSERT INTO storage_files (name, mime, kind, size, sha256, file_key, source, tg_type, tg_file_id, tg_unique_id, tg_message_id,
        duration_sec, caption, text, text_status, text_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [name, String(f.mime || "").slice(0, 100), kind, f.size || 0, f.sha256 || null, f.key || null, f.source || "web",
        f.tg?.type || null, f.tg?.file_id || null, f.tg?.unique_id || null, f.tg?.message_id || null,
        f.duration || null, f.caption || null,
        f.transcript || null,
        f.transcript ? "ok" : f.transcriptError ? "failed" : "pending",
        f.transcriptError ? String(f.transcriptError).slice(0, 300) : f.note ? String(f.note).slice(0, 300) : null],
    );
    return { file: await row(r.insertId), duplicate: false };
  }

  function defaultName(f) {
    const d = formatLocal(new Date(), tz).replace(/[: ]/g, "-");
    const t = f.tg?.type;
    if (t === "voice") return `Голосовое ${d}.ogg`;
    if (t === "photo") return `Фото ${d}.jpg`;
    if (t === "video_note") return `Кружок ${d}.mp4`;
    return `Файл ${d}`;
  }

  // Достать текст (если ещё нет) и описать файл. Ошибки не роняют приём файла.
  async function process(id, { describe: doDescribe = true } = {}) {
    let f = await row(id);
    if (!f) return null;
    if (f.text_status === "pending") {
      if (SPOKEN.has(f.kind)) {
        await setText(id, { status: "empty", text: null, note: "Расшифровки нет" });
      } else if (f.kind === "photo") {
        await setText(id, { status: "unsupported", text: null, note: "Текст на фото пока не распознаю" });
      } else if (!f.file_key) {
        await setText(id, { status: "failed", text: null, note: f.text_note || "Файл не скачался" });
      } else {
        const buf = await files.read(f.file_key);
        const r = buf ? await extractText(buf, { name: f.name, mime: f.mime }) : { status: "failed", note: "Файл не найден на диске" };
        await setText(id, r);
      }
      f = await row(id);
    }
    if (doDescribe && !f.described_at && llm) {
      try { await describe(f); } catch (e) { log(`описание файла #${id}: ${e.message}`); }
      f = await row(id);
    }
    return f;
  }

  async function setText(id, { status, text, pages, note }) {
    await db.query("UPDATE storage_files SET text = ?, text_status = ?, pages = ?, text_note = ? WHERE id = ?",
      [text || null, status, pages ?? null, note ? String(note).slice(0, 300) : null, id]);
  }

  async function describe(f) {
    const body = f.text ? f.text.slice(0, 12000) : "";
    if (!body && !f.caption) {
      await db.query("UPDATE storage_files SET described_at = NOW(3) WHERE id = ?", [f.id]);
      return;
    }
    const prompt = [
      `Файл: «${f.name}» (${FILE_KINDS[f.kind]}${f.pages ? `, страниц/листов: ${f.pages}` : ""}${f.duration_sec ? `, ${f.duration_sec} с` : ""}).`,
      f.caption ? `Подпись владельца: ${f.caption}` : null,
      body ? `${SPOKEN.has(f.kind) ? "Расшифровка" : "Текст"}${f.text.length > 12000 ? " (начало)" : ""}:\n${body}` : null,
    ].filter(Boolean).join("\n");
    const ask = (json) => llm.chat({
      json, temperature: 0.2, maxTokens: 600, timeoutMs: 45000,
      messages: [
        { role: "system", content: "Ты описываешь файлы для поиска в личном архиве. Ответ — только JSON: {\"summary\": \"1–2 предложения по-русски: что это за файл и о чём — тип документа, стороны, предмет, ключевые суммы и даты; для голосового — о чём говорится\", \"keywords\": [\"до 15 слов и фраз для поиска: тип документа, компании, люди, темы, синонимы, в начальной форме\"]}" },
        { role: "user", content: prompt },
      ],
    });
    let res;
    try { res = await ask(true); } catch { res = await ask(false); }
    const j = extractJson(res.message.content) || {};
    const summary = String(j.summary || "").trim().slice(0, 1000) || null;
    const keywords = (Array.isArray(j.keywords) ? j.keywords : String(j.keywords || "").split(/[,;]/)).map((k) => String(k).trim()).filter(Boolean).join(", ").slice(0, 500) || null;
    await db.query("UPDATE storage_files SET summary = ?, keywords = ?, described_at = NOW(3) WHERE id = ?", [summary, keywords, f.id]);
  }

  // Файлы, которые не успели прочитать или описать (например, ИИ был недоступен)
  async function runPending(max = 2) {
    const rows = await db.query(
      `SELECT id FROM storage_files WHERE deleted_at IS NULL AND (text_status = 'pending' OR (described_at IS NULL AND (text IS NOT NULL OR caption IS NOT NULL)))
       AND created_at > NOW(3) - INTERVAL 7 DAY ORDER BY id LIMIT ?`, [max],
    );
    for (const r of rows) await process(r.id).catch((e) => log(`файл #${r.id}: ${e.message}`));
    return rows.length;
  }

  async function get(id) {
    const f = await row(+id);
    return f && !f.deleted_at ? toApi(f) : null;
  }

  async function readText(id, { offset = 0, length = 12000 } = {}) {
    const f = await row(+id);
    if (!f || f.deleted_at) return null;
    const text = f.text || "";
    const from = Math.max(0, +offset || 0);
    const len = Math.min(Math.max(+length || 12000, 1000), 30000);
    return { ...toApi(f), text: text.slice(from, from + len), offset: from, total_chars: text.length, more: from + len < text.length };
  }

  // Поиск: полнотекстовый по имени, подписи, описанию, ключевым словам и тексту; плюс фильтры
  async function search({ query = "", kind, from, to, limit = 10, offset = 0 } = {}) {
    const where = ["deleted_at IS NULL"];
    const params = [];
    if (kind && FILE_KINDS[kind]) { where.push("kind = ?"); params.push(kind); }
    if (from) { const d = parseLocal(`${String(from).slice(0, 10)} 00:00`, tz); if (d) { where.push("created_at >= ?"); params.push(d.utc); } }
    if (to) { const d = String(to).slice(0, 10); if (parseLocal(`${d} 00:00`, tz)) { where.push("created_at <= ?"); params.push(localDayBounds(tz, d).end); } }
    const lim = Math.min(Math.max(+limit || 10, 1), 100);
    const words = String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    let rows = [];
    if (words.length) {
      const bool = words.filter((w) => w.length >= 3).map((w) => `${stem(w)}*`).join(" ");
      if (bool) {
        rows = await db.query(
          `SELECT *, MATCH(name, caption, summary, keywords, text) AGAINST (? IN BOOLEAN MODE) AS score FROM storage_files
           WHERE ${where.join(" AND ")} AND MATCH(name, caption, summary, keywords, text) AGAINST (? IN BOOLEAN MODE)
           ORDER BY score DESC, id DESC LIMIT ? OFFSET ?`,
          [bool, ...params, bool, lim, +offset || 0],
        ).catch((e) => { log(`поиск файлов: ${e.message}`); return []; });
      }
      if (!rows.length) {
        // запасной вариант — подстроки (короткие слова, числа, номера договоров)
        const likes = words.map(() => "(name LIKE ? OR caption LIKE ? OR summary LIKE ? OR keywords LIKE ? OR text LIKE ?)");
        const lp = words.flatMap((w) => Array(5).fill(`%${stem(w)}%`));
        rows = await db.query(
          `SELECT * FROM storage_files WHERE ${where.join(" AND ")} AND (${likes.join(" OR ")}) ORDER BY id DESC LIMIT ? OFFSET ?`,
          [...params, ...lp, lim, +offset || 0],
        );
      }
    } else {
      rows = await db.query(`SELECT * FROM storage_files WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, lim, +offset || 0]);
    }
    return rows.map((r) => ({ ...toApi(r), snippet: snippet(r.text, words) }));
  }

  async function count() {
    const [r] = await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM storage_files WHERE deleted_at IS NULL");
    return { files: Number(r.n), bytes: Number(r.bytes) };
  }

  async function rename(id, name) {
    const n = String(name || "").trim().slice(0, 255);
    if (!n) throw Object.assign(new Error("Пустое имя"), { status: 400, expose: true });
    await db.query("UPDATE storage_files SET name = ? WHERE id = ? AND deleted_at IS NULL", [n, +id]);
    return get(id);
  }

  async function remove(id) {
    await db.query("UPDATE storage_files SET deleted_at = NOW(3) WHERE id = ? AND deleted_at IS NULL", [+id]);
  }

  async function restore(id) {
    await db.query("UPDATE storage_files SET deleted_at = NULL WHERE id = ?", [+id]);
    return get(id);
  }

  function toApi(f) {
    return {
      id: f.id, name: f.name, kind: f.kind, kind_text: FILE_KINDS[f.kind] || f.kind, mime: f.mime, size: Number(f.size),
      created: formatLocal(new Date(f.created_at), tz), source: f.source,
      ...(f.duration_sec ? { duration: f.duration_sec } : {}),
      ...(f.pages ? { pages: f.pages } : {}),
      caption: f.caption || null, summary: f.summary || null, keywords: f.keywords || null,
      text_status: f.text_status, text_status_text: TEXT_STATUS[f.text_status] || f.text_status, text_note: f.text_note || null,
      text_chars: f.text ? f.text.length : 0,
      in_telegram: !!f.tg_file_id, on_disk: !!f.file_key,
      ...(f.deleted_at ? { deleted: true } : {}),
    };
  }

  return { add, process, describe, runPending, get, row, readText, search, count, rename, remove, restore, toApi };
}

// Грубая основа слова для поиска по-русски: «договора», «договоре» → «догов»
export function stem(w) {
  w = String(w).toLowerCase();
  if (/\d/.test(w) || w.length <= 3) return w;
  if (w.length <= 5) return /[аяоеыиуюьй]$/u.test(w) && w.length > 3 ? w.slice(0, -1) : w; // «акта» → «акт», «смету» → «смет»
  const cut = w.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ией|иях|ий|ый|ой|ая|яя|ое|ее|ые|ие|ую|юю|ам|ям|ах|ях|ов|ев|ом|ем|ей|ою|ею|ия|ья|ие|ье|ть|ся|сь|а|я|о|е|ы|и|у|ю|ь)$/u, "");
  return cut.length >= 4 ? cut : w.slice(0, Math.max(4, w.length - 1));
}

function snippet(text, words) {
  if (!text) return null;
  const t = String(text);
  const low = t.toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(stem(w)); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return t.slice(0, 200).replace(/\s+/g, " ").trim() + (t.length > 200 ? "…" : "");
  const s = Math.max(0, at - 120);
  return (s > 0 ? "…" : "") + t.slice(s, at + 200).replace(/\s+/g, " ").trim() + (at + 200 < t.length ? "…" : "");
}
