// Веб-интерфейс Киры. Без сборки и библиотек: один модуль, всё общение с сервером через /api.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false && kid !== "") n.append(kid.nodeType ? kid : String(kid));
  return n;
};

const KIND = { task: "Задача", project: "Проект", goal: "Цель", note: "Заметка" };
const STATUS = {
  task: { todo: "К выполнению", doing: "В работе", waiting: "Ждёт", done: "Сделано", cancelled: "Отменено" },
  project: { active: "Идёт", paused: "На паузе", done: "Завершён", archived: "В архиве" },
  goal: { active: "В процессе", achieved: "Достигнута", dropped: "Отброшена" },
  note: { active: "Актуальна", archived: "В архиве" },
};
const DONE = { task: "done", project: "done", goal: "achieved", note: "archived" };
const OPEN = { task: "todo", project: "active", goal: "active", note: "active" };
const PRIORITY = ["Нет", "Низкий", "Средний", "Высокий"];
const FIELD = {
  title: "название", body: "описание", status: "статус", priority: "приоритет", due_at: "срок",
  due_has_time: null, parent_id: "место", tags: "метки", kind: "вид", deleted_at: "удаление", position: null, meta: null,
};
const SOURCE = { web: "сайт", bot: "бот", ai: "ассистент", system: "система" };

let state = { tz: "Europe/Moscow", projects: [], selected: null, view: null };

// ---------- сервер ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Нужно войти"); }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), error ? 4500 : 2200);
}

async function attempt(fn) {
  try { return await fn(); } catch (e) { if (e.message !== "Нужно войти") toast(e.message, true); }
}

// ---------- даты ----------
function localToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: state.tz }).format(new Date());
}
function addDays(d, n) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEK = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function humanDate(d) {
  const today = localToday();
  if (d === today) return "сегодня";
  if (d === addDays(today, 1)) return "завтра";
  if (d === addDays(today, -1)) return "вчера";
  const x = new Date(d + "T00:00:00Z");
  const sameYear = d.slice(0, 4) === today.slice(0, 4);
  return `${WEEK[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${sameYear ? "" : " " + d.slice(0, 4)}`;
}
function humanDue(due) {
  if (!due) return "";
  const [d, t] = due.split(" ");
  return humanDate(d) + (t ? ` ${t}` : "");
}
function isoToLocal(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: state.tz, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

// ---------- вход ----------
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("POST", "/api/login", { password: $("#password").value });
    $("#password").value = "";
    await boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

// ---------- навигация ----------
function navigate(path, replace = false) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  render();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='/']");
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", render);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selected) closeDrawer();
});

function route() {
  const p = location.pathname;
  let m;
  if ((m = p.match(/^\/project\/(\d+)/))) return { view: "project", id: +m[1] };
  const v = p.replace(/^\/|\/$/g, "") || "today";
  return { view: ["today", "inbox", "all", "assistant", "goals", "notes", "changes", "settings", "projects"].includes(v) ? v : "today" };
}

