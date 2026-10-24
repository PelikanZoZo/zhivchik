// Страница основного объекта: трека, проекта или миссии. Всё, что в нём живёт, — по разделам.
import { el, api, toast, attempt, refresh, navigate, state, hooks, humanDue, PRIORITY, T, statusOptions, isCore, fileSize } from "./core.js";
import { row, list, commentsPanel, scaleInput, riskBadges } from "./item.js";

export async function objectView(main, { id }) {
  const { item } = await api("GET", `/api/items/${id}`);
  if (!isCore(item.kind)) { hooks.openItem(id); navigate("/", true); return; }
  const kids = item.children;
  const by = (k) => kids.filter((c) => c.kind === k);
  const open = (k) => by(k).filter((c) => !c.closed);
  const closed = (k) => by(k).filter((c) => c.closed);
  const save = (patch, note) => attempt(async () => { await api("PATCH", `/api/items/${id}`, patch); if (note) toast(note); refresh(); });
  const hasStages = ["project", "track"].includes(item.kind);

  // шапка
  const status = el("select", { class: "status-select", "aria-label": "Статус", onchange: () => save({ status: status.value }) },
    statusOptions(item.kind).map(([k, v]) => el("option", { value: k, selected: k === item.status }, v)));
  const people = item.links.filter((l) => l.kind === "person");
  main.append(
    el("div", { class: "crumbs" }, el("span", { class: `kind-tag k-${item.kind}` }, T(item.kind).label),
      item.path.map((p) => [" / ", el("a", { href: isCore(p.kind) ? `/o/${p.id}` : "#" }, p.title)])),
    el("header", { class: "obj-head" },
      el("h1", { class: "obj-title" }, item.title),
      el("div", { class: "obj-meta" },
        status,
        item.due ? el("span", { class: item.overdue ? "late" : "" }, `срок ${humanDue(item.due)}`) : "",
        item.priority ? el("span", {}, `приоритет: ${PRIORITY[item.priority].toLowerCase()}`) : "",
        item.stage ? el("span", {}, `стадия: ${item.stage}`) : "",
        el("button", { class: "btn ghost small", onclick: () => hooks.openItem(id) }, "Карточка и история"))),
    item.body ? el("p", { class: "obj-body" }, item.body) : "",
    item.kind === "mission" && item.fields.outcome ? el("p", { class: "obj-outcome" }, el("b", {}, "Итог: "), item.fields.outcome) : "",
    item.blocked_by?.length ? el("p", { class: "blocked-note" }, "Блокирует: ", item.blocked_by.map((b) => b.title).join(", ")) : "",
    people.length ? el("div", { class: "people-strip" }, people.map((p) => el("button", { class: "person-chip", onclick: () => hooks.openItem(p.id) },
      el("span", { class: "pc-name" }, p.title), el("span", { class: "pc-role" }, p.role)))) : "",
  );

  // стадии
  if (hasStages) main.append(stageBar(item, by("stage")));
  // цели: вехи и финальная
  if (hasStages || item.kind === "mission") main.append(goalsBlock(item, by("goal")));

  const sec = (title, kind, items, extra = {}) => section(title, kind, items, { parent: item, ...extra });
  if (item.kind === "track") main.append(sec("Проекты", "project", by("project"), { quick: "Новый проект" }));
  if (item.kind !== "mission") main.append(sec("Миссии", "mission", by("mission").sort(byClosed), { quick: "Новая миссия" }));
  main.append(
    sec("Задачи", "task", open("task"), { quick: "Новая задача", withDue: true, closedItems: closed("task") }),
    sec("Блокеры", "blocker", open("blocker"), { quick: "Что мешает", closedItems: closed("blocker"), blocker: true }),
    sec("Риски", "risk", by("risk").filter((r) => !r.closed).sort((a, b) => (riskTop(b) - riskTop(a))), { quick: "Что может пойти не так", risk: true, closedItems: closed("risk") }),
    sec("Журнал действий", "action", by("action").sort((a, b) => (b.event_at || "").localeCompare(a.event_at || "")), { quick: "Что я сделал", action: true }),
    sec("Памятки", "memo", open("memo"), { quick: "Новая памятка", closedItems: closed("memo") }),
    attachmentsSection(item, by("attachment")),
    el("section", { class: "obj-sec" }, commentsPanel(item)),
  );
}

const byClosed = (a, b) => (a.closed - b.closed) || a.id - b.id;
const riskTop = (r) => Math.max(r.risk?.mine || 0, r.risk?.ai || 0);

