// Планировщик проектов (как MS Project): строки графика, связи между задачами, автосдвиг, базовые планы.
//
// Что попадает на график: треки и проекты (сводные строки), этапы, миссии, задачи (и подзадачи) — полосы,
// цели — вехи (ромбики). Риски на график не выводятся полосами — они показываются у своего этапа.
// Куда строка вкладывается: если у объекта указан этап (stage_id) — под этот этап, иначе — под родителя.
// Сводные строки (этап, миссия, задача с подзадачами, проект, трек) получают даты от вложенных;
// перенос сводной строки переносит всё, что в ней.

import { formatLocal } from "../time.js";
import { ValidationError } from "../nodes.js";
import { riskScore, riskLevel, isClosed } from "../pm/schema.js";
import { dayNum, dayStr, propagate, createsCycle, violations, LINK_TYPES, DHX_TYPE } from "./schedule.js";

const PLAN_KINDS = new Set(["track", "project", "stage", "mission", "task", "goal"]);
const GROUP_KINDS = new Set(["track", "project"]);
const SKIP_STATUS = { task: ["cancelled"], goal: ["dropped"], mission: ["cancelled"], project: ["cancelled", "archived"], track: ["archived"] };

export function createPlanner({ db, nodes, tz }) {
  // ---------- загрузка ----------
  async function load() {
    const rows = await db.query("SELECT * FROM nodes WHERE deleted_at IS NULL");
    const byId = new Map();
    for (const r of rows) {
      const fields = r.meta ? safeJson(r.meta) || {} : {};
      const start = r.start_at ? formatLocal(r.start_at, tz, false) : null;
      const due = r.due_at ? formatLocal(r.due_at, tz, false) : null;
      byId.set(r.id, {
        id: r.id, kind: r.kind, title: r.title, status: r.status, parent_id: r.parent_id, stage_id: r.stage_id,
        position: r.position, fields, start, due, dueTime: r.due_at && r.due_has_time ? formatLocal(r.due_at, tz).slice(11) : null,
        closed: isClosed(r.kind, r.status), row: r,
      });
    }
    const links = (await db.query("SELECT * FROM plan_links WHERE removed_at IS NULL ORDER BY id"))
      .filter((l) => byId.has(l.pred_id) && byId.has(l.succ_id))
      .map((l) => ({ id: l.id, pred_id: l.pred_id, succ_id: l.succ_id, type: l.type, lag: l.lag_days }));
    // куда строка вкладывается на графике
    for (const n of byId.values()) {
      const st = n.stage_id && byId.get(n.stage_id);
      n.planParent = st && st.kind === "stage" && n.kind !== "stage" ? st.id : n.parent_id;
    }
    const kids = new Map();
    for (const n of byId.values()) {
      if (!visible(n)) continue;
      if (!kids.has(n.planParent)) kids.set(n.planParent, []);
      kids.get(n.planParent).push(n);
    }
    // свои даты (у листьев) и сводные (у групп)
    const span = new Map();
    const calc = (n, depth = 0) => {
      if (span.has(n.id)) return span.get(n.id);
      span.set(n.id, null); // защита от циклов
      let s = null;
      let f = null;
      let any = false;
      for (const c of kids.get(n.id) || []) {
        if (depth > 30) break;
        const cs = calc(c, depth + 1);
        if (!cs) continue;
        any = true;
        s = s === null ? cs.start : Math.min(s, cs.start);
        f = f === null ? cs.finish : Math.max(f, cs.finish);
      }
      let res = null;
      if (any) res = { start: s, finish: f, summary: true };
      else if (n.kind === "goal") res = n.due ? { start: dayNum(n.due), finish: dayNum(n.due), milestone: true } : null;
      else if (!GROUP_KINDS.has(n.kind) && (n.start || n.due)) {
        const a = dayNum(n.start || n.due);
        const b = dayNum(n.due || n.start);
        res = { start: Math.min(a, b), finish: Math.max(a, b) };
      }
      span.set(n.id, res);
      return res;
    };
    for (const n of byId.values()) if (visible(n)) calc(n);
    return { byId, links, kids, span };
  }

  function visible(n) {
    return PLAN_KINDS.has(n.kind) && !(SKIP_STATUS[n.kind] || []).includes(n.status);
  }

  // ---------- график ----------
  // rootId — трек или проект; без него — все открытые треки и проекты верхнего уровня
  async function getPlan(rootId) {
    const data = await load();
    const { byId, kids, span, links } = data;
    let roots;
    if (rootId) {
      const r = byId.get(+rootId);
      if (!r) throw new ValidationError(`Нет записи #${rootId}`);
      if (!GROUP_KINDS.has(r.kind) && r.kind !== "mission") throw new ValidationError("График строится для трека, проекта или миссии");
      roots = [r];
    } else {
      roots = [...byId.values()].filter((n) => GROUP_KINDS.has(n.kind) && visible(n) && !n.closed
        && (!n.parent_id || !byId.get(n.parent_id) || !visible(byId.get(n.parent_id))))
        .sort((a, b) => (span.get(a.id)?.start ?? 1e9) - (span.get(b.id)?.start ?? 1e9) || a.position - b.position || a.id - b.id);
    }
    const baseline = await baselineMap();
    const risks = risksByHome(byId);
    const rows = [];
    const undated = [];
    const included = new Set();
    const walk = (n, parent) => {
      const sp = span.get(n.id);
      if (!sp) {
        if (!GROUP_KINDS.has(n.kind) && !n.closed) undated.push({ id: n.id, kind: n.kind, title: n.title, home: parent ? byId.get(parent)?.title : null });
        // у сводной без дат может быть что-то вложенное без дат — тоже в список
        for (const c of kids.get(n.id) || []) if (!span.get(c.id)) walk(c, n.id);
        return;
      }
      included.add(n.id);
      rows.push(rowOf(n, sp, parent, data, baseline, risks));
      const children = (kids.get(n.id) || []).slice().sort((a, b) => order(a, b, span));
      for (const c of children) walk(c, n.id);
    };
    for (const r of roots) walk(r, 0);
    const preds = new Map();
    for (const l of links) {
      if (!included.has(l.succ_id)) continue;
      if (!preds.has(l.succ_id)) preds.set(l.succ_id, []);
      preds.get(l.succ_id).push(l);
    }
    for (const row of rows) row.preds = (preds.get(row.id) || []).map((l) => ({ id: l.pred_id, type: l.type, lag: l.lag }));
    const shownLinks = links.filter((l) => included.has(l.pred_id) && included.has(l.succ_id));
    const bad = violations(itemsFor(data), shownLinks).map((v) => ({ link_id: v.link.id, days: v.days }));
    const bl = rootId ? await latestBaseline(+rootId) : null;
    return {
      root: rootId ? { id: roots[0].id, kind: roots[0].kind, title: roots[0].title } : null,
      rows, undated,
      links: shownLinks.map((l) => ({ id: l.id, source: l.pred_id, target: l.succ_id, type: DHX_TYPE[l.type] || "0", lag: l.lag, kind: l.type })),
      violations: bad,
      baseline: bl,
      today: formatLocal(new Date(), tz, false),
    };
  }

  function order(a, b, span) {
    const rank = (n) => (n.kind === "stage" ? 0 : n.kind === "project" ? 1 : n.kind === "mission" ? 2 : 3);
    if (a.kind === "stage" && b.kind === "stage") return (span.get(a.id)?.start ?? 1e9) - (span.get(b.id)?.start ?? 1e9) || a.position - b.position || a.id - b.id;
    return rank(a) - rank(b) || (span.get(a.id)?.start ?? 1e9) - (span.get(b.id)?.start ?? 1e9)
      || (a.kind === "goal") - (b.kind === "goal") || a.position - b.position || a.id - b.id;
  }

  function rowOf(n, sp, parent, data, baseline, risks) {
    const type = sp.milestone ? "milestone" : sp.summary || GROUP_KINDS.has(n.kind) ? "project" : "task";
    const dur = sp.finish - sp.start + 1;
    const b = baseline.get(n.id);
    const r = (risks.get(n.id) || []);
    return {
      id: n.id, text: n.title, kind: n.kind, status: n.status, closed: n.closed,
      type, parent, open: true,
      start: dayStr(sp.start), finish: dayStr(sp.finish), days: sp.milestone ? 0 : dur,
      start_date: dayStr(sp.start), duration: sp.milestone ? 0 : dur,
      progress: progressOf(n, sp, data),
      ...(n.kind === "goal" ? { goal_type: n.fields.goal_type || "milestone" } : {}),
      ...(b ? { baseline: b, variance: (sp.finish - dayNum(b.finish)) } : {}),
      ...(r.length ? { risks: r } : {}),
      ...(n.dueTime ? { due_time: n.dueTime } : {}),
    };
  }

  function progressOf(n, sp, data) {
    if (n.closed && ["done", "achieved"].includes(n.status)) return 1;
    if (!sp.summary) return Math.max(0, Math.min(100, +n.fields.progress || 0)) / 100;
    // сводная — по длительности вложенных листьев
    let w = 0;
    let done = 0;
    const visit = (id, depth = 0) => {
      for (const c of data.kids.get(id) || []) {
        const cs = data.span.get(c.id);
        if (!cs || depth > 30) continue;
        if (cs.summary) { visit(c.id, depth + 1); continue; }
        if (cs.milestone) continue;
        const d = cs.finish - cs.start + 1;
        w += d;
        done += d * progressOf(c, cs, data);
      }
    };
    visit(n.id);
    return w ? Math.round((done / w) * 100) / 100 : 0;
  }

  // Открытые риски — у своего этапа, иначе у проекта/трека/миссии, где они живут
  function risksByHome(byId) {
    const out = new Map();
    for (const n of byId.values()) {
      if (n.kind !== "risk" || n.closed) continue;
      const home = n.stage_id && byId.get(n.stage_id)?.kind === "stage" ? n.stage_id : n.parent_id;
      const mine = riskScore(n.fields.probability, n.fields.impact);
      const ai = riskScore(n.fields.ai_probability, n.fields.ai_impact);
      const level = riskLevel(Math.max(mine || 0, ai || 0));
      if (!out.has(home)) out.set(home, []);
      out.get(home).push({ id: n.id, title: n.title, level, status: n.status });
    }
    return out;
  }

  function itemsFor(data) {
    const items = new Map();
    for (const [id, sp] of data.span) if (sp) items.set(id, { ...sp });
    return items;
  }

  // ---------- изменения ----------
  // Перенести/растянуть объект. patch: {start, finish, days, progress}. dryRun — только посчитать, что уедет.
  async function move(id, patch = {}, { dryRun = false, source = "web" } = {}) {
    const data = await load();
    const n = data.byId.get(+id);
    if (!n) throw new ValidationError(`Нет записи #${id}`);
    if (!visible(n) || GROUP_KINDS.has(n.kind) && !data.span.get(n.id)) throw new ValidationError("Этот объект не стоит на графике");
    const items = itemsFor(data);
    const cur = items.get(n.id);
    const changed = new Map();
    const touch = (nid, to) => {
      const it = items.get(nid);
      if (!changed.has(nid)) changed.set(nid, { from: { start: it.start, finish: it.finish } });
      it.start = to.start;
      it.finish = to.finish;
      changed.get(nid).to = { start: it.start, finish: it.finish };
    };
    let starts = [];
    if (patch.start !== undefined || patch.finish !== undefined || patch.days !== undefined) {
      const s = patch.start ? dayNum(String(patch.start)) : null;
      const f = patch.finish ? dayNum(String(patch.finish)) : null;
      if (!cur) {
        // у объекта ещё нет дат — ставим
        if (n.kind === "goal") { const d = f ?? s; if (d == null) throw new ValidationError("Укажи дату"); items.set(n.id, { start: d, finish: d, milestone: true }); }
        else {
          const a = s ?? f;
          if (a == null) throw new ValidationError("Укажи дату начала или окончания");
          const b = f ?? (patch.days ? a + Math.max(1, +patch.days) - 1 : a);
          items.set(n.id, { start: a, finish: Math.max(a, b) });
        }
        changed.set(n.id, { from: { start: null, finish: null }, to: { ...items.get(n.id) } });
        starts = [n.id];
      } else if (cur.summary) {
        // сводную — переносим целиком вместе со всем вложенным
        const delta = s != null ? s - cur.start : f != null ? f - cur.finish : 0;
        if (delta) for (const leaf of leaves(data, n.id)) {
          const it = items.get(leaf);
          touch(leaf, { start: it.start + delta, finish: it.finish + delta });
          starts.push(leaf);
        }
      } else if (cur.milestone) {
        const d = f ?? s;
        if (d != null && d !== cur.start) { touch(n.id, { start: d, finish: d }); starts = [n.id]; }
      } else {
        const dur = cur.finish - cur.start + 1;
        const a = s ?? (f != null && patch.days ? f - (+patch.days) + 1 : cur.start);
        let b = f ?? (patch.days ? a + Math.max(1, +patch.days) - 1 : a + dur - 1);
        if (b < a) b = a;
        if (a !== cur.start || b !== cur.finish) { touch(n.id, { start: a, finish: b }); starts = [n.id]; }
      }
    }
    // автосдвиг последователей
    const moved = propagate(items, data.links, starts);
    for (const [k, v] of moved) {
      if (!changed.has(k)) changed.set(k, v);
      else changed.get(k).to = v.to;
    }
    const list = [...changed].map(([k, v]) => ({
      id: k, title: data.byId.get(k).title, kind: data.byId.get(k).kind,
      from: { start: v.from.start == null ? null : dayStr(v.from.start), finish: v.from.finish == null ? null : dayStr(v.from.finish) },
      to: { start: dayStr(v.to.start), finish: dayStr(v.to.finish) },
      shifted_days: v.from.start == null ? null : v.to.start - v.from.start,
    }));
    if (!dryRun) {
      for (const c of list) await writeDates(data.byId.get(c.id), c.to, source);
      if (patch.progress !== undefined && patch.progress !== null) {
        const p = Math.max(0, Math.min(100, Math.round(+patch.progress)));
        if (["task", "stage", "mission"].includes(n.kind)) await nodes.update(n.id, { fields: { progress: p } }, source);
      }
      await syncStages(source);
    }
    return { changed: list, dry_run: !!dryRun };
  }

  function leaves(data, id, depth = 0) {
    const out = [];
    for (const c of data.kids.get(id) || []) {
      const sp = data.span.get(c.id);
      if (!sp || depth > 30) continue;
      if (sp.summary) out.push(...leaves(data, c.id, depth + 1));
      else out.push(c.id);
    }
    return out;
  }

  async function writeDates(n, to, source) {
    if (n.kind === "goal") {
      await nodes.update(n.id, { due: to.finish + (n.dueTime ? ` ${n.dueTime}` : "") }, source);
      return;
    }
    await nodes.update(n.id, { start: to.start, due: to.finish + (n.dueTime ? ` ${n.dueTime}` : "") }, source);
  }

  // Этап хранит свои даты = от начала первой до конца последней вложенной задачи (чтобы этап
  // и его цель были видны с правильными сроками и вне графика)
  async function syncStages(source) {
    const data = await load();
    for (const n of data.byId.values()) {
      if (n.kind !== "stage") continue;
      const sp = data.span.get(n.id);
      if (!sp || !sp.summary) continue;
      const s = dayStr(sp.start);
      const f = dayStr(sp.finish);
      if (n.start !== s || n.due !== f) await nodes.update(n.id, { start: s, due: f }, source === "web" ? "web" : source);
    }
  }

  // ---------- связи ----------
  async function addLink({ pred_id, succ_id, type = "FS", lag = 0 }, { source = "web" } = {}) {
    const t = String(type || "FS").toUpperCase();
    if (!LINK_TYPES[t]) throw new ValidationError("Тип связи: FS, SS, FF или SF");
    const data = await load();
    const p = data.byId.get(+pred_id);
    const s = data.byId.get(+succ_id);
    if (!p || !s) throw new ValidationError("Нет такой задачи");
    for (const x of [p, s]) {
      if (!visible(x) || GROUP_KINDS.has(x.kind)) throw new ValidationError(`«${x.title}» нельзя связывать — это ${x.kind === "project" ? "проект" : "трек"}`);
      if (data.span.get(x.id)?.summary) throw new ValidationError(`«${x.title}» — сводная строка (в ней есть задачи); свяжи задачи внутри неё`);
    }
    if (createsCycle(data.links, p.id, s.id)) throw new ValidationError("Получится замкнутый круг связей");
    const dup = data.links.find((l) => l.pred_id === p.id && l.succ_id === s.id);
    if (dup) {
      await db.query("UPDATE plan_links SET type = ?, lag_days = ? WHERE id = ?", [t, Math.round(+lag || 0), dup.id]);
    } else {
      await db.query("INSERT INTO plan_links (pred_id, succ_id, type, lag_days, created_at, created_by) VALUES (?, ?, ?, ?, NOW(3), ?)",
        [p.id, s.id, t, Math.round(+lag || 0), source]);
    }
    const changed = await propagateFrom([p.id], source); // последователь мог оказаться раньше допустимого — сдвинуть
    return { link: { pred_id: p.id, succ_id: s.id, type: t, lag: Math.round(+lag || 0) }, changed };
  }

  async function propagateFrom(ids, source) {
    const data = await load();
    const items = itemsFor(data);
    const moved = propagate(items, data.links, ids);
    const list = [];
    for (const [k, v] of moved) {
      const n = data.byId.get(k);
      const to = { start: dayStr(v.to.start), finish: dayStr(v.to.finish) };
      await writeDates(n, to, source);
      list.push({ id: k, title: n.title, kind: n.kind, from: { start: dayStr(v.from.start), finish: dayStr(v.from.finish) }, to, shifted_days: v.to.start - v.from.start });
    }
    if (list.length) await syncStages(source);
    return list;
  }

  async function removeLink({ id, pred_id, succ_id }) {
    const r = id
      ? await db.query("UPDATE plan_links SET removed_at = NOW(3) WHERE id = ? AND removed_at IS NULL", [+id])
      : await db.query("UPDATE plan_links SET removed_at = NOW(3) WHERE pred_id = ? AND succ_id = ? AND removed_at IS NULL", [+pred_id, +succ_id]);
    return { removed: r.affectedRows };
  }

  // ---------- базовый план ----------
  async function saveBaseline(rootId, name, { source = "web" } = {}) {
    const plan = await getPlan(rootId);
    if (!plan.rows.length) throw new ValidationError("На графике пока нечего фиксировать");
    const title = String(name || `Базовый план от ${formatLocal(new Date(), tz)}`).slice(0, 200);
    const r = await db.query("INSERT INTO plan_baselines (root_id, name, created_at, created_by) VALUES (?, ?, NOW(3), ?)", [+rootId, title, source]);
    for (const row of plan.rows) {
      await db.query("INSERT INTO plan_baseline_items (baseline_id, node_id, start_date, finish_date) VALUES (?, ?, ?, ?)", [r.insertId, row.id, row.start, row.finish]);
    }
    return { id: r.insertId, name: title, items: plan.rows.length };
  }

  async function latestBaseline(rootId) {
    const [b] = await db.query("SELECT * FROM plan_baselines WHERE root_id = ? ORDER BY id DESC LIMIT 1", [rootId]);
    return b ? { id: b.id, name: b.name, created: formatLocal(b.created_at, tz) } : null;
  }

  // Последний базовый план каждого проекта/трека: node_id → {start, finish}
  async function baselineMap() {
    const out = new Map();
    const latest = await db.query("SELECT MAX(id) AS id FROM plan_baselines GROUP BY root_id ORDER BY MAX(id)");
    for (const b of latest) {
      const items = await db.query("SELECT node_id, start_date, finish_date FROM plan_baseline_items WHERE baseline_id = ?", [b.id]);
      const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
      for (const it of items) if (it.start_date) out.set(it.node_id, { start: d(it.start_date), finish: d(it.finish_date || it.start_date) });
    }
    return out;
  }

  // ---------- план целиком (для Киры): этапы, задачи с длительностями и связями, вехи, риски этапов ----------
  // spec: { start, stages: [{ title, start?, days?, goals: [{title, date?}], risks: [{title, probability?, impact?, mitigation?}],
  //         tasks: [{ key?, title, days, start?, after?: [key|id], progress? }] }], final_goal?: {title, date?} }
  async function buildPlan(rootId, spec = {}, { source = "kira" } = {}) {
    const root = await nodes.get(+rootId);
    if (!root || !["project", "track", "mission"].includes(root.kind)) throw new ValidationError("План строится для проекта, трека или миссии");
    const startDay = spec.start ? dayNum(String(spec.start)) : dayNum(formatLocal(new Date(), tz, false));
    const stagesSpec = Array.isArray(spec.stages) ? spec.stages : [];
    if (!stagesSpec.length) throw new ValidationError("Нужен хотя бы один этап (stages)");
    if (root.kind === "mission" && stagesSpec.length > 1) throw new ValidationError("У миссии нет этапов — передай один блок задач");
    const keyed = new Map(); // ключ задачи → {id, start, finish}
    const links = [];
    const created = { stages: 0, tasks: 0, goals: 0, risks: 0, links: 0 };
    const summary = [];
    let prevEnd = startDay - 1;
    let prevEndTasks = await lastStageEnd(root.id, startDay); // план строится частями — продолжаем от предыдущего этапа
    const mk = (input) => nodes.create({ ...input, parent_id: root.id }, source);
    // уже существующие этапы и цели с теми же названиями — используем, а не плодим дубли
    const norm = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const existing = (await db.query("SELECT id, kind, title FROM nodes WHERE parent_id = ? AND kind IN ('stage', 'goal') AND deleted_at IS NULL", [root.id]));
    const findExisting = (kind, title) => existing.find((e) => e.kind === kind && norm(e.title) === norm(title));
    let reused = 0;
    for (const [i, st] of stagesSpec.entries()) {
      const stageStart = st.start ? dayNum(String(st.start)) : prevEnd + 1;
      let stage = null;
      if (root.kind !== "mission") {
        const ex = findExisting("stage", st.title);
        if (ex) { stage = { id: ex.id, title: ex.title }; reused++; }
        else { stage = await mk({ kind: "stage", title: String(st.title || `Этап ${i + 1}`), status: "planned" }); created.stages++; }
      }
      const tasks = Array.isArray(st.tasks) ? st.tasks : [];
      const inStage = [];
      for (const [j, t] of tasks.entries()) {
        const key = String(t.key || `${i + 1}.${j + 1}`);
        const days = Math.max(1, Math.round(+t.days || 1));
        const deps = (Array.isArray(t.after) ? t.after : t.after ? [t.after] : []).map((a) => keyed.get(String(a)) || (Number.isFinite(+a) ? { id: +a, ext: true } : null)).filter(Boolean);
        let s0 = t.start ? dayNum(String(t.start)) : stageStart;
        for (const d of deps) if (d.finish != null) s0 = Math.max(s0, d.finish + 1);
        const autoAfter = !t.start && !deps.length && (i > 0 || prevEndTasks.length) ? prevEndTasks : [];
        for (const d of autoAfter) s0 = Math.max(s0, d.finish + 1);
        const f0 = s0 + days - 1;
        const node = await mk({
          kind: "task", title: String(t.title || `Задача ${j + 1}`), stage_id: stage?.id ?? null,
          start: dayStr(s0), due: dayStr(f0), ...(t.progress ? { fields: { progress: t.progress } } : {}),
        });
        created.tasks++;
        const rec = { id: node.id, start: s0, finish: f0 };
        keyed.set(key, rec);
        inStage.push({ ...rec, key });
        for (const d of [...deps, ...autoAfter]) links.push({ pred: d.id, succ: node.id });
      }
      // последние задачи этапа — те, после которых в этапе ничего не идёт
      const hasSucc = new Set(links.filter((l) => inStage.some((x) => x.id === l.succ)).map((l) => l.pred));
      const endTasks = inStage.filter((x) => !hasSucc.has(x.id));
      const stageEnd = inStage.length ? Math.max(...inStage.map((x) => x.finish)) : stageStart + Math.max(1, Math.round(+st.days || 7)) - 1;
      if (stage) await nodes.update(stage.id, { start: dayStr(stageStart), due: dayStr(stageEnd) }, source);
      for (const g of Array.isArray(st.goals) ? st.goals : []) {
        const date = g.date ? dayNum(String(g.date)) : stageEnd;
        const ex = findExisting("goal", g.title);
        const goal = ex
          ? await nodes.update(ex.id, { stage_id: stage?.id ?? null, due: dayStr(date) }, source)
          : await mk({ kind: "goal", title: String(g.title), stage_id: stage?.id ?? null, due: dayStr(date), fields: { goal_type: g.final ? "final" : "milestone" } });
        if (ex) reused++; else created.goals++;
        if (!g.date) for (const e of endTasks) links.push({ pred: e.id, succ: goal.id });
      }
      for (const r of Array.isArray(st.risks) ? st.risks : []) {
        const fields = {};
        for (const k of ["probability", "impact"]) if (r[k]) fields[k] = Math.max(1, Math.min(5, Math.round(+r[k])));
        if (r.mitigation) fields.mitigation = String(r.mitigation);
        await mk({ kind: "risk", title: String(r.title), stage_id: stage?.id ?? null, ...(Object.keys(fields).length ? { fields } : {}) });
        created.risks++;
      }
      summary.push({ stage: stage?.title || root.title, id: stage?.id || null, start: dayStr(stageStart), finish: dayStr(stageEnd), tasks: inStage.length });
      prevEnd = stageEnd;
      prevEndTasks = endTasks.length ? endTasks : prevEndTasks;
    }
    if (spec.final_goal?.title) {
      const date = spec.final_goal.date ? dayNum(String(spec.final_goal.date)) : prevEnd;
      const ex = findExisting("goal", spec.final_goal.title);
      const goal = ex
        ? await nodes.update(ex.id, { due: dayStr(date), fields: { goal_type: "final" } }, source)
        : await mk({ kind: "goal", title: String(spec.final_goal.title), due: dayStr(date), fields: { goal_type: "final" } });
      if (ex) reused++; else created.goals++;
      if (!spec.final_goal.date) for (const e of prevEndTasks) links.push({ pred: e.id, succ: goal.id });
    }
    for (const l of links) {
      await db.query("INSERT INTO plan_links (pred_id, succ_id, type, lag_days, created_at, created_by) VALUES (?, ?, 'FS', 0, NOW(3), ?)", [l.pred, l.succ, source]);
      created.links++;
    }
    // связи с уже существующими задачами могли потребовать сдвига
    const ext = [...new Set(links.map((l) => l.pred))];
    const shifted = await propagateFrom(ext, source);
    await syncStages(source);
    return { created, reused, stages: summary, finish: dayStr(prevEnd), shifted: shifted.length };
  }

  // Последние задачи этапа, который заканчивается раньше startDay (самый поздний из таких)
  async function lastStageEnd(rootId, startDay) {
    const data = await load();
    let best = null;
    for (const n of data.byId.values()) {
      if (n.kind !== "stage" || n.parent_id !== rootId) continue;
      const sp = data.span.get(n.id);
      if (!sp || !sp.summary || sp.finish >= startDay) continue;
      if (!best || sp.finish > best.sp.finish) best = { n, sp };
    }
    if (!best) return [];
    const tasks = (data.kids.get(best.n.id) || []).filter((c) => c.kind === "task" && data.span.get(c.id) && !data.span.get(c.id).summary);
    const ids = new Set(tasks.map((t) => t.id));
    const hasSucc = new Set(data.links.filter((l) => ids.has(l.pred_id) && ids.has(l.succ_id)).map((l) => l.pred_id));
    return tasks.filter((t) => !hasSucc.has(t.id)).map((t) => ({ id: t.id, start: data.span.get(t.id).start, finish: data.span.get(t.id).finish }));
  }

  return { buildPlan, getPlan, move, addLink, removeLink, saveBaseline, latestBaseline, propagateFrom, syncStages, load };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