async function render() {
  const r = route();
  state.view = r;
  document.querySelectorAll(".side a").forEach((a) => {
    const active = (a.dataset.view && a.dataset.view === r.view) || (r.view === "project" && a.dataset.project == r.id);
    a.classList.toggle("active", !!active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const main = $("#main");
  main.replaceChildren();
  const views = { today, inbox, all, assistant, goals, notes, changes, settings, project, projects: projectsView };
  await attempt(() => views[r.view](main, r));
}

// ---------- боковое меню: проекты ----------
async function loadProjects() {
  const { items } = await api("GET", "/api/items?kind=project&open=1&order=position");
  state.projects = items;
  const box = $("#project-list");
  box.replaceChildren(
    ...items.map((p) => el("a", { href: `/project/${p.id}`, "data-project": p.id }, el("span", {}, p.title))),
  );
  if (!items.length) box.append(el("p", { class: "empty", style: "padding:4px 10px;font-size:13px" }, "Пока нет"));
}

$("#new-project").addEventListener("click", () => attempt(async () => {
  const title = prompt("Название проекта");
  if (!title?.trim()) return;
  const { item } = await api("POST", "/api/items", { kind: "project", title: title.trim() });
  await loadProjects();
  navigate(`/project/${item.id}`);
}));

// ---------- строки задач ----------
function row(item, { showParent = true } = {}) {
  const parent = item.parent_id && state.projects.find((p) => p.id === item.parent_id);
  const meta = [];
  if (item.due) meta.push(el("span", { class: item.overdue ? "late" : "" }, humanDue(item.due)));
  if (showParent && parent) meta.push(el("span", {}, parent.title));
  if (item.tags.length) meta.push(el("span", {}, item.tags.map((t) => "#" + t).join(" ")));
  if (item.kind === "task" && item.status === "doing") meta.push(el("span", {}, "в работе"));
  if (item.kind === "task" && item.status === "waiting") meta.push(el("span", {}, "ждёт"));
  const done = DONE[item.kind];
  const li = el("li", {
    class: "row" + (item.closed ? " closed" : "") + (state.selected === item.id ? " selected" : ""),
    "data-priority": item.priority, "data-id": item.id,
    onclick: () => openDrawer(item.id),
  },
  el("button", {
    class: "check" + (item.closed ? " on" : ""), "aria-label": item.closed ? "Вернуть в работу" : "Отметить выполненной",
    onclick: (e) => {
      e.stopPropagation();
      attempt(async () => {
        await api("PATCH", `/api/items/${item.id}`, { status: item.closed ? OPEN[item.kind] : done });
        toast(item.closed ? "Вернула в работу" : "Готово");
        refresh();
      });
    },
  }),
  el("div", {}, el("div", { class: "title" }, item.title), meta.length ? el("div", { class: "meta" }, meta) : null),
  el("div", { class: "side-info" }, item.kind !== "task" ? KIND[item.kind] : ""));
  return li;
}

function group(title, items, opts = {}) {
  if (!items.length && !opts.always) return "";
  return el("section", { class: "group " + (opts.cls || "") },
    el("h2", { class: "group-title" }, title, el("span", { class: "n" }, items.length || "")),
    items.length ? el("ul", { class: "list" }, items.map((i) => row(i, opts))) : el("p", { class: "empty" }, opts.empty || "Пусто"),
  );
}

function quickAdd({ parent_id, kind = "task", placeholder = "Новая задача" } = {}) {
  const title = el("input", { type: "text", placeholder, "aria-label": "Название" });
  const due = el("input", { type: "date", "aria-label": "Срок" });
  const prio = el("select", { "aria-label": "Приоритет" }, PRIORITY.map((p, i) => el("option", { value: i }, i ? p : "Приоритет")));
  const form = el("form", { class: "quick", onsubmit: (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    attempt(async () => {
      await api("POST", "/api/items", {
        kind, title: title.value.trim(), parent_id: parent_id ?? null, due: due.value || null, priority: +prio.value,
      });
      title.value = ""; due.value = ""; prio.value = 0;
      refresh();
    });
  } }, title, due, prio, el("button", { class: "btn primary", type: "submit" }, "Добавить"));
  if (kind !== "task") { due.remove(); form.style.gridTemplateColumns = "1fr auto auto"; }
  return form;
}

let refreshing = null;
function refresh() {
  clearTimeout(refreshing);
  refreshing = setTimeout(async () => {
    const y = scrollY;
    await loadProjects().catch(() => {});
    await render();
    scrollTo(0, y);
    if (state.selected) openDrawer(state.selected, { keepScroll: true });
  }, 50);
}

// ---------- разделы ----------
async function today(main) {
  const a = await api("GET", "/api/agenda?days=7");
  const x = new Date(a.today + "T00:00:00Z");
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(x);
  main.append(
    el("header", { class: "day-head" },
      el("h1", { class: "weekday" }, weekday[0].toUpperCase() + weekday.slice(1)),
      el("p", { class: "date" }, new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(x)),
    ),
    quickAdd(),
    group("Просрочено", a.overdue, { cls: "overdue" }),
    group("Сегодня", a.today_tasks, { always: !a.overdue.length, empty: "На сегодня ничего. Добавь задачу или напиши ассистенту." }),
    group("В работе", a.in_progress.filter((t) => !t.due)),
    group("Важное без срока", a.important_no_date),
    group("На неделе", a.upcoming),
  );
}

async function inbox(main) {
  main.append(
    el("h1", { class: "view-title" }, "Входящие"),
    el("p", { class: "view-sub" }, "Задачи без проекта. Разбери: привяжи к проекту, поставь срок или выполни."),
    quickAdd(),
  );
  const { items } = await api("GET", "/api/items?kind=task&root=1&open=1");
  main.append(group("Открытые", items, { always: true, empty: "Входящие разобраны." }));
}

async function all(main) {
  main.append(el("h1", { class: "view-title" }, "Все задачи"), el("p", { class: "view-sub" }, "Открытые задачи по срокам."));
  const search = el("input", { type: "search", placeholder: "Поиск по задачам", "aria-label": "Поиск" });
  const box = el("div");
  main.append(el("div", { style: "margin-bottom:20px" }, search), box);
  const load = async () => {
    const q = search.value.trim();
    const { items } = await api("GET", `/api/items?kind=task&open=1${q ? "&q=" + encodeURIComponent(q) : ""}`);
    box.replaceChildren(group(q ? "Найдено" : "Открытые", items, { always: true, empty: q ? "Ничего не нашлось." : "Открытых задач нет." }) || "");
    if (!q) {
      const done = await api("GET", "/api/items?kind=task&open=0&order=recent&limit=30");
      const g = group("Недавно закрытые", done.items);
      if (g) box.append(g);
    }
  };
  let t;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => attempt(load), 250); });
  await load();
}

