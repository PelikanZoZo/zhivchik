// Планировщик: диаграмма Ганта как в MS Project (DHTMLX Gantt 10, Community, MIT).
// Слева таблица: № по структуре, название, начало, окончание, длительность, %, предшественники, отклонение.
// Справа — полосы задач, сводные строки этапов и проектов, вехи-цели, связи, базовый план, линия «сегодня».
// Все изменения уходят на сервер — он пересчитывает автосдвиг по связям и возвращает свежий график.
import { $, el, api, toast, attempt, hooks, state } from "./core.js";

const DHX = "/vendor/dhtmlx-gantt/dhtmlxgantt";
const FROM_DHX = { 0: "FS", 1: "SS", 2: "FF", 3: "SF" };
const KIND_LABEL = { track: "Трек", project: "Проект", stage: "Этап", mission: "Миссия", task: "Задача", goal: "Цель" };
const ZOOM = {
  day: { label: "Дни", scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "day", step: 1, format: "%j %D" }], min: 34 },
  week: { label: "Недели", scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "week", step: 1, format: (d) => `${fmtShort(d)}` }], min: 56 },
  month: { label: "Месяцы", scales: [{ unit: "year", step: 1, format: "%Y" }, { unit: "month", step: 1, format: "%M" }], min: 70 },
};

let loading = null;
function loadGantt() {
  if (window.gantt) return Promise.resolve(window.gantt);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    document.head.append(el("link", { rel: "stylesheet", href: DHX + ".css" }));
    const s = el("script", { src: DHX + ".js" });
    s.onload = () => resolve(window.gantt);
    s.onerror = () => reject(new Error("Не загрузилась библиотека диаграммы"));
    document.head.append(s);
  });
  return loading;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function fmtShort(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; }
