// Узлы: проекты, задачи, цели, заметки. Создание, изменение, удаление — всегда с записью в историю.

import { parseLocal, formatLocal, localNow, localDayBounds, addDays } from "./time.js";

export const KINDS = {
  project: { statuses: ["active", "paused", "done", "archived"], initial: "active", closed: ["done", "archived"] },
  task: { statuses: ["todo", "doing", "waiting", "done", "cancelled"], initial: "todo", closed: ["done", "cancelled"] },
  goal: { statuses: ["active", "achieved", "dropped"], initial: "active", closed: ["achieved", "dropped"] },
  note: { statuses: ["active", "archived"], initial: "active", closed: ["archived"] },
};

const FIELDS = ["kind", "parent_id", "title", "body", "status", "priority", "due_at", "due_has_time", "tags", "meta", "position"];

export class ValidationError extends Error {}

export class Nodes {
  constructor(db, tz) {
    this.db = db;
    this.tz = tz;
  }

  // ---------- чтение ----------

  async getRow(id, q = this.db.query.bind(this.db)) {
    const rows = await q("SELECT * FROM nodes WHERE id = ?", [id]);
    return rows[0] || null;
  }

  async get(id, { withChildren = false, withPath = false } = {}) {
    const row = await this.getRow(id);
    if (!row) return null;
    const item = this.toApi(row);
    if (withChildren) {
      const kids = await this.db.query(
        "SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id", [id],
      );
      item.children = kids.map((r) => this.toApi(r));
    }
    if (withPath) item.path = await this.path(row.parent_id);
    return item;
  }

  // Цепочка родителей: [{id, kind, title}, …] от корня
  async path(parentId) {
    const out = [];
    const seen = new Set();
    while (parentId && !seen.has(parentId) && out.length < 20) {
      seen.add(parentId);
      const p = await this.getRow(parentId);
      if (!p) break;
      out.unshift({ id: p.id, kind: p.kind, title: p.title });
      parentId = p.parent_id;
    }
    return out;
  }

  // Список с фильтрами. Удалённые не показываются, если не попросить.
  async list({
    kind, kinds, status, open, parent_id, root, query, tag, due_before, due_after, has_due,
    include_deleted = false, limit = 200, order = "smart",
  } = {}) {
    const where = [];
    const params = [];
    if (!include_deleted) where.push("deleted_at IS NULL");
    const ks = kinds || (kind ? [kind] : null);
    if (ks) { where.push(`kind IN (${ks.map(() => "?").join(",")})`); params.push(...ks); }
    if (status) {
      const ss = Array.isArray(status) ? status : [status];
      where.push(`status IN (${ss.map(() => "?").join(",")})`); params.push(...ss);
    }
    if (open === true) where.push(`status NOT IN (${closedList()})`);
    if (open === false) where.push(`status IN (${closedList()})`);
    if (parent_id !== undefined && parent_id !== null) { where.push("parent_id = ?"); params.push(parent_id); }
    if (root) where.push("parent_id IS NULL");
    if (query) {
      where.push("(title LIKE ? OR body LIKE ? OR tags LIKE ?)");
      const like = `%${String(query).replace(/[%_]/g, (c) => "\\" + c)}%`;
      params.push(like, like, like);
    }
    if (tag) { where.push("CONCAT(',', tags, ',') LIKE ?"); params.push(`%,${tag},%`); }
    if (due_before) { where.push("due_at IS NOT NULL AND due_at <= ?"); params.push(due_before); }
    if (due_after) { where.push("due_at IS NOT NULL AND due_at >= ?"); params.push(due_after); }
    if (has_due === true) where.push("due_at IS NOT NULL");
    if (has_due === false) where.push("due_at IS NULL");
    const orderBy = {
      smart: "(due_at IS NULL), due_at, priority DESC, position, id",
      recent: "updated_at DESC",
      created: "id",
      position: "position, id",
    }[order] || "id";
    const rows = await this.db.query(
      `SELECT * FROM nodes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT ?`,
      [...params, Math.min(+limit || 200, 1000)],
    );
    return rows.map((r) => this.toApi(r));
  }