async function project(main, { id }) {
  const { item } = await api("GET", `/api/items/${id}`);
  const tasks = item.children.filter((c) => c.kind === "task");
  const other = item.children.filter((c) => c.kind !== "task");
  const open = tasks.filter((t) => !t.closed);
  const closed = tasks.filter((t) => t.closed);
  main.append(
    el("h1", { class: "view-title" }, item.title),
    el("p", { class: "view-sub" },
      `${STATUS.project[item.status]}${item.due ? " · срок " + humanDue(item.due) : ""} · `,
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openDrawer(item.id); } }, "карточка проекта")),
    item.body ? el("p", { style: "white-space:pre-wrap;margin:-8px 0 22px" }, item.body) : "",
    quickAdd({ parent_id: item.id }),
    group("Задачи", open, { always: true, showParent: false, empty: "В проекте нет открытых задач." }),
    group("Цели и заметки", other, { showParent: false }),
    group("Выполнено", closed, { showParent: false }),
  );
}

async function projectsView(main) {
  main.append(el("h1", { class: "view-title" }, "Проекты"), quickAdd({ kind: "project", placeholder: "Новый проект" }));
  const { items } = await api("GET", "/api/items?kind=project&order=position");
  main.append(group("Все проекты", items, { always: true, empty: "Проектов пока нет." }));
  main.querySelectorAll(".row").forEach((r) => (r.onclick = () => navigate(`/project/${r.dataset.id}`)));
}

async function goals(main) {
  main.append(
    el("h1", { class: "view-title" }, "Цели"),
    el("p", { class: "view-sub" }, "Большие цели. Шаги к ним — задачи внутри цели."),
    quickAdd({ kind: "goal", placeholder: "Новая цель" }),
  );
  const { items } = await api("GET", "/api/items?kind=goal");
  main.append(group("Цели", items.filter((g) => !g.closed), { always: true, empty: "Целей пока нет." }), group("Закрытые", items.filter((g) => g.closed)));
}

async function notes(main) {
  main.append(el("h1", { class: "view-title" }, "Заметки"), quickAdd({ kind: "note", placeholder: "Новая заметка" }));
  const { items } = await api("GET", "/api/items?kind=note&order=recent");
  main.append(group("Заметки", items, { always: true, empty: "Заметок пока нет." }));
}

async function changes(main) {
  main.append(el("h1", { class: "view-title" }, "История"), el("p", { class: "view-sub" }, "Что менялось за последние 14 дней."));
  const { changes } = await api("GET", "/api/changes?days=14");
  if (!changes.length) { main.append(el("p", { class: "empty" }, "Изменений пока нет.")); return; }
  main.append(el("ul", { class: "feed" }, changes.map((c) => el("li", {},
    el("div", { class: "when" }, humanDue(c.at_local)),
    el("div", { class: "what" },
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openDrawer(c.id); } }, c.title),
      el("div", { class: "detail" }, describeChange(c), ` · ${SOURCE[c.source] || c.source}`),
    ),
  ))));
}