function section(title, kind, items, { parent, quick, withDue, closedItems = [], risk, action, blocker } = {}) {
  const body = el("div");
  const head = el("h2", { class: "sec-title" }, title, el("span", { class: "n" }, items.length || ""));
  const listEl = items.length ? list(items, { showHome: false }) : el("p", { class: "empty small" }, emptyText(kind));
  body.append(listEl);
  if (closedItems.length) {
    const more = el("details", { class: "closed-list" }, el("summary", {}, `Закрытые: ${closedItems.length}`), list(closedItems, { showHome: false }));
    body.append(more);
  }
  if (quick) body.append(quickForm(kind, parent, quick, { withDue, risk, action, blocker }));
  return el("section", { class: `obj-sec sec-${kind}` }, head, body);
}

function emptyText(kind) {
  return { task: "Задач нет.", blocker: "Ничего не мешает.", risk: "Рисков не записано.", action: "Пока ничего не сделано — записывай сюда, что делаешь и с каким результатом.", memo: "Памяток нет.", mission: "Миссий нет.", project: "Проектов нет." }[kind] || "Пусто.";
}

// Быстрое добавление в раздел
function quickForm(kind, parent, placeholder, { withDue, risk, action, blocker }) {
  const title = el("input", { type: "text", placeholder, "aria-label": placeholder });
  const extra = [];
  let due, result, waiting, p = null, i = null;
  if (withDue) { due = el("input", { type: "date", "aria-label": "Срок" }); extra.push(due); }
  if (action) { result = el("input", { type: "text", placeholder: "Результат", "aria-label": "Результат" }); extra.push(result); }
  if (blocker) { waiting = el("input", { type: "text", placeholder: "Чего или кого ждём", "aria-label": "Чего ждём" }); extra.push(waiting); }
  if (risk) {
    const pBox = el("span", { class: "mini-scale" }, "В", scaleInput("q-p", null, (v) => { p = v; mark(pBox, v); }));
    const iBox = el("span", { class: "mini-scale" }, "Вл", scaleInput("q-i", null, (v) => { i = v; mark(iBox, v); }));
    extra.push(pBox, iBox);
  }
  const form = el("form", { class: "quick sec-quick" + (extra.length ? " with-extra" : ""), onsubmit: (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    const body = { kind, title: title.value.trim(), parent_id: parent.id };
    if (due?.value) body.due = due.value;
    if (result) body.fields = { result: result.value.trim() || null };
    if (waiting) body.fields = { waiting_for: waiting.value.trim() || null };
    if (risk) body.fields = { probability: p, impact: i };
    attempt(async () => {
      await api("POST", "/api/items", body);
      title.value = "";
      if (due) due.value = "";
      if (result) result.value = "";
      if (waiting) waiting.value = "";
      refresh();
    });
  } }, title, ...extra, el("button", { class: "btn", type: "submit" }, "Добавить"));
  return form;
}

