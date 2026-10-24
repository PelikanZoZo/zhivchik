// Объекты системы управления: треки, проекты, миссии и всё, что в них живёт (см. pm/schema.js).
// Создание, изменение, удаление, связи — всегда с записью в историю: всё хранится во времени.

import { parseLocal, formatLocal, localNow, localDayBounds, addDays } from "./time.js";
import { TYPES, CORE, isClosed, closedStatuses, riskScore, riskLevel } from "./pm/schema.js";

export { isClosed };
export const KINDS = TYPES;

const FIELDS = ["kind", "parent_id", "stage_id", "title", "body", "status", "priority", "due_at", "due_has_time", "start_at", "event_at", "tags", "meta", "position"];

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

  async get(id, { withChildren = false, withPath = false, full = false } = {}) {
    const row = await this.getRow(id);
    if (!row) return null;
    const item = this.toApi(row);
    if (withChildren || full) {
      const kids = await this.db.query(
        "SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id", [id],
      );
      item.children = kids.map((r) => this.toApi(r));
    }
    if (withPath || full) item.path = await this.path(row.parent_id);
    if (full) {
      item.links = await this.linksOf(id);
      item.comments = await this.comments(id);
      if (row.stage_id) item.stage = (await this.get(row.stage_id))?.title || null;
      // у подзадач и задач — их подзадачи уже в children; блокеры, которые мешают этому объекту
      item.blocked_by = item.links.filter((l) => l.role === "blocks" && l.direction === "in" && !l.closed);
    }
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
    kind, kinds, status, open, parent_id, root, stage_id, query, tag, due_before, due_after, has_due,
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
    const closed = closedStatuses().map((s) => `'${s}'`).join(",");
    if (open === true) where.push(`status NOT IN (${closed})`);
    if (open === false) where.push(`status IN (${closed})`);
    if (parent_id !== undefined && parent_id !== null) { where.push("parent_id = ?"); params.push(parent_id); }
    if (root) where.push("parent_id IS NULL");
    if (stage_id) { where.push("stage_id = ?"); params.push(stage_id); }
    if (query) {
      where.push("(title LIKE ? OR body LIKE ? OR tags LIKE ? OR meta LIKE ?)");
      const like = `%${String(query).replace(/[%_]/g, (c) => "\\" + c)}%`;
      params.push(like, like, like, like);
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
      event: "event_at DESC, id DESC",
      title: "title",
    }[order] || "id";
    const rows = await this.db.query(
      `SELECT * FROM nodes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT ?`,
      [...params, Math.min(+limit || 200, 1000)],
    );
    return rows.map((r) => this.toApi(r));
  }

  // Сводка: просроченное, сегодня, ближайшие дни, вехи, блокеры, высокие риски, миссии в работе
  async agenda({ days = 3 } = {}) {
    const today = localNow(this.tz).date;
    const { start, end } = localDayBounds(this.tz, today);
    const horizon = localDayBounds(this.tz, addDays(today, days)).end;
    const open = { kind: "task", open: true };
    const [overdue, todayList, upcoming, important, doing, goals, blockers, risks, missions] = await Promise.all([
      this.list({ ...open, due_before: new Date(start.getTime() - 1), limit: 100 }),
      this.list({ ...open, due_after: start, due_before: end, limit: 100 }),
      this.list({ ...open, due_after: new Date(end.getTime() + 1), due_before: horizon, limit: 100 }),
      this.list({ ...open, has_due: false, limit: 50 }).then((l) => l.filter((t) => t.priority >= 3)),
      this.list({ kind: "task", status: "doing", limit: 30 }),
      this.list({ kind: "goal", open: true, due_before: horizon, limit: 50 }),
      this.list({ kind: "blocker", open: true, limit: 50 }),
      this.list({ kind: "risk", status: ["open", "watching"], limit: 100 }).then((l) => l.filter((r) => r.risk.level === "high")),
      this.list({ kind: "mission", status: ["preparing", "active"], limit: 30 }),
    ]);
    await this.withHomes([...overdue, ...todayList, ...upcoming, ...important, ...doing, ...goals, ...blockers, ...risks, ...missions]);
    return {
      today, overdue, today_tasks: todayList, upcoming, important_no_date: important, in_progress: doing,
      goals_due: goals, blockers, high_risks: risks, missions,
    };
  }

  // Обзор основных объектов: сколько задач открыто и сделано (со всем вложенным), блокеры, высокие риски,
  // текущая стадия, ближайшая веха и финальная цель. Система личная — данных немного, считаем в памяти.
  async overview({ kind, kinds, open } = {}) {
    const rows = (await this.db.query("SELECT * FROM nodes WHERE deleted_at IS NULL")).map((r) => this.toApi(r));
    const byParent = new Map();
    for (const r of rows) {
      if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
      byParent.get(r.parent_id).push(r);
    }
    const subtree = (id) => {
      const out = [];
      const stack = [...(byParent.get(id) || [])];
      while (stack.length) {
        const n = stack.pop();
        out.push(n);
        stack.push(...(byParent.get(n.id) || []));
      }
      return out;
    };
    const ks = kinds || (kind ? [kind] : CORE);
    const items = rows.filter((r) => ks.includes(r.kind) && (open === undefined || r.closed !== open));
    for (const it of items) {
      const all = subtree(it.id);
      const tasks = all.filter((x) => x.kind === "task");
      const direct = byParent.get(it.id) || [];
      const goals = direct.filter((x) => x.kind === "goal");
      const milestones = goals.filter((g) => g.fields.goal_type !== "final" && !g.closed)
        .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
      it.stats = {
        tasks_open: tasks.filter((t) => !t.closed).length,
        tasks_done: tasks.filter((t) => t.status === "done").length,
        overdue: tasks.filter((t) => t.overdue).length,
        blockers: all.filter((x) => x.kind === "blocker" && !x.closed).length,
        high_risks: all.filter((x) => x.kind === "risk" && !x.closed && x.risk?.level === "high").length,
        missions_open: all.filter((x) => x.kind === "mission" && !x.closed).length,
        projects_open: all.filter((x) => x.kind === "project" && !x.closed).length,
        stage: direct.find((x) => x.kind === "stage" && x.status === "active")?.title || null,
        stages: direct.filter((x) => x.kind === "stage").length,
        next_milestone: milestones[0] ? { id: milestones[0].id, title: milestones[0].title, due: milestones[0].due } : null,
        final_goal: (() => { const f = goals.find((g) => g.fields.goal_type === "final"); return f ? { id: f.id, title: f.title, status: f.status, closed: f.closed } : null; })(),
        last_action: all.filter((x) => x.kind === "action").sort((a, b) => (b.event_at || "").localeCompare(a.event_at || ""))[0]?.event_at || null,
      };
    }
    await this.withHomes(items);
    return items.sort((a, b) => a.position - b.position || a.id - b.id);
  }

  // Добавляет к объектам «дом» — ближайший основной объект (трек, проект, миссия), в котором они живут
  async withHomes(items) {
    const cache = new Map();
    for (const it of items) {
      if (!it.parent_id) { it.home = null; continue; }
      if (!cache.has(it.parent_id)) {
        const path = await this.path(it.parent_id);
        const home = [...path].reverse().find((p) => CORE.includes(p.kind)) || null;
        cache.set(it.parent_id, home);
      }
      it.home = cache.get(it.parent_id);
    }
    return items;
  }

  async history(id, limit = 50) {
    const rows = await this.db.query(
      "SELECT version, action, source, changed_at, diff FROM node_history WHERE node_id = ? ORDER BY id DESC LIMIT ?",
      [id, limit],
    );
    return rows.map((r) => ({
      version: r.version, action: r.action, source: r.source,
      at: r.changed_at, at_local: formatLocal(r.changed_at, this.tz),
      changes: r.diff ? JSON.parse(r.diff) : null,
    }));
  }

  // Каким объект был в заданный момент (по истории)
  async asOf(id, when) {
    const rows = await this.db.query(
      "SELECT snapshot FROM node_history WHERE node_id = ? AND changed_at <= ? ORDER BY id DESC LIMIT 1",
      [id, when],
    );
    return rows.length ? JSON.parse(rows[0].snapshot) : null;
  }

  // Лента изменений за период — «что происходило»
  async changes({ since, until = new Date(), limit = 100, root } = {}) {
    let ids = null;
    if (root) ids = await this.subtreeIds(root, this.db.query.bind(this.db));
    const rows = await this.db.query(
      `SELECT h.node_id, h.version, h.action, h.source, h.changed_at, h.diff, n.kind, n.title
       FROM node_history h JOIN nodes n ON n.id = h.node_id
       WHERE h.changed_at >= ? AND h.changed_at <= ? ${ids ? `AND h.node_id IN (${ids.map(() => "?").join(",")})` : ""}
       ORDER BY h.id DESC LIMIT ?`,
      [since, until, ...(ids || []), limit],
    );
    return rows.map((r) => ({
      id: r.node_id, kind: r.kind, title: r.title, action: r.action, source: r.source,
      at_local: formatLocal(r.changed_at, this.tz), changes: r.diff ? JSON.parse(r.diff) : null,
    }));
  }

  // ---------- запись ----------

  async create(input, source = "web") {
    const data = await this.normalize(input, null);
    if (!data.kind) throw new ValidationError("Не указан вид объекта (kind)");
    const t = TYPES[data.kind];
    if (!data.title) throw new ValidationError("Нужно название");
    if (t.parentRequired && !data.parent_id) throw new ValidationError(`«${t.label}» должна быть внутри: ${t.parents.map((k) => TYPES[k].label).join(" или ")}`);
    data.status = data.status || t.initial;
    if (!data.meta) data.meta = JSON.stringify(defaultFields(data.kind));
    if (["action", "blocker"].includes(data.kind) && !data.event_at) data.event_at = new Date();
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
      if (created.kind === "stage" && created.status === "active") await this.onlyOneActiveStage(q, created, source);
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
      await this.record(q, fresh, "update", source, readableDiff(diff));
      if (fresh.kind === "stage" && diff.status && fresh.status === "active") await this.onlyOneActiveStage(q, fresh, source);
      return this.toApi(fresh);
    });
  }

  // У проекта или трека текущая стадия одна: при включении новой предыдущие текущие — пройдены
  async onlyOneActiveStage(q, stage, source) {
    const others = await q(
      "SELECT * FROM nodes WHERE kind = 'stage' AND parent_id = ? AND status = 'active' AND id <> ? AND deleted_at IS NULL",
      [stage.parent_id, stage.id],
    );
    for (const o of others) {
      await q("UPDATE nodes SET status = 'done', completed_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [new Date(), new Date(), o.id]);
      await this.record(q, await this.getRow(o.id, q), "update", source, { status: ["active", "done"] });
    }
  }

  // Удаление мягкое: запись помечается удалённой, история остаётся. Вместе с вложенными.
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

  // ---------- связи (человек ↔ объект с ролью, блокер → что блокирует, «связано») ----------

  async link(aId, bId, role = "related", source = "web", note = null) {
    if (+aId === +bId) throw new ValidationError("Нельзя связать объект сам с собой");
    const [a, b] = [await this.getRow(+aId), await this.getRow(+bId)];
    if (!a || a.deleted_at) throw new ValidationError(`Нет записи #${aId}`);
    if (!b || b.deleted_at) throw new ValidationError(`Нет записи #${bId}`);
    // человек всегда справа: «объект — роль — человек»
    let [x, y] = [a, b];
    if (x.kind === "person" && y.kind !== "person") [x, y] = [y, x];
    role = String(role || "related").trim().slice(0, 60) || "related";
    const exists = await this.db.query(
      "SELECT id FROM node_links WHERE a_id = ? AND b_id = ? AND role = ? AND removed_at IS NULL", [x.id, y.id, role],
    );
    if (exists.length) return { id: exists[0].id, existed: true };
    const r = await this.db.query(
      "INSERT INTO node_links (a_id, b_id, role, note, created_at) VALUES (?, ?, ?, ?, NOW(3))", [x.id, y.id, role, note],
    );
    await this.touch(x.id, "link", source, { link: [null, `${role}: ${y.title} (#${y.id})`] });
    return { id: r.insertId };
  }

  async unlink(linkId, source = "web") {
    const [l] = await this.db.query("SELECT * FROM node_links WHERE id = ? AND removed_at IS NULL", [linkId]);
    if (!l) throw new ValidationError(`Нет связи #${linkId}`);
    await this.db.query("UPDATE node_links SET removed_at = NOW(3) WHERE id = ?", [linkId]);
    const b = await this.getRow(l.b_id);
    await this.touch(l.a_id, "unlink", source, { link: [`${l.role}: ${b?.title} (#${l.b_id})`, null] });
    return { removed: true };
  }

  // Все связи объекта в обе стороны
  async linksOf(id) {
    const rows = await this.db.query(
      `SELECT l.id, l.a_id, l.b_id, l.role, l.note, l.created_at, n.id AS nid, n.kind, n.title, n.status, n.meta, n.deleted_at
       FROM node_links l JOIN nodes n ON n.id = IF(l.a_id = ?, l.b_id, l.a_id)
       WHERE (l.a_id = ? OR l.b_id = ?) AND l.removed_at IS NULL ORDER BY l.id`,
      [id, id, id],
    );
    return rows.filter((r) => !r.deleted_at).map((r) => ({
      link_id: r.id, role: r.role, note: r.note, direction: r.a_id === +id ? "out" : "in",
      id: r.nid, kind: r.kind, title: r.title, status: r.status, closed: isClosed(r.kind, r.status),
      fields: r.kind === "person" ? safeJson(r.meta) || {} : undefined,
    }));
  }

  // Изменение без смены полей (связь, комментарий) — тоже в историю
  async touch(id, action, source, diff) {
    await this.db.tx(async (q) => {
      await q("UPDATE nodes SET version = version + 1, updated_at = NOW(3) WHERE id = ?", [id]);
      await this.record(q, await this.getRow(id, q), action, source, diff);
    });
  }

  // ---------- комментарии ----------

  async addComment(id, text, author = "owner") {
    const row = await this.getRow(+id);
    if (!row || row.deleted_at) throw new ValidationError(`Нет записи #${id}`);
    const t = String(text || "").trim();
    if (!t) throw new ValidationError("Пустой комментарий");
    const r = await this.db.query(
      "INSERT INTO node_comments (node_id, author, text, created_at) VALUES (?, ?, ?, NOW(3))", [+id, author, t],
    );
    await this.touch(+id, "comment", author === "kira" ? "kira" : "web", { comment: [null, t.slice(0, 200)] });
    return { id: r.insertId };
  }

  async comments(id) {
    const rows = await this.db.query(
      "SELECT id, author, text, created_at FROM node_comments WHERE node_id = ? AND deleted_at IS NULL ORDER BY id", [id],
    );
    return rows.map((r) => ({ id: r.id, author: r.author, text: r.text, at: formatLocal(r.created_at, this.tz) }));
  }

  async removeComment(commentId) {
    await this.db.query("UPDATE node_comments SET deleted_at = NOW(3) WHERE id = ?", [commentId]);
    return { removed: true };
  }

  // ---------- проверка входных данных ----------

  async normalize(input, old, q = this.db.query.bind(this.db)) {
    const out = {};
    if (input.kind !== undefined) {
      if (!TYPES[input.kind]) throw new ValidationError(`Неизвестный вид: ${input.kind}. Есть: ${Object.keys(TYPES).join(", ")}`);
      out.kind = input.kind;
    }
    const kind = out.kind || old?.kind;
    const t = TYPES[kind];
    if (input.title !== undefined) {
      const s = String(input.title).trim().slice(0, 500);
      if (!s) throw new ValidationError("Название не может быть пустым");
      out.title = s;
    }
    if (input.body !== undefined) out.body = input.body === null ? null : String(input.body);
    if (input.status !== undefined) {
      if (!t.statuses[input.status]) {
        throw new ValidationError(`Статус «${input.status}» не подходит для «${t.label}»: ${Object.keys(t.statuses).join(", ")}`);
      }
      out.status = input.status;
    } else if (old && out.kind && out.kind !== old.kind && !t.statuses[old.status]) {
      out.status = t.initial;
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
    // Начало (для графика) — дата без времени
    if (input.start !== undefined) {
      if (input.start === null || input.start === "") out.start_at = null;
      else {
        const d = parseLocal(`${String(input.start).slice(0, 10)} 12:00`, this.tz);
        if (!d) throw new ValidationError(`Не понял дату начала «${input.start}». Формат: ГГГГ-ММ-ДД`);
        out.start_at = d.utc;
      }
    }
    if (input.event_at !== undefined) {
      if (!input.event_at) out.event_at = null;
      else {
        const d = parseLocal(String(input.event_at).length <= 10 ? `${input.event_at} 12:00` : input.event_at, this.tz);
        if (!d) throw new ValidationError(`Не понял дату «${input.event_at}»`);
        out.event_at = d.utc;
      }
    }
    if (input.tags !== undefined) {
      const list = (Array.isArray(input.tags) ? input.tags : String(input.tags || "").split(","))
        .map((x) => String(x).trim().replace(/^#/, "").replace(/,/g, "")).filter(Boolean);
      out.tags = [...new Set(list)].join(",").slice(0, 500);
    }
    // Поля конкретного вида (вероятность риска, результат действия, телефон человека…) — в meta
    if (input.fields !== undefined || input.meta !== undefined || (old && out.kind && out.kind !== old.kind)) {
      const base = old?.meta ? safeJson(old.meta) || {} : defaultFields(kind);
      const defs = TYPES[kind]?.fields || {};
      const incoming = { ...(input.meta || {}), ...(input.fields || {}) };
      // системные поля (оценка ИИ, данные файла) обычной правкой не меняются — только изнутри системы
      if (!input.allowSystemFields) for (const k of Object.keys(incoming)) if (defs[k]?.system) delete incoming[k];
      out.meta = JSON.stringify(cleanFields(kind, { ...base, ...incoming }));
    }
    if (input.position !== undefined) out.position = Math.round(+input.position) || 0;
    if (input.parent_id !== undefined || (old && out.kind && out.kind !== old.kind)) {
      const pid = input.parent_id === undefined ? old.parent_id : input.parent_id === null || input.parent_id === "" ? null : +input.parent_id;
      if (pid !== null) {
        const p = (await q("SELECT id, kind, deleted_at, parent_id FROM nodes WHERE id = ?", [pid]))[0];
        if (!p || p.deleted_at) throw new ValidationError(`Нет родителя #${pid}`);
        if (!t.parents.includes(p.kind)) {
          throw new ValidationError(`«${t.label}» нельзя положить в «${TYPES[p.kind].label}». Можно в: ${t.parents.map((k) => TYPES[k].label).join(", ") || "никуда — это самостоятельный объект"}`);
        }
        if (kind === "task" && p.kind === "task") {
          const pp = p.parent_id ? (await q("SELECT kind FROM nodes WHERE id = ?", [p.parent_id]))[0] : null;
          if (pp?.kind === "task") throw new ValidationError("Подзадачи — только один уровень");
        }
        if (old) {
          let cur = p;
          for (let i = 0; cur && i < 50; i++) {
            if (cur.id === old.id) throw new ValidationError("Нельзя вложить запись саму в себя");
            cur = cur.parent_id ? (await q("SELECT id, parent_id FROM nodes WHERE id = ?", [cur.parent_id]))[0] : null;
          }
        }
      } else if (t.parentRequired) {
        throw new ValidationError(`«${t.label}» должна быть внутри: ${t.parents.map((k) => TYPES[k].label).join(" или ")}`);
      }
      out.parent_id = pid;
    }
    if (input.stage_id !== undefined) {
      const sid = input.stage_id ? +input.stage_id : null;
      if (sid) {
        const s = (await q("SELECT id, kind, parent_id, deleted_at FROM nodes WHERE id = ?", [sid]))[0];
        if (!s || s.deleted_at || s.kind !== "stage") throw new ValidationError(`Нет стадии #${sid}`);
        // стадия должна принадлежать тому же проекту или треку, где живёт объект
        const pid = out.parent_id !== undefined ? out.parent_id : old?.parent_id;
        const chain = pid ? (await this.path(pid)).map((p) => p.id) : [];
        if (!chain.includes(s.parent_id)) throw new ValidationError("Стадия из другого проекта или трека");
      }
      out.stage_id = sid;
    }
    return out;
  }

  toApi(r) {
    const t = TYPES[r.kind] || { label: r.kind, statuses: {}, closed: [] };
    const closed = isClosed(r.kind, r.status);
    const fields = r.meta ? safeJson(r.meta) || {} : {};
    const item = {
      id: r.id,
      kind: r.kind,
      kind_label: t.label,
      parent_id: r.parent_id,
      stage_id: r.stage_id || null,
      title: r.title,
      body: r.body,
      status: r.status,
      status_label: t.statuses[r.status] || r.status,
      priority: r.priority,
      due: r.due_at ? formatLocal(r.due_at, this.tz, !!r.due_has_time) : null,
      start: r.start_at ? formatLocal(r.start_at, this.tz, false) : null,
      overdue: !!(r.due_at && !closed && !r.deleted_at && new Date(r.due_at).getTime() < Date.now()),
      event_at: r.event_at ? formatLocal(r.event_at, this.tz) : null,
      tags: r.tags ? r.tags.split(",") : [],
      fields,
      position: r.position,
      version: r.version,
      closed,
      created: formatLocal(r.created_at, this.tz),
      updated: formatLocal(r.updated_at, this.tz),
      completed: r.completed_at ? formatLocal(r.completed_at, this.tz) : null,
      deleted: !!r.deleted_at,
    };
    if (r.kind === "risk") {
      const mine = riskScore(fields.probability, fields.impact);
      const ai = riskScore(fields.ai_probability, fields.ai_impact);
      item.risk = { mine, ai, level: riskLevel(Math.max(mine || 0, ai || 0)) };
    }
    return item;
  }
}

// ---------- помощники ----------

function defaults() {
  return { parent_id: null, stage_id: null, body: null, priority: 0, due_at: null, due_has_time: 0, start_at: null, event_at: null, tags: "", meta: null, position: 0 };
}

function defaultFields(kind) {
  const out = {};
  for (const [k, d] of Object.entries(TYPES[kind]?.fields || {})) if (d.default !== undefined) out[k] = d.default;
  return out;
}

// Оставляет только известные поля вида и приводит значения к нужному типу
function cleanFields(kind, input) {
  const defs = TYPES[kind]?.fields || {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const d = defs[k];
    if (!d) continue;
    if (v === null || v === "") { out[k] = null; continue; }
    if (d.type === "number") {
      const n = +String(v).replace(",", ".");
      if (!Number.isFinite(n)) throw new ValidationError(`«${d.label}» — число`);
      out[k] = k === "progress" ? Math.max(0, Math.min(100, Math.round(n))) : n;
    } else if (d.type === "scale") {
      const n = Math.round(+v);
      if (!(n >= 1 && n <= 5)) throw new ValidationError(`«${d.label}» — от 1 до 5`);
      out[k] = n;
    } else if (d.type === "enum") {
      if (!d.values[v]) throw new ValidationError(`«${d.label}»: ${Object.keys(d.values).join(" или ")}`);
      out[k] = v;
    } else {
      out[k] = String(v).slice(0, d.type === "text" ? 20000 : 500);
    }
  }
  return out;
}

// Для истории: поле meta раскладываем на понятные изменения полей
function readableDiff(diff) {
  if (!diff.meta) return diff;
  const out = { ...diff };
  delete out.meta;
  const [a, b] = diff.meta.map((x) => (x ? safeJson(x) || {} : {}));
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out[`fields.${k}`] = [a[k] ?? null, b[k] ?? null];
  }
  return out;
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

export function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