function describeChange(c) {
  if (c.action === "create") return `${KIND[c.kind] || c.kind}: создано`;
  if (c.action === "delete") return "удалено";
  if (c.action === "restore") return "восстановлено";
  return describeDiff(c.changes, c.kind);
}

function describeDiff(diff, kind) {
  if (!diff) return "изменено";
  const parts = [];
  for (const [f, [from, to]] of Object.entries(diff)) {
    const name = FIELD[f];
    if (name === null) continue;
    if (f === "status") parts.push(`${STATUS[kind]?.[from] || from} → ${STATUS[kind]?.[to] || to}`);
    else if (f === "due_at") parts.push(`срок: ${from ? isoToLocal(from) : "нет"} → ${to ? isoToLocal(to) : "нет"}`);
    else if (f === "priority") parts.push(`приоритет: ${PRIORITY[from]} → ${PRIORITY[to]}`);
    else if (f === "title") parts.push(`название: «${to}»`);
    else if (f === "body") parts.push("описание изменено");
    else if (f === "parent_id") parts.push("перенесено");
    else parts.push(name || f);
  }
  return parts.join("; ") || "изменено";
}

async function assistant(main) {
  main.append(
    el("h1", { class: "view-title" }, "Ассистент"),
    el("p", { class: "view-sub" }, "То же, что в Telegram: пиши дела, мысли, вопросы — разложу на задачи и подскажу, что делать."),
  );
  const chat = el("div", { class: "chat", "aria-live": "polite" });
  const input = el("textarea", { placeholder: "Например: завтра в 11 созвон с Петром по SalesFox, до пятницы подготовить смету", rows: 2, "aria-label": "Сообщение" });
  const smart = el("input", { type: "checkbox", id: "smart" });
  const send = el("button", { class: "btn primary", type: "submit" }, "Отправить");
  const form = el("form", { class: "chat-form" }, input, send);
  const tools = el("div", { class: "chat-tools" },
    el("label", {}, smart, " думать дольше (умная модель)"),
    el("button", { class: "btn ghost", type: "button", onclick: () => attempt(async () => {
      await api("POST", "/api/chat/reset");
      chat.replaceChildren();
      toast("Начали заново");
    }) }, "Начать заново"));
  main.append(chat, form, tools);

  const bubble = (role, text) => el("div", { class: `bubble ${role}` }, text);
  const { messages } = await api("GET", "/api/chat");
  chat.append(...messages.map((m) => bubble(m.role, m.text)));
  if (!messages.length) chat.append(bubble("assistant", "Привет! Что у тебя сегодня?"));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    chat.append(bubble("user", text));
    const wait = bubble("assistant pending", "Думаю…");
    chat.append(wait);
    wait.scrollIntoView({ block: "end" });
    send.disabled = true;
    attempt(async () => {
      try {
        const r = await api("POST", "/api/chat", { text, smart: smart.checked });
        wait.className = "bubble assistant";
        wait.textContent = r.text;
        if (r.tools?.some((t) => /create|update|delete|restore/.test(t.tool))) loadProjects();
      } catch (err) {
        wait.remove();
        input.value = text;
        throw err;
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  });
  input.focus();
}

async function settings(main) {
  main.append(el("h1", { class: "view-title" }, "Настройки"));
  const bot = await api("GET", "/api/bot");
  const time = el("input", { type: "time", value: bot.morning_time === "off" ? "" : bot.morning_time, "aria-label": "Время утреннего плана" });
  main.append(el("div", { class: "settings" },
    el("section", {},
      el("h2", { class: "group-title" }, "Telegram-бот"),
      bot.owner
        ? el("p", {}, `Привязан к ${bot.owner.name}${bot.owner.username ? " (@" + bot.owner.username + ")" : ""} с ${isoToLocal(bot.owner.since)}.`)
        : el("p", {}, "Ещё не привязан. Напиши боту: /start и пароль от сайта."),
      bot.owner ? el("button", { class: "btn danger", onclick: () => attempt(async () => {
        if (!confirm("Отвязать бота? Чтобы привязать снова, понадобится /start с паролем.")) return;
        await api("PATCH", "/api/bot", { unlink_owner: true });
        toast("Бот отвязан");
        render();
      }) }, "Отвязать") : ""),
    el("section", {},
      el("h2", { class: "group-title" }, "Утренний план"),
      el("p", {}, "Во сколько бот присылает план на день. Пустое поле — не присылать."),
      el("div", { class: "line" }, time, el("button", { class: "btn", onclick: () => attempt(async () => {
        await api("PATCH", "/api/bot", { morning_time: time.value || "off" });
        toast(time.value ? `Буду присылать в ${time.value}` : "Утренний план выключен");
      }) }, "Сохранить"))),
    el("section", {},
      el("h2", { class: "group-title" }, "Выход"),
      el("button", { class: "btn", onclick: async () => { await api("POST", "/api/logout"); showLogin(); } }, "Выйти")),
  ));
}

// ---------- карточка записи ----------
function closeDrawer() {
  state.selected = null;
  $("#drawer").hidden = true;
  $("#app").classList.remove("with-drawer");
  document.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
}

async function openDrawer(id, { keepScroll = false } = {}) {
  const d = $("#drawer");
  const y = d.scrollTop;
  let item, history;
  try {
    [{ item }, { history }] = await Promise.all([api("GET", `/api/items/${id}`), api("GET", `/api/items/${id}/history`)]);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  state.selected = id;
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("selected", +r.dataset.id === id));
  $("#app").classList.add("with-drawer");
  d.hidden = false;

  const save = (patch, note) => attempt(async () => {
    await api("PATCH", `/api/items/${id}`, patch);
    if (note) toast(note);
    refresh();
  });

  const title = el("textarea", { class: "title-input", rows: 1, "aria-label": "Название" }, item.title);
  const fit = () => { title.style.height = "auto"; title.style.height = title.scrollHeight + "px"; };
  title.addEventListener("input", fit);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
  title.addEventListener("change", () => title.value.trim() && title.value.trim() !== item.title && save({ title: title.value.trim() }));
  setTimeout(fit);

  const status = el("select", { id: "f-status", onchange: () => save({ status: status.value }) },
    Object.entries(STATUS[item.kind]).map(([k, v]) => el("option", { value: k, selected: k === item.status }, v)));
  const prio = el("select", { id: "f-prio", onchange: () => save({ priority: +prio.value }) },
    PRIORITY.map((p, i) => el("option", { value: i, selected: i === item.priority }, p)));
  const [dd, dt] = item.due ? item.due.split(" ") : ["", ""];
  const dueDate = el("input", { type: "date", id: "f-due", value: dd });
  const dueTime = el("input", { type: "time", value: dt || "", "aria-label": "Время" });
  const saveDue = () => save({ due: dueDate.value ? dueDate.value + (dueTime.value ? " " + dueTime.value : "") : null });
  dueDate.addEventListener("change", saveDue);
  dueTime.addEventListener("change", saveDue);
  const parentOptions = [el("option", { value: "" }, "— без проекта —"),
    ...state.projects.filter((p) => p.id !== item.id).map((p) => el("option", { value: p.id, selected: p.id === item.parent_id }, p.title))];
  if (item.parent_id && !state.projects.some((p) => p.id === item.parent_id)) {
    const last = item.path.at(-1);
    parentOptions.push(el("option", { value: item.parent_id, selected: true }, last ? last.title : `#${item.parent_id}`));
  }
  const parent = el("select", { id: "f-parent", onchange: () => save({ parent_id: parent.value || null }, "Перенесено") }, parentOptions);
  const kind = el("select", { id: "f-kind", onchange: () => save({ kind: kind.value }) },
    Object.entries(KIND).map(([k, v]) => el("option", { value: k, selected: k === item.kind }, v)));
  const tags = el("input", { type: "text", id: "f-tags", value: item.tags.join(", "), placeholder: "через запятую" });
  tags.addEventListener("change", () => save({ tags: tags.value }));
  const body = el("textarea", { id: "f-body", placeholder: "Подробности, мысли, ссылки…", "aria-label": "Описание" }, item.body || "");
  body.addEventListener("change", () => save({ body: body.value || null }));

  const childInput = el("input", { type: "text", placeholder: item.kind === "task" ? "Подзадача" : "Новая задача внутри" });
  const addChild = el("form", { class: "add-child", onsubmit: (e) => {
    e.preventDefault();
    if (!childInput.value.trim()) return;
    attempt(async () => {
      await api("POST", "/api/items", { kind: "task", title: childInput.value.trim(), parent_id: id });
      childInput.value = "";
      refresh();
    });
  } }, childInput, el("button", { class: "btn", type: "submit" }, "Добавить"));

  d.replaceChildren(
    el("div", { class: "drawer-top" },
      el("span", {}, `${KIND[item.kind]} #${item.id}`),
      el("button", { class: "icon-btn", "aria-label": "Закрыть", onclick: closeDrawer }, "×")),
    item.path.length ? el("div", { class: "path" }, item.path.map((p, i) => [i ? " / " : "",
      p.kind === "project" ? el("a", { href: `/project/${p.id}` }, p.title)
        : el("a", { href: "#", onclick: (e) => { e.preventDefault(); openDrawer(p.id); } }, p.title)])) : "",
    title,
    item.deleted ? el("p", { style: "color:var(--danger)" }, "Запись удалена.") : "",
    el("div", { class: "fields" },
      el("label", { for: "f-status" }, "Статус"), status,
      el("label", { for: "f-due" }, "Срок"), el("div", { class: "due-pair" }, dueDate, dueTime),
      el("label", { for: "f-prio" }, "Приоритет"), prio,
      el("label", { for: "f-parent" }, "Проект"), parent,
      el("label", { for: "f-tags" }, "Метки"), tags,
      el("label", { for: "f-kind" }, "Вид"), kind),
    body,
    el("h3", {}, item.kind === "task" ? "Подзадачи" : "Внутри"),
    item.children.length ? el("ul", { class: "children" }, item.children.map((c) => el("li", {},
      el("button", { class: "check" + (c.closed ? " on" : ""), "aria-label": "Отметить", onclick: () =>
        attempt(async () => { await api("PATCH", `/api/items/${c.id}`, { status: c.closed ? OPEN[c.kind] : DONE[c.kind] }); refresh(); }) }),
      el("a", { href: "#", style: c.closed ? "text-decoration:line-through;color:var(--done)" : "",
        onclick: (e) => { e.preventDefault(); openDrawer(c.id); } }, c.title)))) : "",
    addChild,
    el("h3", {}, "История"),
    el("ul", { class: "timeline" }, history.map((h) => el("li", {},
      el("div", { class: "when" }, `${humanDue(h.at_local)} · ${SOURCE[h.source] || h.source}`),
      el("div", { class: "what" }, h.action === "create" ? "Создано" : h.action === "delete" ? "Удалено"
        : h.action === "restore" ? "Восстановлено" : describeDiff(h.changes, item.kind))))),
    el("div", { class: "drawer-actions" },
      item.kind === "project" ? el("a", { class: "btn", href: `/project/${item.id}` }, "Открыть проект") : "",
      item.deleted
        ? el("button", { class: "btn", onclick: () => attempt(async () => { await api("POST", `/api/items/${id}/restore`); toast("Восстановлено"); refresh(); }) }, "Восстановить")
        : el("button", { class: "btn danger", onclick: () => attempt(async () => {
          const n = item.children.length;
          if (!confirm(`Удалить «${item.title}»${n ? ` вместе с вложенными (${n})` : ""}? Восстановить можно из истории.`)) return;
          await api("DELETE", `/api/items/${id}`);
          toast("Удалено");
          closeDrawer();
          if (state.view?.view === "project" && state.view.id === id) navigate("/", true);
          else refresh();
        }) }, "Удалить")),
  );
  if (keepScroll) d.scrollTop = y;
}

// ---------- запуск ----------
async function boot() {
  const me = await api("GET", "/api/me");
  if (!me.loggedIn) return showLogin();
  state.tz = me.tz || state.tz;
  $("#login").hidden = true;
  $("#app").hidden = false;
  await attempt(loadProjects);
  await render();
}

boot().catch(() => showLogin());
