// Задания Киры — то, что она должна сделать сама в нужное время, без команды.
//
// Каждое задание:
//   номер, когда создано, кем (владелец / Кира / система),
//   когда выполнять — разово (дата и время) или регулярно (cron по местному времени или «каждые N минут»),
//   что сделать — название и подробная инструкция,
//   как: «напомнить» (отправить текст как есть) или «выполнить» (Кира думает и действует инструментами),
//   связанные объекты (задачи, проекты…), статус исполнения последнего запуска, статус задания.
//
// Всё хранится во времени: каждое изменение задания — в job_history, каждый запуск — в job_runs_log.

import { parseLocal, formatLocal } from "../time.js";
import { parseCron, nextCron, describeCron, describeInterval } from "../cron.js";
import { ValidationError } from "../nodes.js";

export const JOB_STATUS = { active: "Активно", done: "Выполнено", cancelled: "Отменено" };
export const EXEC_STATUS = {
  scheduled: "Ожидает", running: "Выполняется", succeeded: "Успешно", failed: "Ошибка",
  retrying: "Повтор после ошибки", skipped: "Пропущено",
};
export const CREATORS = { owner: "Владелец", kira: "Кира", system: "Система" };
export const ACTIONS = { remind: "Напомнить", do: "Выполнить" };

const MAX_ACTIVE = 300;
const FIELDS = ["title", "instruction", "message", "action", "schedule", "run_at", "cron", "interval_min", "until_at", "max_runs", "links", "status"];

export class JobsModel {
  constructor(db, tz) {
    this.db = db;
    this.tz = tz;
  }

  async row(id, q = this.db.query.bind(this.db)) {
    return (await q("SELECT * FROM jobs WHERE id = ?", [id]))[0] || null;
  }

  async get(id) {
    const r = await this.row(id);
    return r ? this.toApi(r, await this.linkTitles([r])) : null;
  }

  async getBySystemKey(key) {
    const r = (await this.db.query("SELECT * FROM jobs WHERE system_key = ?", [key]))[0];
    return r ? this.toApi(r, {}) : null;
  }

  async list({ status, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status) {
      const ss = Array.isArray(status) ? status : [status];
      where.push(`status IN (${ss.map(() => "?").join(",")})`);
      params.push(...ss);
    }
    const rows = await this.db.query(
      `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY (status <> 'active'), (next_run_at IS NULL), next_run_at, id DESC LIMIT ?`,
      [...params, Math.min(+limit || 200, 1000)],
    );
    const titles = await this.linkTitles(rows);
    return rows.map((r) => this.toApi(r, titles));
  }