const fmtYmd = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)}` : "");
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

let current = null; // { rootId, data, zoom, showBaseline }

export async function planView(main, r) {
  const rootId = r.id || null;
  const prefs = (() => { try { return JSON.parse(localStorage.getItem("kira-plan") || "{}"); } catch { return {}; } })();
  current = { rootId, zoom: prefs.zoom || "week", showBaseline: prefs.baseline !== false, data: null };
  const data = await api("GET", `/api/plan${rootId ? `?root=${rootId}` : ""}`);
  current.data = data;
  const g = await loadGantt();

  const title = rootId ? data.root.title : "Планировщик";
  main.classList.add("plan-main");
  main.append(
    el("div", { class: "plan-head" },
      el("div", {},
        rootId ? el("a", { class: "plan-back", href: `/o/${rootId}` }, `← ${KIND_LABEL[data.root.kind] || ""}`) : "",
        el("h1", { class: "view-title" }, rootId ? `График: ${title}` : "Планировщик"),
        el("p", { class: "view-sub" }, rootId
          ? "Перетаскивай полосы, тяни края — меняй сроки; тяни от круглой точки на краю полосы к другой — создашь связь. Последователи сдвигаются сами. Двойной щелчок — карточка."
          : "Все открытые треки и проекты на одной диаграмме. Открой проект, чтобы планировать подробно.")),
      el("div", { class: "plan-tools" },
        el("div", { class: "tabs", role: "tablist" }, Object.entries(ZOOM).map(([k, z]) => el("button", {
          class: "tab" + (k === current.zoom ? " on" : ""), role: "tab", "aria-selected": k === current.zoom,
          onclick: (e) => { current.zoom = k; save(); e.target.parentNode.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === e.target)); setZoom(g); g.render(); },
        }, z.label))),
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: current.showBaseline, onchange: (e) => { current.showBaseline = e.target.checked; save(); g.render(); } }), " базовый план"),
        rootId ? el("button", { class: "btn", onclick: () => attempt(async () => {
          const b = await api("POST", "/api/plan/baseline", { root_id: rootId });
          toast(`Зафиксировано: ${b.name}`);
          await reload(g);
        }) }, "Зафиксировать базовый план") : "",
        rootId ? el("button", { class: "btn primary", onclick: () => addForm.hidden = !addForm.hidden }, "Добавить") : "")),
  );
  function save() { try { localStorage.setItem("kira-plan", JSON.stringify({ zoom: current.zoom, baseline: current.showBaseline })); } catch {} }

  // форма: новая задача / этап / веха
  const addForm = rootId ? buildAddForm(rootId, data, g) : el("div");
  addForm.hidden = true;
  main.append(addForm);

  const info = el("div", { class: "plan-info" });
  main.append(info);
  const box = el("div", { id: "gantt", class: "gantt-box" });
  main.append(box);
  const below = el("div", { class: "plan-below" });
  main.append(below);

  setup(g);
  applyColumns(g);
  setZoom(g);
  g.init(box);
  paint(g, data, info, below);
  // открылась карточка справа или поменялось окно — подогнать размеры
  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (box.isConnected) g.setSizes(); }, 60); }).observe(box);
  }
}

// Колонки таблицы: на телефоне — только название и длительность
function applyColumns(g) {
  const narrow = window.innerWidth < 720;
  const all = [
    { name: "wbs", label: "№", width: 58, align: "left", template: (t) => `<span class="wbs">${esc(t.wbs || "")}</span>` },
    { name: "text", label: "Название", tree: true, width: 210, template: (t) => `<span class="k-${t.kind}">${t.kind === "goal" ? "◆ " : ""}${esc(t.text)}</span>${t.risks?.length ? ` <span class="risk-dot ${riskClass(t.risks)}" title="Риски: ${esc(t.risks.map((r) => r.title).join("; "))}">⚠${t.risks.length}</span>` : ""}` },
    { name: "start", label: "Начало", width: 72, align: "center", template: (t) => fmtYmd(t.start) },
    { name: "finish", label: "Оконч.", width: 72, align: "center", template: (t) => fmtYmd(t.finish) },
    { name: "days", label: "Длит.", width: 46, align: "center", template: (t) => (t.type === "milestone" ? "веха" : `${t.days} д`) },
    { name: "pct", label: "%", width: 38, align: "center", template: (t) => (t.type === "milestone" ? "" : Math.round((t.progress || 0) * 100)) },
    { name: "preds", label: "Предш.", width: 58, align: "center", template: (t) => esc(predText(t)) },
    { name: "variance", label: "Откл.", width: 46, align: "center", template: (t) => (t.variance ? `<span class="${t.variance > 0 ? "late" : "early"}">${t.variance > 0 ? "+" : ""}${t.variance}</span>` : "") },
  ];  g.config.columns = narrow ? all.filter((c) => ["text", "days"].includes(c.name)).map((c) => (c.name === "text" ? { ...c, width: 150 } : c)) : all;
  g.config.grid_width = narrow ? 190 : 610;
}

function setup(g) {
  if (g._kiraReady) { g.clearAll(); return; }
  g._kiraReady = true;
  g.i18n.setLocale("ru");
  Object.assign(g.config, {
    date_format: "%Y-%m-%d",
    row_height: 32, bar_height: 18, scale_height: 50,
    details_on_dblclick: false, details_on_create: false,
    drag_links: true, drag_progress: true, drag_resize: true, drag_move: true, drag_project: true,
    show_errors: false, open_tree_initially: true, fit_tasks: true,
    grid_width: 610, min_column_width: 34, auto_types: false,
    show_unscheduled: false,
    duration_unit: "day", round_dnd_dates: false, time_step: 24 * 60, // перетаскивание — с шагом в день
  });
  g.plugins({ tooltip: true });

  g.templates.task_class = (s, e, t) => [
    `k-${t.kind}`, t.closed ? "is-closed" : "", t.goal_type === "final" ? "final" : "",
    t.type !== "milestone" && t.type !== "project" && !t.closed && (t.progress || 0) < 1 && t.finish < (current.data?.today || "") ? "is-late" : "",
  ].join(" ");
  g.templates.grid_row_class = (s, e, t) => `row-${t.kind}${t.closed ? " is-closed" : ""}`;
  g.templates.task_text = () => "";
  g.templates.rightside_text = (s, e, t) => (t.type === "project" ? "" : esc(t.text) + (t.risks?.length ? " ⚠" : ""));
  g.templates.progress_text = () => "";
  g.templates.tooltip_text = (s, e, t) => [
    `<b>${esc(t.text)}</b>`,
    `${KIND_LABEL[t.kind] || ""}${t.status ? "" : ""}`,
    t.type === "milestone" ? `Дата: ${fmtYmd(t.finish)}` : `${fmtYmd(t.start)} — ${fmtYmd(t.finish)} · ${t.days} д · ${Math.round((t.progress || 0) * 100)}%`,
    t.baseline ? `Базовый план: ${fmtYmd(t.baseline.start)} — ${fmtYmd(t.baseline.finish)}${t.variance ? ` (${t.variance > 0 ? "+" : ""}${t.variance} д)` : ""}` : "",
    t.risks?.length ? `Риски: ${t.risks.map((r) => esc(r.title)).join("; ")}` : "",
  ].filter(Boolean).join("<br>");
  g.templates.link_class = (l) => (current.data?.violations?.some((v) => v.link_id === l.id) ? "link-bad" : "");

  // Базовый план — тонкая полоса под задачей (в бесплатной версии нет слоёв — рисуем поверх сами)
  const drawBaselines = () => {
    const area = g.$task_data;
    if (!area) return;
    let layer = area.querySelector(".baseline-layer");
    if (!layer) { layer = document.createElement("div"); layer.className = "baseline-layer"; area.append(layer); }
    layer.replaceChildren();
    if (!current?.showBaseline) return;
    g.eachTask((t) => {
      if (!t.baseline || !g.isTaskVisible(t.id)) return;
      const ms = t.type === "milestone";
      const left = g.posFromDate(parseYmd(t.baseline.start));
      const right = g.posFromDate(g.date.add(parseYmd(t.baseline.finish), 1, "day"));
      const div = document.createElement("div");
      div.className = "baseline" + (ms ? " ms" : "");
      div.style.left = (ms ? right : left) + "px";
      if (!ms) div.style.width = Math.max(2, right - left) + "px";
      div.style.top = g.getTaskTop(t.id) + g.config.row_height - 8 + "px";
      div.title = `Базовый план: ${fmtYmd(t.baseline.start)} — ${fmtYmd(t.baseline.finish)}`;
      layer.append(div);
    });
  };
  g.attachEvent("onDataRender", drawBaselines);

  // Линия «сегодня»
  g.attachEvent("onGanttRender", () => {
    const area = g.$task_data;
    if (!area || !current?.data) return;
    let line = area.querySelector(".today-line");
    if (!line) { line = document.createElement("div"); line.className = "today-line"; line.title = "Сегодня"; area.append(line); }
    const x = g.posFromDate(g.date.add(parseYmd(current.data.today), 12, "hour"));
    line.style.left = x + "px";
    line.style.height = Math.max(area.scrollHeight, area.offsetHeight) + "px";
    drawBaselines();
  });

  // Двойной щелчок — наша карточка объекта
  g.attachEvent("onTaskDblClick", (id) => { hooks.openItem(+id); return false; });
  g.attachEvent("onBeforeLightbox", () => false);

  // Перетаскивание полос → сервер (он сдвинет последователей)
  g.attachEvent("onAfterTaskDrag", (id, mode) => {
    const t = g.getTask(id);
    const body = mode === "progress"
      ? { progress: Math.round((t.progress || 0) * 100) }
      : t.type === "milestone"
        ? { finish: ymd(t.start_date) }
        : { start: ymd(t.start_date), finish: ymd(g.date.add(t.end_date, -1, "day")) };
    send(g, `/api/plan/items/${id}`, "PATCH", body);
  });

  // Новая связь: тянешь от точки одной полосы к другой
  g.attachEvent("onBeforeLinkAdd", (id, link) => {
    send(g, "/api/plan/links", "POST", { pred_id: +link.source, succ_id: +link.target, type: FROM_DHX[link.type] || "FS" });
    return false; // нарисуем после ответа сервера
  });
  g.attachEvent("onLinkDblClick", (id) => {
    const l = g.getLink(id);
    const a = g.getTask(l.source).text;
    const b = g.getTask(l.target).text;
    if (window.confirm(`Убрать связь «${a}» → «${b}»?`)) send(g, `/api/plan/links/${id}`, "DELETE");
    return false;
  });
}

async function send(g, path, method, body) {
  try {
    const r = await api(method, path, body);
    const shifted = (r.changed || []).filter((c) => c.shifted_days);
    if (shifted.length > 1 || (shifted.length === 1 && r.link)) {
      toast(`Сдвинулось: ${shifted.map((c) => `${c.title} (${c.shifted_days > 0 ? "+" : ""}${c.shifted_days} д)`).join(", ")}`.slice(0, 220));
    }
  } catch (e) {
    toast(e.message, true);
  }
  await reload(g);
}

async function reload(g) {
  const y = g.getScrollState?.().y || 0;
  current.data = await api("GET", `/api/plan${current.rootId ? `?root=${current.rootId}` : ""}`);
  g.clearAll();
  paint(g, current.data, $(".plan-info"), $(".plan-below"));
  g.scrollTo(null, y);
}

function setZoom(g) {
  const z = ZOOM[current.zoom] || ZOOM.week;
  g.config.scales = z.scales;
  g.config.min_column_width = z.min;
}

function paint(g, data, info, below) {
  // № по структуре (как WBS в MS Project)
  const counters = new Map();
  const wbs = new Map();
  for (const r of data.rows) {
    const n = (counters.get(r.parent) || 0) + 1;
    counters.set(r.parent, n);
    wbs.set(r.id, r.parent && wbs.has(r.parent) ? `${wbs.get(r.parent)}.${n}` : String(n));
  }
  current.wbs = wbs;
  g.parse({
    data: data.rows.map((r) => ({
      ...r, wbs: wbs.get(r.id), start_date: r.start, duration: r.type === "milestone" ? 0 : r.days,
      parent: r.parent || 0, open: true, readonly: r.kind === "track" || (r.kind === "project" && !current.rootId),
    })),
    links: data.links.map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type })),
  });
  if (info) {
    const rows = data.rows.filter((r) => r.type !== "project" || r.kind === "stage");
    const finish = data.rows.reduce((m, r) => (r.finish > m ? r.finish : m), "");
    const late = data.rows.filter((r) => r.variance > 0 && r.type === "task").length;
    info.replaceChildren(
      data.rows.length ? el("span", {}, `Строк: ${rows.length}`) : el("span", {}, "На графике пока ничего нет — дай задачам даты или попроси Киру: «распланируй этот проект»."),
      finish ? el("span", {}, `Окончание: ${fmtYmd(finish)}`) : "",
      data.baseline ? el("span", {}, `Базовый план: ${data.baseline.name}${late ? ` · отстают задач: ${late}` : ""}`) : "",
      data.violations?.length ? el("span", { class: "bad" }, `Нарушены связи: ${data.violations.length}`) : "",
    );
  }
  if (below) {
    below.replaceChildren(...(data.undated.length ? [
      el("h2", { class: "group-title" }, "Без дат", el("span", { class: "n" }, data.undated.length)),
      el("p", { class: "sub" }, "Не стоят на графике. Открой и поставь начало и срок — или попроси Киру."),
      el("ul", { class: "undated" }, data.undated.map((u) => el("li", {},
        el("button", { class: "linklike", onclick: () => hooks.openItem(u.id) }, `${KIND_LABEL[u.kind] || ""}: ${u.title}`),
        u.home ? el("span", { class: "sub" }, ` · ${u.home}`) : ""))),
    ] : []));
  }
}

function predText(t) {
  return (t.preds || []).map((p) => `${current.wbs?.get(p.id) || "#" + p.id}${p.type !== "FS" ? p.type : ""}${p.lag ? (p.lag > 0 ? "+" : "") + p.lag + "д" : ""}`).join(", ");
}

function riskClass(risks) {
  return risks.some((r) => r.level === "high") ? "high" : risks.some((r) => r.level === "medium") ? "medium" : "low";
}

function buildAddForm(rootId, data, g) {
  const stages = data.rows.filter((r) => r.kind === "stage");
  const kind = el("select", { "aria-label": "Что добавить" },
    el("option", { value: "task" }, "Задача"), el("option", { value: "stage" }, "Этап"), el("option", { value: "goal" }, "Веха (цель)"));
  const title = el("input", { type: "text", placeholder: "Название", "aria-label": "Название" });
  const stage = el("select", { "aria-label": "Этап" }, el("option", { value: "" }, "Без этапа"), stages.map((s) => el("option", { value: s.id }, s.text)));
  const start = el("input", { type: "date", value: data.today, "aria-label": "Начало" });
  const days = el("input", { type: "number", min: 1, value: 3, "aria-label": "Длительность, дней", style: "width:80px" });
  const after = el("select", { "aria-label": "После" }, el("option", { value: "" }, "без связи"),
    data.rows.filter((r) => r.type !== "project").map((r) => el("option", { value: r.id }, `после: ${r.text}`)));
  const sync = () => { const ms = kind.value === "goal"; days.hidden = ms; stage.hidden = kind.value === "stage"; };
  kind.addEventListener("change", sync);
  return el("form", { class: "plan-add", onsubmit: (e) => {
    e.preventDefault();
    attempt(async () => {
      if (!title.value.trim()) throw new Error("Напиши название");
      const k = kind.value;
      const d = Math.max(1, +days.value || 1);
      const s = start.value || data.today;
      const finish = k === "goal" ? s : ymd(new Date(parseYmd(s).getTime() + (d - 1) * 86400000));
      const { item } = await api("POST", "/api/items", {
        kind: k, title: title.value.trim(), parent_id: rootId,
        ...(k !== "stage" && stage.value ? { stage_id: +stage.value } : {}),
        ...(k === "goal" ? { due: s } : { start: s, due: finish }),
      });
      if (after.value) await api("POST", "/api/plan/links", { pred_id: +after.value, succ_id: item.id, type: "FS" });
      toast("Добавлено");
      hooks.render();
    });
  } }, kind, title, stage, start, days, after, el("button", { class: "btn primary", type: "submit" }, "Добавить"));
}
