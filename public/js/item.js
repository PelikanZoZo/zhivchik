// Строки объектов в списках и карточка любого объекта (боковая панель).
import {
  $, el, api, toast, attempt, refresh, navigate, state, hooks, humanDue, humanDate, isoToLocal,
  PRIORITY, SOURCE, T, statusOptions, doneStatus, openStatus, isCore, fileSize,
} from "./core.js";

const DUE_KINDS = ["project", "mission", "goal", "task", "stage"];
const PRIORITY_KINDS = ["task", "mission", "project"];
const STAGE_KINDS = ["task", "mission", "goal", "risk", "blocker", "memo", "action"];
const CHECK_KINDS = ["task", "goal", "blocker", "mission"];

// ---------- строка в списке ----------
export function row(item, { showHome = true, onOpen } = {}) {
  const f = item.fields || {};
  const meta = [];
  const late = item.overdue ? "late" : "";
  if (item.kind === "action") {
    if (item.event_at) meta.push(el("span", {}, humanDue(item.event_at)));
    if (f.result) meta.push(el("span", { class: "result-inline" }, `→ ${f.result}`));
  } else if (item.kind === "blocker") {
    if (f.waiting_for) meta.push(el("span", {}, `ждём: ${f.waiting_for}`));
    if (item.event_at && !item.closed) meta.push(el("span", {}, `с ${humanDate(item.event_at.slice(0, 10))}`));
  } else if (item.kind === "risk") {
    meta.push(riskBadges(item));
  } else if (item.kind === "goal") {
    meta.push(el("span", { class: "chip-mini" }, f.goal_type === "final" ? "финальная" : "веха"));
    if (f.target !== undefined && f.target !== null) meta.push(el("span", {}, `${f.current ?? f.baseline ?? 0} из ${f.target}${f.unit ? " " + f.unit : ""}`));
  } else if (item.kind === "attachment") {
    if (f.file_name) meta.push(el("span", {}, fileSize(f.file_size)));
    if (f.url) meta.push(el("span", { class: "url" }, f.url.replace(/^https?:\/\//, "").slice(0, 50)));
  } else if (item.kind === "person") {
    const w = [f.position, f.company].filter(Boolean).join(", ");
    if (f.loyalty) meta.push(loyaltyChip(f.loyalty));
    if (w) meta.push(el("span", {}, w));
    if (f.ai_summary) meta.push(el("span", { class: "memo-line" }, f.ai_summary));
  } else if (item.kind === "memo" && item.body) {
    meta.push(el("span", { class: "memo-line" }, item.body.split("\n")[0].slice(0, 120)));
  }
  if (item.due && item.kind !== "action") meta.push(el("span", { class: late }, humanDue(item.due)));
  if (item.kind === "task" && ["doing", "waiting"].includes(item.status)) meta.push(el("span", {}, item.status_label.toLowerCase()));
  if (isCore(item.kind) || item.kind === "goal") meta.push(el("span", {}, item.status_label.toLowerCase()));
  if (showHome && item.home) meta.push(el("span", { class: "home" }, item.home.title));
  if (item.tags?.length) meta.push(el("span", {}, item.tags.map((t) => "#" + t).join(" ")));

  const canCheck = CHECK_KINDS.includes(item.kind);
  const open = () => (onOpen ? onOpen(item) : isCore(item.kind) ? navigate(`/o/${item.id}`) : hooks.openItem(item.id));
  const lead = canCheck
    ? el("button", {
      class: "check" + (item.closed ? " on" : ""), "aria-label": item.closed ? "Вернуть" : "Отметить выполненным",
      onclick: (e) => {
        e.stopPropagation();
        attempt(async () => {
          await api("PATCH", `/api/items/${item.id}`, { status: item.closed ? openStatus(item.kind) : doneStatus(item.kind) });
          toast(item.closed ? "Вернула в работу" : "Готово");
          refresh();
        });
      },
    })
    : el("span", { class: `kind-dot k-${item.kind}`, "aria-hidden": "true" });
  return el("li", {
    class: "row" + (item.closed ? " closed" : "") + (state.selected === item.id ? " selected" : ""),
    "data-priority": item.priority, "data-id": item.id, tabindex: 0,
    onclick: open, onkeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); },
  },
  lead,
  el("div", {}, el("div", { class: "title" }, item.title), meta.length ? el("div", { class: "meta" }, meta) : null),
  el("div", { class: "side-info" }, item.kind === "attachment" && f.file_key ? el("a", { href: `/api/files/${item.id}`, onclick: (e) => e.stopPropagation(), "aria-label": "Скачать" }, "скачать")
    : item.kind === "attachment" && f.url ? el("a", { href: f.url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, "открыть") : ""));
}

export function riskBadges(item) {
  const f = item.fields || {};
  const lvl = item.risk?.level;
  return el("span", { class: "risk-badges" },
    el("span", { class: `score ${scoreClass(item.risk?.mine)}`, title: "Моя оценка: вероятность × влияние" }, `я ${f.probability ?? "–"}×${f.impact ?? "–"}`),
    el("span", { class: `score ${scoreClass(item.risk?.ai)}`, title: f.ai_comment || "ИИ ещё не оценил" }, `ИИ ${f.ai_probability ?? "–"}×${f.ai_impact ?? "–"}`),
    lvl === "high" ? el("span", { class: "chip-mini bad" }, "высокий") : "");
}

function scoreClass(s) {
  if (!s) return "";
  return s >= 15 ? "high" : s >= 8 ? "medium" : "low";
}

export function list(items, opts = {}) {
  return el("ul", { class: "list" }, items.map((i) => row(i, opts)));
}

// ---------- карточка ----------
export function closeDrawer() {
  state.selected = null;
  state.selectedJob = null;
  $("#drawer").hidden = true;
  $("#app").classList.remove("with-drawer");
  document.querySelectorAll(".row.selected, tr.selected").forEach((r) => r.classList.remove("selected"));
}

export async function openItem(id, { keepScroll = false } = {}) {
  const d = $("#drawer");
  const y = d.scrollTop;
  let item, history;
  try {
    [{ item }, { history }] = await Promise.all([api("GET", `/api/items/${id}`), api("GET", `/api/items/${id}/history`)]);
  } catch (e) { toast(e.message, true); return; }
  state.selected = id;
  state.selectedJob = null;
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("selected", +r.dataset.id === id));
  $("#app").classList.add("with-drawer");
  d.hidden = false;
  const t = T(item.kind);
  const f = item.fields || {};
  const save = (patch, note) => attempt(async () => { await api("PATCH", `/api/items/${id}`, patch); if (note) toast(note); refresh(); });

  const title = el("textarea", { class: "title-input", rows: 1, "aria-label": "Название" }, item.title);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
  title.addEventListener("change", () => title.value.trim() && title.value.trim() !== item.title && save({ title: title.value.trim() }));

  const grid = [];
  const fieldRow = (label, input, forId) => grid.push(el("label", { for: forId }, label), input);
  // статус (у действия он один — не показываем)
  if (statusOptions(item.kind).length > 1) {
    const st = el("select", { id: "f-status", onchange: () => save({ status: st.value }) },
      statusOptions(item.kind).map(([k, v]) => el("option", { value: k, selected: k === item.status }, v)));
    fieldRow("Статус", st, "f-status");
  }
  if (t.eventLabel) {
    const [ed, et] = item.event_at ? item.event_at.split(" ") : ["", ""];
    const d1 = el("input", { type: "date", id: "f-event", value: ed });
    const d2 = el("input", { type: "time", value: et, "aria-label": "Время" });
    const saveEv = () => save({ event_at: d1.value ? `${d1.value} ${d2.value || "12:00"}` : null });
    d1.addEventListener("change", saveEv); d2.addEventListener("change", saveEv);
    fieldRow(t.eventLabel, el("div", { class: "due-pair" }, d1, d2), "f-event");
  }
  if (DUE_KINDS.includes(item.kind)) {
    const [dd, dt] = item.due ? item.due.split(" ") : ["", ""];
    const d1 = el("input", { type: "date", id: "f-due", value: dd });
    const d2 = el("input", { type: "time", value: dt || "", "aria-label": "Время" });
    const saveDue = () => save({ due: d1.value ? d1.value + (d2.value ? " " + d2.value : "") : null });
    d1.addEventListener("change", saveDue); d2.addEventListener("change", saveDue);
    fieldRow(item.kind === "goal" ? "Дедлайн" : "Срок", el("div", { class: "due-pair" }, d1, d2), "f-due");
  }
  if (PRIORITY_KINDS.includes(item.kind)) {
    const pr = el("select", { id: "f-prio", onchange: () => save({ priority: +pr.value }) },
      PRIORITY.map((p, i) => el("option", { value: i, selected: i === item.priority }, p)));
    fieldRow("Приоритет", pr, "f-prio");
  }
  // дом (куда вложен)
  if (t.parents.length) {
    const parentSel = el("select", { id: "f-parent" }, el("option", { value: "" }, t.parentRequired ? "— выбери —" : "— без дома —"));
    fieldRow("Где", parentSel, "f-parent");
    api("GET", `/api/items?kinds=${t.parents.join(",")}&open=1&order=title&limit=500`).then(({ items }) => {
      const opts = items.filter((p) => p.id !== item.id).map((p) => el("option", { value: p.id, selected: p.id === item.parent_id }, `${T(p.kind).label}: ${p.title}`));
      if (item.parent_id && !items.some((p) => p.id === item.parent_id) && item.path.length) {
        const last = item.path.at(-1);
        opts.push(el("option", { value: last.id, selected: true }, `${T(last.kind).label}: ${last.title}`));
      }
      parentSel.append(...opts);
      parentSel.onchange = () => save({ parent_id: parentSel.value || null }, "Перенесено");
    }).catch(() => {});
  }
  // стадия (стадии ближайшего проекта или трека)
  if (STAGE_KINDS.includes(item.kind)) {
    const home = [...item.path].reverse().find((p) => p.kind === "project" || p.kind === "track");
    if (home) {
      const stSel = el("select", { id: "f-stage" }, el("option", { value: "" }, "— без стадии —"));
      fieldRow("Стадия", stSel, "f-stage");
      api("GET", `/api/items?kind=stage&parent_id=${home.id}&order=position`).then(({ items }) => {
        if (!items.length) { stSel.disabled = true; stSel.firstChild.textContent = `у «${home.title}» нет стадий`; return; }
        stSel.append(...items.map((s) => el("option", { value: s.id, selected: s.id === item.stage_id }, s.title)));
        stSel.onchange = () => save({ stage_id: stSel.value || null });
      }).catch(() => {});
    }
  }
  // поля вида
  for (const [key, def] of Object.entries(t.fields || {})) {
    if (def.system || (item.kind === "risk" && ["probability", "impact"].includes(key)) || (item.kind === "person" && ["loyalty", "relation"].includes(key))) continue;
    fieldRow(def.label, fieldInput(key, def, f[key], (v) => save({ fields: { [key]: v } })), `ff-${key}`);
  }

  const body = el("textarea", { id: "f-body", placeholder: item.kind === "person" ? "Заметки о человеке" : "Подробности, мысли, ссылки…", "aria-label": "Описание" }, item.body || "");
  body.addEventListener("change", () => save({ body: body.value || null }));

  d.replaceChildren(...[
    el("div", { class: "drawer-top" },
      el("span", {}, `${t.label} #${item.id}`),
      el("button", { class: "icon-btn", "aria-label": "Закрыть", onclick: closeDrawer }, "×")),
    item.path.length ? el("div", { class: "path" }, item.path.map((p, i) => [i ? " / " : "",
      isCore(p.kind) ? el("a", { href: `/o/${p.id}` }, p.title) : el("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(p.id); } }, p.title)])) : "",
    title,
    item.deleted ? el("p", { class: "danger-text" }, "Объект удалён.") : "",
    item.blocked_by?.length ? el("p", { class: "blocked-note" }, "Блокирует: ", item.blocked_by.map((b, i) => [i ? ", " : "", el("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(b.id); } }, b.title)])) : "",
    item.kind === "risk" ? riskPanel(item, save) : "",
    item.kind === "person" ? relationPanel(item, save) : "",
    item.kind === "attachment" ? attachmentPanel(item) : "",
    el("div", { class: "fields" }, grid),
    body,
    item.children?.length ? [el("h3", {}, item.kind === "task" ? "Внутри задачи" : "Внутри"), list(item.children, { showHome: false })] : "",
    item.kind === "task" && !item.path.some((p) => p.kind === "task") ? addInline("Подзадача", (title) => api("POST", "/api/items", { kind: "task", title, parent_id: id })) : "",
    item.kind === "person" ? [personLinks(item), personPanel(item)] : peoplePanel(item),
    item.kind === "blocker" ? blocksPanel(item) : "",
    otherLinks(item),
    commentsPanel(item),
    el("h3", {}, "История"),
    el("ul", { class: "timeline" }, history.map((h) => el("li", {},
      el("div", { class: "when" }, `${humanDue(h.at_local)} · ${SOURCE[h.source] || h.source}`),
      el("div", { class: "what" }, describeHistory(h, item.kind))))),
    el("div", { class: "drawer-actions" },
      isCore(item.kind) ? el("a", { class: "btn", href: `/o/${item.id}` }, "Открыть страницу") : "",
      item.deleted
        ? el("button", { class: "btn", onclick: () => attempt(async () => { await api("POST", `/api/items/${id}/restore`); toast("Восстановлено"); refresh(); }) }, "Восстановить")
        : el("button", { class: "btn danger", onclick: () => attempt(async () => {
          const n = item.children?.length || 0;
          if (!confirm(`Удалить «${item.title}»${n ? ` вместе со всем, что внутри (${n})` : ""}? Восстановить можно из истории.`)) return;
          await api("DELETE", `/api/items/${id}`);
          toast("Удалено");
          closeDrawer();
          if (state.view?.view === "object" && state.view.id === id) navigate("/", true); else refresh();
        }) }, "Удалить")),
  ].flat(Infinity).filter(Boolean));
  title.style.height = "auto";
  title.style.height = title.scrollHeight + "px";
  if (keepScroll) d.scrollTop = y;
}

export function fieldInput(key, def, value, onSave) {
  const id = `ff-${key}`;
  if (def.type === "enum") {
    const s = el("select", { id, onchange: () => onSave(s.value) }, Object.entries(def.values).map(([k, v]) => el("option", { value: k, selected: k === value }, v)));
    return s;
  }
  if (def.type === "scale") return scaleInput(id, value, onSave);
  if (def.type === "text") {
    const t = el("textarea", { id, rows: 2, class: "small-text" }, value ?? "");
    t.addEventListener("change", () => onSave(t.value || null));
    return t;
  }
  const i = el("input", { id, type: def.type === "number" ? "text" : "text", inputmode: def.type === "number" ? "decimal" : undefined, value: value ?? "" });
  i.addEventListener("change", () => onSave(i.value === "" ? null : i.value));
  return i;
}

// Шкала 1–5 кнопками
export function scaleInput(id, value, onSave) {
  const box = el("div", { class: "scale", role: "radiogroup", id });
  for (let v = 1; v <= 5; v++) {
    box.append(el("button", {
      type: "button", class: "scale-btn" + (value === v ? " on" : ""), role: "radio", "aria-checked": value === v ? "true" : "false",
      onclick: () => onSave(value === v ? null : v),
    }, v));
  }
  return box;
}

function riskPanel(item, save) {
  const f = item.fields;
  return el("div", { class: "risk-panel" },
    el("div", { class: "risk-col" },
      el("div", { class: "risk-h" }, "Моя оценка", item.risk?.mine ? el("span", { class: `score ${scoreClass(item.risk.mine)}` }, item.risk.mine) : ""),
      el("div", { class: "risk-line" }, el("span", {}, "Вероятность"), scaleInput("r-p", f.probability, (v) => save({ fields: { probability: v } }))),
      el("div", { class: "risk-line" }, el("span", {}, "Влияние"), scaleInput("r-i", f.impact, (v) => save({ fields: { impact: v } })))),
    el("div", { class: "risk-col ai" },
      el("div", { class: "risk-h" }, "Оценка Киры", item.risk?.ai ? el("span", { class: `score ${scoreClass(item.risk.ai)}` }, item.risk.ai) : ""),
      f.ai_probability
        ? [el("div", { class: "risk-line" }, `Вероятность ${f.ai_probability}, влияние ${f.ai_impact}`), f.ai_comment ? el("p", { class: "ai-comment" }, f.ai_comment) : "",
          el("div", { class: "sub" }, `оценено ${humanDue(f.ai_assessed_at || "")}`)]
        : el("p", { class: "sub" }, "Кира оценит в течение минуты."),
      el("button", { class: "btn ghost small", onclick: (e) => attempt(async () => {
        e.target.disabled = true; e.target.textContent = "Оцениваю…";
        try { await api("POST", `/api/items/${item.id}/assess`); toast("Кира оценила риск"); refresh(); }
        finally { e.target.disabled = false; e.target.textContent = "Оценить заново"; }
      }) }, "Оценить заново")));
}

function attachmentPanel(item) {
  const f = item.fields;
  if (f.file_key) {
    const isImg = /^image\//.test(f.file_type || "");
    return el("div", { class: "attach-panel" },
      isImg ? el("img", { src: `/api/files/${item.id}?inline=1`, alt: f.file_name, class: "attach-preview" }) : "",
      el("a", { class: "btn", href: `/api/files/${item.id}` }, `Скачать ${f.file_name} (${fileSize(f.file_size)})`));
  }
  if (f.url) return el("div", { class: "attach-panel" }, el("a", { class: "btn", href: f.url, target: "_blank", rel: "noopener" }, "Открыть ссылку"));
  return "";
}

// Люди с ролями у объекта
function peoplePanel(item) {
  const people = item.links.filter((l) => l.kind === "person");
  const roles = state.schema?.person_roles || [];
  const nameIn = el("input", { type: "text", list: "people-list", placeholder: "Имя", "aria-label": "Человек" });
  const roleIn = el("input", { type: "text", list: "role-list", placeholder: "Роль", "aria-label": "Роль", value: roles[0] || "" });
  const dl1 = el("datalist", { id: "people-list" });
  api("GET", "/api/items?kind=person&order=title&limit=500").then(({ items }) => dl1.append(...items.map((p) => el("option", { value: p.title }))));
  const dl2 = el("datalist", { id: "role-list" }, roles.map((r) => el("option", { value: r })));
  const form = el("form", { class: "add-child", onsubmit: (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) return;
    attempt(async () => {
      const { items } = await api("GET", `/api/items?kind=person&q=${encodeURIComponent(name)}`);
      let p = items.find((x) => x.title.toLowerCase() === name.toLowerCase());
      if (!p) p = (await api("POST", "/api/items", { kind: "person", title: name })).item;
      await api("POST", `/api/items/${item.id}/links`, { other_id: p.id, role: roleIn.value.trim() || "участник" });
      refresh();
    });
  } }, nameIn, roleIn, el("button", { class: "btn", type: "submit" }, "Добавить"), dl1, dl2);
  return [
    el("h3", {}, "Люди"),
    people.length ? el("ul", { class: "children" }, people.map((p) => el("li", {},
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(p.id); } }, p.title),
      el("span", { class: "chip-mini" }, p.role),
      p.fields?.company ? el("span", { class: "sub" }, p.fields.company) : "",
      el("button", { class: "icon-btn", "aria-label": `Убрать ${p.title}`, onclick: () => attempt(async () => { await api("DELETE", `/api/links/${p.link_id}`); refresh(); }) }, "×")))) : "",
    form,
  ];
}

// Карточка человека: где он участвует
function personPanel(item) {
  const where = item.links.filter((l) => l.kind !== "person");
  return [
    el("h3", {}, "Участвует"),
    where.length ? el("ul", { class: "children" }, where.map((w) => el("li", {},
      el("span", { class: `kind-dot k-${w.kind}` }),
      isCore(w.kind) ? el("a", { href: `/o/${w.id}` }, w.title) : el("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(w.id); } }, w.title),
      el("span", { class: "chip-mini" }, w.role)))) : el("p", { class: "sub" }, "Пока нигде."),
  ];
}

// Что блокирует блокер
function blocksPanel(item) {
  const blocks = item.links.filter((l) => l.role === "blocks" && l.direction === "out");
  const sel = el("select", { "aria-label": "Что блокирует" }, el("option", { value: "" }, "— выбери, что блокирует —"));
  const home = [...item.path].reverse().find((p) => isCore(p.kind));
  if (home) {
    api("GET", `/api/items?parent_id=${home.id}&kinds=task,mission,goal,project&open=1`).then(({ items }) =>
      sel.append(...items.map((x) => el("option", { value: x.id }, `${T(x.kind).label}: ${x.title}`))));
  }
  return [
    el("h3", {}, "Блокирует"),
    blocks.length ? el("ul", { class: "children" }, blocks.map((b) => el("li", {},
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); isCore(b.kind) ? navigate(`/o/${b.id}`) : openItem(b.id); } }, b.title),
      el("button", { class: "icon-btn", "aria-label": "Убрать", onclick: () => attempt(async () => { await api("DELETE", `/api/links/${b.link_id}`); refresh(); }) }, "×")))) : "",
    home ? el("div", { class: "add-child" }, sel, el("button", { class: "btn", onclick: () => sel.value && attempt(async () => {
      await api("POST", `/api/items/${item.id}/links`, { other_id: +sel.value, role: "blocks" });
      refresh();
    }) }, "Связать")) : "",
  ];
}

function otherLinks(item) {
  const other = item.links.filter((l) => l.kind !== "person" && !(item.kind === "blocker" && l.role === "blocks" && l.direction === "out") && !(l.role === "blocks" && l.direction === "in"));
  if (!other.length || item.kind === "person") return "";
  return [el("h3", {}, "Связи"), el("ul", { class: "children" }, other.map((l) => el("li", {},
    el("span", { class: `kind-dot k-${l.kind}` }),
    el("a", { href: "#", onclick: (e) => { e.preventDefault(); isCore(l.kind) ? navigate(`/o/${l.id}`) : openItem(l.id); } }, l.title),
    el("span", { class: "chip-mini" }, l.role === "related" ? "связано" : l.role === "participant" ? "участник" : l.role),
    el("button", { class: "icon-btn", "aria-label": "Убрать", onclick: () => attempt(async () => { await api("DELETE", `/api/links/${l.link_id}`); refresh(); }) }, "×"))))];
}

export function commentsPanel(item) {
  const text = el("textarea", { rows: 2, placeholder: "Комментарий", "aria-label": "Комментарий", class: "small-text" });
  return [
    el("h3", {}, "Комментарии"),
    item.comments.length ? el("ul", { class: "comments" }, item.comments.map((c) => el("li", { class: c.author === "kira" ? "kira" : "" },
      el("div", { class: "when" }, `${c.author === "kira" ? "Кира" : "Я"} · ${humanDue(c.at)}`,
        el("button", { class: "icon-btn", "aria-label": "Удалить комментарий", onclick: () => attempt(async () => { await api("DELETE", `/api/comments/${c.id}`); refresh(); }) }, "×")),
      el("div", { class: "what" }, c.text)))) : "",
    el("form", { class: "add-child", onsubmit: (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      attempt(async () => { await api("POST", `/api/items/${item.id}/comments`, { text: text.value.trim() }); text.value = ""; refresh(); });
    } }, text, el("button", { class: "btn", type: "submit" }, "Отправить")),
  ];
}

export function addInline(placeholder, create) {
  const input = el("input", { type: "text", placeholder, "aria-label": placeholder });
  return el("form", { class: "add-child", onsubmit: (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    attempt(async () => { await create(input.value.trim()); input.value = ""; refresh(); });
  } }, input, el("button", { class: "btn", type: "submit" }, "Добавить"));
}

const FIELD_NAMES = {
  title: "название", body: "описание", status: "статус", priority: "приоритет", due_at: "срок", event_at: "дата",
  parent_id: "место", stage_id: "стадия", tags: "метки", kind: "вид", deleted_at: "удаление",
};

export function describeHistory(h, kind) {
  if (h.action === "create") return "Создано";
  if (h.action === "delete") return "Удалено";
  if (h.action === "restore") return "Восстановлено";
  if (h.action === "comment") return `Комментарий: ${h.changes?.comment?.[1] || ""}`;
  if (h.action === "link") return `Связь: ${h.changes?.link?.[1] || ""}`;
  if (h.action === "unlink") return `Связь убрана: ${h.changes?.link?.[0] || ""}`;
  return describeDiff(h.changes, kind);
}

export function describeDiff(diff, kind) {
  if (!diff) return "Изменено";
  const parts = [];
  const defs = T(kind).fields || {};
  for (const [k, [from, to]] of Object.entries(diff)) {
    if (["due_has_time", "position", "meta"].includes(k)) continue;
    if (k === "status") parts.push(`${T(kind).statuses[from] || from} → ${T(kind).statuses[to] || to}`);
    else if (k === "due_at" || k === "event_at") parts.push(`${FIELD_NAMES[k]}: ${from ? isoToLocal(from) : "нет"} → ${to ? isoToLocal(to) : "нет"}`);
    else if (k === "priority") parts.push(`приоритет: ${PRIORITY[from]} → ${PRIORITY[to]}`);
    else if (k === "title") parts.push(`название: «${to}»`);
    else if (k.startsWith("fields.")) {
      const name = k.slice(7);
      if (name === "ai_for_version" || name === "ai_assessed_at") continue;
      parts.push(`${defs[name]?.label || name}: ${to ?? "—"}`);
    } else parts.push(FIELD_NAMES[k] || k);
  }
  return parts.join("; ") || "Изменено";
}

// ---------- контакты и сеть ----------
const LOYALTY_CLASS = { 1: "bad", 2: "warn", 3: "", 4: "ok", 5: "ok strong" };
export function loyaltyChip(v) {
  const label = state.schema?.loyalty?.[v] || v;
  return el("span", { class: `chip-mini loyal l${v} ${LOYALTY_CLASS[v] || ""}`, title: "Лояльность — моя оценка" }, `${v} · ${label.toLowerCase()}`);
}

// Лояльность и мой комментарий об отношениях; рядом — модель от Киры
function relationPanel(item, save) {
  const f = item.fields;
  const rel = el("textarea", { id: "f-relation", rows: 4, placeholder: "Кто он мне, откуда знаем, как относится, с кем связан, чем может помочь…", "aria-label": "Мои отношения" }, f.relation || "");
  rel.addEventListener("change", () => save({ fields: { relation: rel.value || null } }, "Сохранено — Кира обновит модель связей"));
  const labels = state.schema?.loyalty || {};
  return el("div", { class: "relation-panel" },
    el("div", { class: "rel-h" }, "Лояльность", f.loyalty ? loyaltyChip(f.loyalty) : el("span", { class: "sub" }, "не оценена")),
    el("div", { class: "loyalty-scale", role: "radiogroup", "aria-label": "Лояльность" }, [1, 2, 3, 4, 5].map((v) => el("button", {
      type: "button", class: `loy-btn l${v}` + (f.loyalty === v ? " on" : ""), role: "radio", "aria-checked": f.loyalty === v ? "true" : "false",
      title: labels[v], onclick: () => save({ fields: { loyalty: f.loyalty === v ? null : v } }),
    }, el("span", { class: "loy-n" }, v), el("span", { class: "loy-t" }, labels[v] || "")))),
    el("label", { class: "rel-h", for: "f-relation" }, "Мои отношения"),
    rel,
    el("div", { class: "ai-model" },
      el("div", { class: "rel-h" }, "Модель Киры", f.ai_influence ? el("span", { class: "chip-mini", title: "Влиятельность" }, `влияние ${f.ai_influence}/5`) : ""),
      f.ai_summary ? el("p", {}, f.ai_summary) : el("p", { class: "sub" }, f.relation ? "Кира построит модель в течение минуты." : "Напиши об отношениях — Кира построит модель связей."),
      f.ai_approach ? el("p", {}, el("b", {}, "Как выстраивать: "), f.ai_approach) : "",
      f.ai_assessed_at ? el("div", { class: "sub" }, `обновлено ${humanDue(f.ai_assessed_at)}`) : "",
      f.relation ? el("button", { class: "btn ghost small", onclick: (e) => attempt(async () => {
        e.target.disabled = true; e.target.textContent = "Строю…";
        try { await api("POST", `/api/items/${item.id}/network`); toast("Модель обновлена"); refresh(); }
        finally { e.target.disabled = false; e.target.textContent = "Пересобрать"; }
      }) }, "Пересобрать") : ""));
}

// Связи с другими людьми: мои и найденные Кирой; как выйти на человека
function personLinks(item) {
  const links = item.links.filter((l) => l.kind === "person");
  const nameIn = el("input", { type: "text", list: "people-list2", placeholder: "Имя", "aria-label": "С кем связан" });
  const typeIn = el("input", { type: "text", list: "plink-list", placeholder: "Кто ему", "aria-label": "Тип связи" });
  const dl1 = el("datalist", { id: "people-list2" });
  api("GET", "/api/items?kind=person&order=title&limit=1000").then(({ items }) => dl1.append(...items.filter((p) => p.id !== item.id).map((p) => el("option", { value: p.title }))));
  const dl2 = el("datalist", { id: "plink-list" }, (state.schema?.person_links || []).map((r) => el("option", { value: r })));
  const pathsBox = el("div", { class: "paths" });
  const showPaths = () => attempt(async () => {
    const r = await api("GET", `/api/items/${item.id}/paths`);
    pathsBox.replaceChildren(r.direct
      ? el("p", { class: "sub" }, "Выход прямой — он и так к тебе расположен.")
      : r.paths.length ? el("ol", { class: "path-list" }, r.paths.map((p) => el("li", {}, p.chain)))
        : el("p", { class: "sub" }, "Цепочек через лояльных людей не нашлось. Расскажи Кире, кто с кем знаком."));
  });
  return [
    el("h3", {}, "Связи с людьми"),
    links.length ? el("ul", { class: "children" }, links.map((l) => el("li", {},
      el("span", { class: "kind-dot k-person" }),
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openItem(l.id); } }, l.title),
      el("span", { class: "chip-mini" }, l.role),
      l.origin === "ai" ? el("span", { class: "chip-mini ai", title: l.note || "По твоему комментарию" }, "Кира") : "",
      l.fields?.loyalty ? loyaltyChip(l.fields.loyalty) : "",
      el("button", { class: "icon-btn", "aria-label": "Убрать", onclick: () => attempt(async () => { await api("DELETE", `/api/links/${l.link_id}`); refresh(); }) }, "×")))) : el("p", { class: "sub" }, "Связей пока нет."),
    el("form", { class: "add-child", onsubmit: (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) return;
      attempt(async () => {
        const { items } = await api("GET", `/api/items?kind=person&q=${encodeURIComponent(name)}`);
        let p = items.find((x) => x.title.toLowerCase() === name.toLowerCase());
        if (!p) p = (await api("POST", "/api/items", { kind: "person", title: name })).item;
        await api("POST", `/api/items/${item.id}/links`, { other_id: p.id, role: typeIn.value.trim() || "знакомый" });
        refresh();
      });
    } }, nameIn, typeIn, el("button", { class: "btn", type: "submit" }, "Связать"), dl1, dl2),
    (item.fields.loyalty || 0) < 4 ? [el("button", { class: "btn ghost small", onclick: showPaths }, "Как на него выйти"), pathsBox] : "",
  ];
}