function mark(box, v) {
  box.querySelectorAll(".scale-btn").forEach((b) => {
    const on = +b.textContent === v;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

// Стадии: линия этапов, текущая подсвечена; клик — сделать текущей
function stageBar(item, stages) {
  stages.sort((a, b) => a.position - b.position || a.id - b.id);
  const add = el("input", { type: "text", placeholder: "Новая стадия", "aria-label": "Новая стадия" });
  return el("section", { class: "obj-sec stages" },
    el("h2", { class: "sec-title" }, "Стадии"),
    stages.length ? el("ol", { class: "stage-line" }, stages.map((s, idx) => el("li", { class: `stage st-${s.status}` },
      el("button", {
        class: "stage-btn", title: s.status === "active" ? "Текущая стадия" : "Сделать текущей",
        "aria-current": s.status === "active" ? "step" : undefined,
        onclick: () => s.status !== "active" && attempt(async () => { await api("PATCH", `/api/items/${s.id}`, { status: "active" }); toast(`Текущая стадия: ${s.title}`); refresh(); }),
      }, el("span", { class: "stage-n" }, idx + 1), el("span", { class: "stage-t" }, s.title)),
      el("button", { class: "icon-btn stage-edit", "aria-label": `Карточка стадии ${s.title}`, onclick: () => hooks.openItem(s.id) }, "…"))))
      : el("p", { class: "empty small" }, "Стадий нет. Добавь этапы — например: подготовка, выход на ЛПР, пилот, договор."),
    el("form", { class: "add-child", onsubmit: (e) => {
      e.preventDefault();
      if (!add.value.trim()) return;
      attempt(async () => {
        await api("POST", "/api/items", { kind: "stage", title: add.value.trim(), parent_id: item.id, position: (stages.at(-1)?.position || stages.length) + 1, status: stages.length ? "planned" : "active" });
        add.value = "";
        refresh();
      });
    } }, add, el("button", { class: "btn", type: "submit" }, "Добавить")));
}

// Цели: вехи по порядку срока и финальная
function goalsBlock(item, goals) {
  const final = goals.filter((g) => g.fields.goal_type === "final");
  const miles = goals.filter((g) => g.fields.goal_type !== "final").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id);
  const title = el("input", { type: "text", placeholder: "Новая цель", "aria-label": "Новая цель" });
  const type = el("select", { "aria-label": "Тип цели" }, el("option", { value: "milestone" }, "Веха"), el("option", { value: "final" }, "Финальная"));
  const due = el("input", { type: "date", "aria-label": "Дедлайн (необязательно)", title: "Дедлайн (необязательно)" });
  return el("section", { class: "obj-sec goals" },
    el("h2", { class: "sec-title" }, "Цели"),
    final.length ? final.map((g) => goalCard(g, true)) : "",
    miles.length ? el("ol", { class: "milestones" }, miles.map((g) => el("li", { class: g.closed ? "done" : g.overdue ? "late" : "" }, goalCard(g, false)))) : "",
    !goals.length ? el("p", { class: "empty small" }, "Целей нет. Финальная цель — к чему всё идёт; вехи — промежуточные точки. Дедлайн необязателен.") : "",
    el("form", { class: "quick sec-quick with-extra", onsubmit: (e) => {
      e.preventDefault();
      if (!title.value.trim()) return;
      attempt(async () => {
        await api("POST", "/api/items", { kind: "goal", title: title.value.trim(), parent_id: item.id, due: due.value || null, fields: { goal_type: type.value } });
        title.value = ""; due.value = "";
        refresh();
      });
    } }, title, type, due, el("button", { class: "btn", type: "submit" }, "Добавить")));
}

function goalCard(g, isFinal) {
  const f = g.fields;
  const hasMetric = f.target !== undefined && f.target !== null;
  const cur = f.current ?? f.baseline ?? 0;
  const base = f.baseline ?? 0;
  const pct = hasMetric && f.target !== base ? Math.max(0, Math.min(100, Math.round(((cur - base) / (f.target - base)) * 100))) : null;
  return el("button", { class: "goal-card" + (isFinal ? " final" : "") + (g.closed ? " closed" : ""), onclick: () => hooks.openItem(g.id) },
    el("span", { class: "goal-kind" }, isFinal ? "Финальная цель" : "Веха"),
    el("span", { class: "goal-title" }, g.title),
    el("span", { class: "goal-meta" },
      g.status_label,
      g.due ? ` · ${humanDue(g.due)}` : "",
      hasMetric ? ` · ${cur} из ${f.target}${f.unit ? " " + f.unit : ""}` : ""),
    pct !== null ? el("span", { class: "goal-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("span", { style: `width:${pct}%` })) : "");
}

// Вложения: загрузка файла (кнопкой или перетаскиванием) и ссылки
function attachmentsSection(item, atts) {
  const input = el("input", { type: "file", multiple: true, class: "visually-hidden", id: "file-in" });
  const upload = async (files) => {
    for (const file of files) {
      toast(`Загружаю ${file.name}…`);
      await attempt(async () => {
        await api("POST", `/api/items/${item.id}/upload`, file, { raw: true, headers: { "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" } });
      });
    }
    toast("Загружено");
    refresh();
  };
  input.addEventListener("change", () => input.files.length && upload([...input.files]));
  const drop = el("label", { class: "dropzone", for: "file-in" }, "Перетащи файлы сюда или ", el("u", {}, "выбери"), " — до 25 МБ");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); });
  const url = el("input", { type: "url", placeholder: "https://…", "aria-label": "Ссылка" });
  const name = el("input", { type: "text", placeholder: "Название ссылки", "aria-label": "Название ссылки" });
  const active = atts.filter((a) => !a.closed);
  return el("section", { class: "obj-sec sec-attachment" },
    el("h2", { class: "sec-title" }, "Вложения", el("span", { class: "n" }, active.length || "")),
    active.length ? list(active, { showHome: false }) : "",
    input, drop,
    el("form", { class: "quick sec-quick with-extra", onsubmit: (e) => {
      e.preventDefault();
      if (!url.value.trim()) return;
      attempt(async () => {
        await api("POST", "/api/items", { kind: "attachment", title: name.value.trim() || url.value.trim(), parent_id: item.id, fields: { url: url.value.trim() } });
        url.value = ""; name.value = "";
        refresh();
      });
    } }, url, name, el("button", { class: "btn", type: "submit" }, "Добавить ссылку")));
}

export { riskBadges, fileSize, row };