  // Сводка на день: просроченное, сегодня, ближайшие дни, важное без срока, в работе
  async agenda({ days = 3 } = {}) {
    const today = localNow(this.tz).date;
    const { start, end } = localDayBounds(this.tz, today);
    const horizon = localDayBounds(this.tz, addDays(today, days)).end;
    const open = { kind: "task", open: true };
    const [overdue, todayList, upcoming, important, doing] = await Promise.all([
      this.list({ ...open, due_before: new Date(start.getTime() - 1), limit: 100 }),
      this.list({ ...open, due_after: start, due_before: end, limit: 100 }),
      this.list({ ...open, due_after: new Date(end.getTime() + 1), due_before: horizon, limit: 100 }),
      this.list({ ...open, has_due: false, limit: 30 }).then((l) => l.filter((t) => t.priority >= 3)),
      this.list({ kind: "task", status: "doing", limit: 30 }),
    ]);
    return { today, overdue, today_tasks: todayList, upcoming, important_no_date: important, in_progress: doing };
  }

  async history(id, limit = 50) {
    const rows = await this.db.query(
      "SELECT version, action, source, changed_at, diff FROM node_history WHERE node_id = ? ORDER BY version DESC LIMIT ?",
      [id, limit],
    );
    return rows.map((r) => ({
      version: r.version, action: r.action, source: r.source,
      at: r.changed_at, at_local: formatLocal(r.changed_at, this.tz),
      changes: r.diff ? JSON.parse(r.diff) : null,
    }));
  }

  // Каким узел был в заданный момент (по истории)
  async asOf(id, when) {
    const rows = await this.db.query(
      "SELECT snapshot FROM node_history WHERE node_id = ? AND changed_at <= ? ORDER BY version DESC LIMIT 1",
      [id, when],
    );
    return rows.length ? JSON.parse(rows[0].snapshot) : null;
  }

  // Лента изменений за период — «что происходило»
  async changes({ since, until = new Date(), limit = 100 } = {}) {
    const rows = await this.db.query(
      `SELECT h.node_id, h.version, h.action, h.source, h.changed_at, h.diff, n.kind, n.title
       FROM node_history h JOIN nodes n ON n.id = h.node_id
       WHERE h.changed_at >= ? AND h.changed_at <= ? ORDER BY h.changed_at DESC LIMIT ?`,
      [since, until, limit],
    );
    return rows.map((r) => ({
      id: r.node_id, kind: r.kind, title: r.title, action: r.action, source: r.source,
      at_local: formatLocal(r.changed_at, this.tz), changes: r.diff ? JSON.parse(r.diff) : null,
    }));
  }

  // ---------- запись ----------

  async create(input, source = "web") {
    const data = await this.normalize(input, null);
    if (!data.kind) throw new ValidationError("Не указан вид (kind)");
    if (!data.title) throw new ValidationError("Нужно название");
    data.status = data.status || KINDS[data.kind].initial;
    return this.db.tx(async (q) => {
      const now = new Date();
      const row = { ...defaults(), ...data };
      const res = await q(
        `INSERT INTO nodes (${FIELDS.join(",")}, version, created_at, updated_at, completed_at)
         VALUES (${FIELDS.map(() => "?").join(",")}, 1, ?, ?, ?)`,
        [...FIELDS.map((f) => row[f]), now, now, isClosed(row.kind, row.status) ? now : null],
      );
      const created = await this.getRow(res.insertId, q);
      await this.record(q, created, "create", source, null);
      return this.toApi(created);
    });
  }