  async runs(id, limit = 30) {
    const rows = await this.db.query(
      "SELECT * FROM job_runs_log WHERE job_id = ? ORDER BY id DESC LIMIT ?", [id, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      planned: r.planned_at ? formatLocal(r.planned_at, this.tz) : null,
      started: formatLocal(r.started_at, this.tz),
      finished: r.finished_at ? formatLocal(r.finished_at, this.tz) : null,
      status: r.status, status_text: EXEC_STATUS[r.status] || r.status,
      result: r.result,
      meta: r.meta ? safeJson(r.meta) : null,
    }));
  }

  async history(id) {
    const rows = await this.db.query(
      "SELECT version, action, source, changed_at, diff FROM job_history WHERE job_id = ? ORDER BY version DESC LIMIT 100", [id],
    );
    return rows.map((r) => ({
      version: r.version, action: r.action, source: r.source, at_local: formatLocal(r.changed_at, this.tz),
      changes: r.diff ? JSON.parse(r.diff) : null,
    }));
  }

  // ---------- запись ----------

  async create(input, source = "web") {
    const [{ n }] = await this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE status = 'active'");
    if (n >= MAX_ACTIVE) throw new ValidationError(`Слишком много активных заданий (${n}). Отмени ненужные.`);
    const data = await this.normalize(input, null);
    if (!data.title) throw new ValidationError("Нужно описать, что сделать (title)");
    if (!data.schedule) throw new ValidationError("Нужно указать, когда выполнить: run_at, cron или every_minutes");
    const now = new Date();
    const createdBy = CREATORS[input.created_by] ? input.created_by : source === "web" ? "owner" : "kira";
    const row = {
      instruction: null, message: null, action: "do", run_at: null, cron: null, interval_min: null, until_at: null, max_runs: null,
      links: "", status: "active", ...data,
    };
    row.next_run_at = this.computeNext(row, now, true);
    if (row.schedule === "once" && row.next_run_at === null) throw new ValidationError("Не указано время выполнения");
    return this.db.tx(async (q) => {
      const res = await q(
        `INSERT INTO jobs (${FIELDS.join(",")}, created_at, created_by, next_run_at, exec_status, system_key, version, updated_at)
         VALUES (${FIELDS.map(() => "?").join(",")}, ?, ?, ?, 'scheduled', ?, 1, ?)`,
        [...FIELDS.map((f) => row[f]), now, createdBy, row.next_run_at, input.system_key || null, now],
      );
      const created = await this.row(res.insertId, q);
      await this.record(q, created, "create", source, null);
      return this.toApi(created, await this.linkTitles([created]));
    });
  }

  async update(id, patch, source = "web") {
    return this.db.tx(async (q) => {
      const old = (await q("SELECT * FROM jobs WHERE id = ? FOR UPDATE", [id]))[0];
      if (!old) throw new ValidationError(`Нет задания #${id}`);
      const data = await this.normalize(patch, old);
      const diff = {};
      for (const f of FIELDS) {
        if (data[f] === undefined) continue;
        if (!same(old[f], data[f])) diff[f] = [plain(old[f]), plain(data[f])];
      }
      if (!Object.keys(diff).length) return this.toApi(old, await this.linkTitles([old]));
      const merged = { ...old, ...data };
      const scheduleChanged = ["schedule", "run_at", "cron", "interval_min", "until_at", "max_runs"].some((f) => diff[f]);
      let next = old.next_run_at;
      let exec = old.exec_status;
      if (merged.status !== "active") next = null;
      else if (scheduleChanged || diff.status) {
        next = this.computeNext({ ...merged, run_count: old.run_count }, new Date(), true);
        exec = "scheduled";
        if (next) diff.next_run_at = [plain(old.next_run_at), next.toISOString()];
      }
      const sets = Object.keys(diff).filter((f) => f !== "next_run_at").map((f) => `${f} = ?`);
      const vals = Object.keys(diff).filter((f) => f !== "next_run_at").map((f) => data[f]);
      await q(
        `UPDATE jobs SET ${sets.join(", ")}${sets.length ? "," : ""} next_run_at = ?, exec_status = ?, fail_streak = ?,
         version = version + 1, updated_at = ? WHERE id = ?`,
        [...vals, next, exec, scheduleChanged || diff.status ? 0 : old.fail_streak, new Date(), id],
      );
      const fresh = await this.row(id, q);
      await this.record(q, fresh, "update", source, diff);
      return this.toApi(fresh, await this.linkTitles([fresh]));
    });
  }

  async record(q, row, action, source, diff) {
    await q(
      "INSERT INTO job_history (job_id, version, action, source, changed_at, diff, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.version, action, source, row.updated_at, diff ? JSON.stringify(diff) : null, JSON.stringify(snapshot(row))],
    );
  }

  // ---------- расписание ----------

  // Когда следующий запуск. first=true — для нового задания или изменённого расписания.
  computeNext(job, after, first = false) {
    if (job.status && job.status !== "active") return null;
    let next = null;
    if (job.schedule === "once") {
      next = first ? (job.run_at ? new Date(job.run_at) : null) : null;
      if (next && first && next.getTime() < Date.now() - 60000) next = new Date(); // время уже прошло — выполнить сразу
    } else if (job.schedule === "cron") {
      next = nextCron(job.cron, after, this.tz);
    } else if (job.schedule === "interval") {
      const base = first && job.run_at ? new Date(job.run_at) : new Date(after.getTime() + job.interval_min * 60000);
      next = base.getTime() < Date.now() && first ? new Date() : base;
    }
    if (next && job.until_at && next.getTime() > new Date(job.until_at).getTime()) return null;
    if (next && job.max_runs && (job.run_count || 0) >= job.max_runs) return null;
    return next;
  }

  // ---------- исполнение (для планировщика) ----------

  async due(limit = 5) {
    return this.db.query(
      `SELECT * FROM jobs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= NOW(3)
       AND (lock_until IS NULL OR lock_until < NOW(3)) ORDER BY next_run_at LIMIT ?`, [limit],
    );
  }

  // Занять задание: true — его выполняет этот процесс (другие копии приложения его не возьмут)
  async claim(id, minutes = 10) {
    const r = await this.db.query(
      `UPDATE jobs SET lock_until = NOW(3) + INTERVAL ? MINUTE, exec_status = 'running'
       WHERE id = ? AND status = 'active' AND next_run_at <= NOW(3) AND (lock_until IS NULL OR lock_until < NOW(3))`,
      [minutes, id],
    );
    return r.affectedRows === 1;
  }

  async startRun(job) {
    const r = await this.db.query(
      "INSERT INTO job_runs_log (job_id, planned_at, started_at, status) VALUES (?, ?, NOW(3), 'running')",
      [job.id, job.next_run_at],
    );
    return r.insertId;
  }

  // Итог запуска: записать, посчитать следующий запуск, при необходимости закрыть задание
  async finish(job, runId, { status, result = null, meta = null }) {
    const now = new Date();
    await this.db.query(
      "UPDATE job_runs_log SET finished_at = NOW(3), status = ?, result = ?, meta = ? WHERE id = ?",
      [status, result, meta ? JSON.stringify(meta) : null, runId],
    );
    const ran = status === "succeeded" || status === "failed";
    const runCount = job.run_count + (ran ? 1 : 0);
    let failStreak = status === "failed" ? job.fail_streak + 1 : 0;
    let exec = status;
    let next;
    let jobStatus = job.status;
    if (status === "failed" && failStreak < 3) {
      next = new Date(now.getTime() + 5 * 60000 * failStreak); // повтор через 5, потом 10 минут
      exec = "retrying";
    } else if (job.schedule === "once") {
      next = null;
      if (status === "succeeded") jobStatus = "done";
    } else {
      next = this.computeNext({ ...job, run_count: runCount }, now);
      if (!next) jobStatus = "done"; // кончился срок или число повторов
      if (status === "failed") failStreak = 0; // регулярное — дальше по расписанию
    }
    await this.db.tx(async (q) => {
      await q(
        `UPDATE jobs SET last_run_at = NOW(3), run_count = ?, fail_streak = ?, exec_status = ?, last_result = ?,
         next_run_at = ?, status = ?, lock_until = NULL, version = version + 1, updated_at = NOW(3) WHERE id = ?`,
        [runCount, failStreak, exec, result, next, jobStatus, job.id],
      );
      const fresh = await this.row(job.id, q);
      await this.record(q, fresh, "run", "system", { exec_status: [job.exec_status, exec], ...(jobStatus !== job.status ? { status: [job.status, jobStatus] } : {}) });
    });
    return { next, exec, jobStatus, finalFailure: status === "failed" && exec === "failed" };
  }

  // ---------- приведение входных данных ----------

  async normalize(input, old) {
    const out = {};
    if (input.title !== undefined) {
      const t = String(input.title).trim().slice(0, 300);
      if (!t) throw new ValidationError("Название задания не может быть пустым");
      out.title = t;
    }
    if (input.instruction !== undefined) out.instruction = input.instruction ? String(input.instruction) : null;
    if (input.message !== undefined) out.message = cleanMessage(input.message);
    if (input.action !== undefined) {
      if (!ACTIONS[input.action]) throw new ValidationError("action: remind (напомнить текстом) или do (выполнить)");
      out.action = input.action;
    }
    if (input.status !== undefined) {
      if (!JOB_STATUS[input.status]) throw new ValidationError("Статус: active, done или cancelled");
      out.status = input.status;
    }
    // Расписание: run_at — разово; cron — регулярно; every_minutes — с интервалом
    const hasCron = input.cron !== undefined && input.cron !== null && input.cron !== "";
    const hasEvery = input.every_minutes !== undefined && input.every_minutes !== null && input.every_minutes !== "";
    const hasAt = input.run_at !== undefined && input.run_at !== null && input.run_at !== "";
    if (hasCron && hasEvery) throw new ValidationError("Укажи что-то одно: cron или every_minutes");
    if (hasAt) {
      const d = parseLocal(input.run_at, this.tz);
      if (!d) throw new ValidationError(`Не понял время «${input.run_at}». Формат: ГГГГ-ММ-ДД ЧЧ:ММ`);
      out.run_at = d.hasTime ? d.utc : parseLocal(`${String(input.run_at).slice(0, 10)} 09:00`, this.tz).utc;
    }
    if (hasCron) {
      parseCron(input.cron); // проверка
      out.cron = String(input.cron).trim().split(/\s+/).join(" ");
      out.schedule = "cron"; out.interval_min = null;
    } else if (hasEvery) {
      const m = Math.round(+input.every_minutes);
      if (!(m >= 5 && m <= 525600)) throw new ValidationError("every_minutes — от 5 минут до года");
      out.interval_min = m; out.schedule = "interval"; out.cron = null;
    } else if (hasAt) {
      out.schedule = "once"; out.cron = null; out.interval_min = null;
    }
    if (input.until !== undefined) {
      if (!input.until) out.until_at = null;
      else {
        const d = parseLocal(String(input.until).length <= 10 ? `${input.until} 23:59` : input.until, this.tz);
        if (!d) throw new ValidationError(`Не понял дату окончания «${input.until}»`);
        out.until_at = d.utc;
      }
    }
    if (input.max_runs !== undefined) out.max_runs = input.max_runs ? Math.max(1, Math.round(+input.max_runs)) : null;
    if (input.links !== undefined) {
      const ids = (Array.isArray(input.links) ? input.links : String(input.links || "").split(","))
        .map((x) => +String(x).replace(/^#/, "")).filter((x) => Number.isInteger(x) && x > 0);
      out.links = [...new Set(ids)].slice(0, 30).join(",");
    }
    return out;
  }

  async linkTitles(rows) {
    const ids = [...new Set(rows.flatMap((r) => (r.links ? r.links.split(",").map(Number) : [])))];
    if (!ids.length) return {};
    const nodes = await this.db.query(`SELECT id, kind, title FROM nodes WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return Object.fromEntries(nodes.map((n) => [n.id, { kind: n.kind, title: n.title }]));
  }

  describeSchedule(r) {
    if (r.schedule === "once") return `разово, ${formatLocal(r.run_at, this.tz)}`;
    let s = r.schedule === "cron" ? describeCron(r.cron) : describeInterval(r.interval_min);
    if (r.until_at) s += `, до ${formatLocal(r.until_at, this.tz, false)}`;
    if (r.max_runs) s += `, не больше ${r.max_runs} раз`;
    return s;
  }

  toApi(r, titles = {}) {
    const links = r.links ? r.links.split(",").map(Number) : [];
    return {
      id: r.id,
      title: r.title,
      instruction: r.instruction,
      message: r.message || null,
      action: r.action, action_text: ACTIONS[r.action],
      created: formatLocal(r.created_at, this.tz),
      created_by: r.created_by, created_by_text: CREATORS[r.created_by] || r.created_by,
      schedule: r.schedule,
      schedule_text: this.describeSchedule(r),
      run_at: r.run_at ? formatLocal(r.run_at, this.tz) : null,
      cron: r.cron, every_minutes: r.interval_min,
      until: r.until_at ? formatLocal(r.until_at, this.tz, false) : null,
      max_runs: r.max_runs,
      next_run: r.next_run_at ? formatLocal(r.next_run_at, this.tz) : null,
      last_run: r.last_run_at ? formatLocal(r.last_run_at, this.tz) : null,
      run_count: r.run_count,
      exec_status: r.exec_status, exec_status_text: EXEC_STATUS[r.exec_status] || r.exec_status,
      last_result: r.last_result,
      status: r.status, status_text: JOB_STATUS[r.status] || r.status,
      links: links.map((id) => ({ id, kind: titles[id]?.kind || null, title: titles[id]?.title || null })),
      system: !!r.system_key,
      system_key: r.system_key,
      version: r.version,
      updated: formatLocal(r.updated_at, this.tz),
    };
  }
}

function plain(v) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

function same(a, b) {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

// Текст напоминания — ровно то, что получит владелец: без кавычек вокруг и пробелов по краям
export function cleanMessage(v) {
  let t = String(v ?? "").trim();
  for (;;) {
    const m = t.match(/^[«"“„'](.*)[»"”“']$/s);
    if (!m) break;
    t = m[1].trim();
  }
  return t ? t.slice(0, 1000) : null;
}

function snapshot(row) {
  const s = {};
  for (const [k, v] of Object.entries(row)) s[k] = plain(v);
  return s;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