  async update(id, patch, source = "web") {
    return this.db.tx(async (q) => {
      const rows = await q("SELECT * FROM nodes WHERE id = ? FOR UPDATE", [id]);
      const old = rows[0];
      if (!old) throw new ValidationError(`Нет записи #${id}`);
      const data = await this.normalize({ ...patch, kind: patch.kind || old.kind }, old, q);
      const diff = {};
      for (const f of FIELDS) {
        if (data[f] === undefined) continue;
        if (!same(old[f], data[f])) diff[f] = [plain(old[f]), plain(data[f])];
      }
      if (!Object.keys(diff).length) return this.toApi(old);
      const sets = Object.keys(diff).map((f) => `${f} = ?`);
      const vals = Object.keys(diff).map((f) => data[f]);
      const kind = data.kind || old.kind;
      const status = data.status ?? old.status;
      let completed = old.completed_at;
      if (diff.status || diff.kind) completed = isClosed(kind, status) ? old.completed_at || new Date() : null;
      await q(
        `UPDATE nodes SET ${sets.join(", ")}, completed_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        [...vals, completed, new Date(), id],
      );
      const fresh = await this.getRow(id, q);
      await this.record(q, fresh, "update", source, diff);
      return this.toApi(fresh);
    });
  }

  // Удаление мягкое: запись помечается удалённой, история остаётся. Вместе с потомками.
  async remove(id, source = "web") {
    return this.db.tx(async (q) => {
      const ids = await this.subtreeIds(id, q);
      if (!ids.length) throw new ValidationError(`Нет записи #${id}`);
      const now = new Date();
      for (const nid of ids) {
        const r = await q("SELECT * FROM nodes WHERE id = ? FOR UPDATE", [nid]);
        if (!r[0] || r[0].deleted_at) continue;
        await q("UPDATE nodes SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [now, now, nid]);
        const fresh = await this.getRow(nid, q);
        await this.record(q, fresh, "delete", source, { deleted_at: [null, now.toISOString()] });
      }
      return { deleted: ids.length };
    });
  }

  async restore(id, source = "web") {
    return this.db.tx(async (q) => {
      const r = await q("SELECT * FROM nodes WHERE id = ? FOR UPDATE", [id]);
      if (!r[0]) throw new ValidationError(`Нет записи #${id}`);
      if (!r[0].deleted_at) return this.toApi(r[0]);
      const now = new Date();
      await q("UPDATE nodes SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?", [now, id]);
      const fresh = await this.getRow(id, q);
      await this.record(q, fresh, "restore", source, { deleted_at: [plain(r[0].deleted_at), null] });
      return this.toApi(fresh);
    });
  }

  async subtreeIds(id, q) {
    const out = [];
    let level = [id];
    while (level.length && out.length < 5000) {
      const rows = await q(`SELECT id FROM nodes WHERE id IN (${level.map(() => "?").join(",")})`, level);
      out.push(...rows.map((r) => r.id));
      const kids = await q(`SELECT id FROM nodes WHERE parent_id IN (${level.map(() => "?").join(",")})`, level);
      level = kids.map((r) => r.id).filter((k) => !out.includes(k));
    }
    return out;
  }

  async record(q, row, action, source, diff) {
    await q(
      "INSERT INTO node_history (node_id, version, action, source, changed_at, diff, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.version, action, source, row.updated_at, diff ? JSON.stringify(diff) : null, JSON.stringify(snapshot(row))],
    );
  }

  // Приводит входные поля к виду базы и проверяет их
  async normalize(input, old, q = this.db.query.bind(this.db)) {
    const out = {};
    if (input.kind !== undefined) {
      if (!KINDS[input.kind]) throw new ValidationError(`Неизвестный вид: ${input.kind}`);
      out.kind = input.kind;
    }
    const kind = out.kind || old?.kind;
    if (input.title !== undefined) {
      const t = String(input.title).trim().slice(0, 500);
      if (!t) throw new ValidationError("Название не может быть пустым");
      out.title = t;
    }
    if (input.body !== undefined) out.body = input.body === null ? null : String(input.body);
    if (input.status !== undefined) {
      if (!KINDS[kind].statuses.includes(input.status)) {
        throw new ValidationError(`Статус «${input.status}» не подходит для ${kind}: ${KINDS[kind].statuses.join(", ")}`);
      }
      out.status = input.status;
    } else if (old && out.kind && out.kind !== old.kind && !KINDS[out.kind].statuses.includes(old.status)) {
      out.status = KINDS[out.kind].initial;
    }
    if (input.priority !== undefined) {
      const p = Math.round(+input.priority);
      if (!(p >= 0 && p <= 3)) throw new ValidationError("Приоритет — число от 0 до 3");
      out.priority = p;
    }
    if (input.due !== undefined) {
      if (input.due === null || input.due === "") { out.due_at = null; out.due_has_time = 0; }
      else {
        const d = parseLocal(input.due, this.tz);
        if (!d) throw new ValidationError(`Не понял дату «${input.due}». Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ`);
        out.due_at = d.utc; out.due_has_time = d.hasTime ? 1 : 0;
      }
    }
    if (input.tags !== undefined) {
      const list = (Array.isArray(input.tags) ? input.tags : String(input.tags || "").split(","))
        .map((t) => String(t).trim().replace(/^#/, "").replace(/,/g, "")).filter(Boolean);
      out.tags = [...new Set(list)].join(",").slice(0, 500);
    }
    if (input.meta !== undefined) out.meta = input.meta === null ? null : JSON.stringify(input.meta);
    if (input.position !== undefined) out.position = Math.round(+input.position) || 0;
    if (input.parent_id !== undefined) {
      const pid = input.parent_id === null || input.parent_id === "" ? null : +input.parent_id;
      if (pid !== null) {
        const p = (await q("SELECT id, deleted_at, parent_id FROM nodes WHERE id = ?", [pid]))[0];
        if (!p || p.deleted_at) throw new ValidationError(`Нет родителя #${pid}`);
        if (old) {
          // нельзя сделать узел потомком самого себя
          let cur = p;
          for (let i = 0; cur && i < 50; i++) {
            if (cur.id === old.id) throw new ValidationError("Нельзя вложить запись саму в себя");
            cur = cur.parent_id ? (await q("SELECT id, parent_id FROM nodes WHERE id = ?", [cur.parent_id]))[0] : null;
          }
        }
      }
      out.parent_id = pid;
    }
    return out;
  }

  toApi(r) {
    const closed = isClosed(r.kind, r.status);
    const now = Date.now();
    return {
      id: r.id,
      kind: r.kind,
      parent_id: r.parent_id,
      title: r.title,
      body: r.body,
      status: r.status,
      priority: r.priority,
      due: r.due_at ? formatLocal(r.due_at, this.tz, !!r.due_has_time) : null,
      overdue: !!(r.due_at && !closed && !r.deleted_at && new Date(r.due_at).getTime() < now),
      tags: r.tags ? r.tags.split(",") : [],
      meta: r.meta ? safeJson(r.meta) : null,
      position: r.position,
      version: r.version,
      closed,
      created: formatLocal(r.created_at, this.tz),
      updated: formatLocal(r.updated_at, this.tz),
      completed: r.completed_at ? formatLocal(r.completed_at, this.tz) : null,
      deleted: !!r.deleted_at,
    };
  }
}

function defaults() {
  return { parent_id: null, body: null, priority: 0, due_at: null, due_has_time: 0, tags: "", meta: null, position: 0 };
}

function closedList() {
  const all = new Set(Object.values(KINDS).flatMap((k) => k.closed));
  return [...all].map((s) => `'${s}'`).join(",");
}

export function isClosed(kind, status) {
  return !!KINDS[kind]?.closed.includes(status);
}

function plain(v) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

function same(a, b) {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

function snapshot(row) {
  const s = {};
  for (const [k, v] of Object.entries(row)) s[k] = plain(v);
  return s;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
