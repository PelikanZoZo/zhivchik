// Разделы: сегодня, входящие, задачи, треки/проекты/миссии, люди, история, ассистент, настройки.
import { $, el, api, toast, attempt, refresh, navigate, state, hooks, humanDue, humanDate, isoToLocal, SOURCE, T, isCore } from "./core.js";
import { row, list, describeHistory } from "./item.js";
import { networkGraph } from "./network.js";

function group(title, items, opts = {}) {
  if (!items.length && !opts.always) return "";
  return el("section", { class: "group " + (opts.cls || "") },
    el("h2", { class: "group-title" }, title, el("span", { class: "n" }, items.length || "")),
    items.length ? list(items, opts) : el("p", { class: "empty" }, opts.empty || "Пусто"),
  );
}

// Быстрое добавление задачи (во входящие или в выбранный дом)
function quickTask({ withHome = true } = {}) {
  const title = el("input", { type: "text", placeholder: "Новая задача", "aria-label": "Новая задача" });
  const due = el("input", { type: "date", "aria-label": "Срок" });
  const home = el("select", { "aria-label": "Куда" }, el("option", { value: "" }, "Входящие"));
  if (withHome) {
    api("GET", "/api/items?kinds=track,project,mission&open=1&order=title&limit=300").then(({ items }) =>
      home.append(...items.map((i) => el("option", { value: i.id }, `${T(i.kind).label}: ${i.title}`))));
  }
  return el("form", { class: "quick", onsubmit: (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    attempt(async () => {
      await api("POST", "/api/items", { kind: "task", title: title.value.trim(), due: due.value || null, parent_id: home.value || null });
      title.value = ""; due.value = "";
      refresh();
    });
  } }, title, due, withHome ? home : "", el("button", { class: "btn primary", type: "submit" }, "Добавить"));
}

export async function today(main) {
  const a = await api("GET", "/api/agenda?days=7");
  const x = new Date(a.today + "T00:00:00Z");
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(x);
  main.append(
    el("header", { class: "day-head" },
      el("h1", { class: "weekday" }, weekday[0].toUpperCase() + weekday.slice(1)),
      el("p", { class: "date" }, new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(x))),
    quickTask(),
    group("Мешает", a.blockers, { cls: "overdue" }),
    group("Просрочено", a.overdue, { cls: "overdue" }),
    group("Сегодня", a.today_tasks, { always: !a.overdue.length && !a.blockers.length, empty: "На сегодня ничего. Добавь задачу или напиши Кире." }),
    group("В работе", a.in_progress.filter((t) => !t.due)),
    group("Миссии в работе", a.missions),
    group("Вехи и цели на неделе", a.goals_due),
    group("Высокие риски", a.high_risks),
    group("Важное без срока", a.important_no_date),
    group("На неделе", a.upcoming),
  );
}

export async function inbox(main) {
  main.append(
    el("h1", { class: "view-title" }, "Входящие"),
    el("p", { class: "view-sub" }, "Задачи без дома. Разбери: положи в трек, проект или миссию, поставь срок или выполни."),
    quickTask({ withHome: false }),
  );
  const { items } = await api("GET", "/api/items?kind=task&root=1&open=1");
  main.append(group("Открытые", items, { always: true, empty: "Входящие разобраны." }));
}

export async function tasks(main) {
  main.append(el("h1", { class: "view-title" }, "Все задачи"), el("p", { class: "view-sub" }, "Открытые задачи по срокам."), quickTask());
  const search = el("input", { type: "search", placeholder: "Поиск по задачам", "aria-label": "Поиск" });
  const box = el("div");
  main.append(el("div", { style: "margin-bottom:20px" }, search), box);
  const load = async () => {
    const q = search.value.trim();
    const { items } = await api("GET", `/api/items?kind=task&open=1${q ? "&q=" + encodeURIComponent(q) : ""}`);
    const homes = await api("GET", "/api/overview?kinds=track,project,mission");
    const titles = Object.fromEntries(homes.items.map((h) => [h.id, h]));
    for (const it of items) if (!it.home && titles[it.parent_id]) it.home = titles[it.parent_id];
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

// Треки, проекты, миссии — карточки с состоянием
export async function coreList(main, { kind }) {
  const t = T(kind);
  const intro = {
    track: "Постоянные направления. Внутри — проекты, миссии, задачи; стадии и цели.",
    project: "Работа с результатом и сроком: стадии, вехи, финальная цель.",
    mission: "Целевые операции: подготовка, информация, документы, люди.",
  }[kind];
  const title = el("input", { type: "text", placeholder: `${kind === "mission" ? "Новая миссия" : kind === "track" ? "Новый трек" : "Новый проект"}`, "aria-label": "Название" });
  const parentSel = el("select", { "aria-label": "Где" }, el("option", { value: "" }, "— сам по себе —"));
  if (t.parents.length) {
    api("GET", `/api/items?kinds=${t.parents.join(",")}&open=1&order=title`).then(({ items }) =>
      parentSel.append(...items.map((i) => el("option", { value: i.id }, `${T(i.kind).label}: ${i.title}`))));
  }
  main.append(
    el("h1", { class: "view-title" }, t.plural),
    el("p", { class: "view-sub" }, intro),
    el("form", { class: "quick", onsubmit: (e) => {
      e.preventDefault();
      if (!title.value.trim()) return;
      attempt(async () => {
        const { item } = await api("POST", "/api/items", { kind, title: title.value.trim(), parent_id: parentSel.value || null });
        await hooks.loadTree();
        navigate(`/o/${item.id}`);
      });
    } }, title, t.parents.length ? parentSel : "", el("button", { class: "btn primary", type: "submit" }, "Создать")),
  );
  const { items } = await api("GET", `/api/overview?kinds=${kind}`);
  const openItems = items.filter((i) => !i.closed);
  const closedItems = items.filter((i) => i.closed);
  if (!items.length) { main.append(el("p", { class: "empty" }, `${t.plural} пока нет.`)); return; }
  main.append(el("div", { class: "cards" }, openItems.map(card)));
  if (closedItems.length) main.append(el("details", { class: "closed-list" }, el("summary", {}, `Закрытые: ${closedItems.length}`), el("div", { class: "cards" }, closedItems.map(card))));
}

export function card(it) {
  const s = it.stats;
  const total = s.tasks_open + s.tasks_done;
  const pct = total ? Math.round((s.tasks_done / total) * 100) : null;
  return el("a", { class: "card" + (it.closed ? " closed" : ""), href: `/o/${it.id}` },
    el("span", { class: "card-top" }, el("span", { class: `kind-tag k-${it.kind}` }, T(it.kind).label), el("span", { class: "card-status" }, it.status_label)),
    el("span", { class: "card-title" }, it.title),
    it.home ? el("span", { class: "card-home" }, it.home.title) : "",
    s.stage ? el("span", { class: "card-line" }, `Стадия: ${s.stage}`) : "",
    s.next_milestone ? el("span", { class: "card-line" }, `Веха: ${s.next_milestone.title}${s.next_milestone.due ? ` — ${humanDue(s.next_milestone.due)}` : ""}`) : "",
    s.final_goal ? el("span", { class: "card-line" }, `Цель: ${s.final_goal.title}`) : "",
    it.due ? el("span", { class: "card-line" + (it.overdue ? " late" : "") }, `Срок: ${humanDue(it.due)}`) : "",
    el("span", { class: "card-stats" },
      total ? el("span", {}, `задачи ${s.tasks_done}/${total}`) : el("span", {}, "задач нет"),
      s.overdue ? el("span", { class: "late" }, `просрочено ${s.overdue}`) : "",
      s.blockers ? el("span", { class: "bad" }, `блокеров ${s.blockers}`) : "",
      s.high_risks ? el("span", { class: "bad" }, `высоких рисков ${s.high_risks}`) : "",
      s.missions_open && it.kind !== "mission" ? el("span", {}, `миссий ${s.missions_open}`) : ""),
    pct !== null ? el("span", { class: "goal-bar" }, el("span", { style: `width:${pct}%` })) : "");
}

export async function people(main) {
  const mode = new URLSearchParams(location.search).get("view") === "list" ? "list" : "net";
  const title = el("input", { type: "text", placeholder: "Имя", "aria-label": "Имя" });
  const company = el("input", { type: "text", placeholder: "Компания", "aria-label": "Компания" });
  const position = el("input", { type: "text", placeholder: "Должность", "aria-label": "Должность" });
  main.append(
    el("h1", { class: "view-title" }, "Контакты"),
    el("p", { class: "view-sub" }, "Моя контактная книжка и сеть связей. Ставь лояльность и пиши о своих отношениях с человеком — Кира по этому строит модель связей: кто он, с кем связан, как на него выйти."),
    el("div", { class: "jobs-bar" },
      el("div", { class: "tabs", role: "tablist" },
        el("a", { href: "/people", class: "tab" + (mode === "net" ? " on" : ""), role: "tab", "aria-selected": mode === "net" }, "Сеть"),
        el("a", { href: "/people?view=list", class: "tab" + (mode === "list" ? " on" : ""), role: "tab", "aria-selected": mode === "list" }, "Список"))),
    el("form", { class: "quick with-extra", onsubmit: (e) => {
      e.preventDefault();
      if (!title.value.trim()) return;
      attempt(async () => {
        const { item } = await api("POST", "/api/items", { kind: "person", title: title.value.trim(), fields: { company: company.value.trim() || null, position: position.value.trim() || null } });
        title.value = company.value = position.value = "";
        refresh();
        hooks.openItem(item.id);
      });
    } }, title, company, position, el("button", { class: "btn primary", type: "submit" }, "Добавить")),
  );
  if (mode === "net") {
    const data = await api("GET", "/api/network");
    if (!data.people.length) { main.append(el("p", { class: "empty" }, "Пока никого. Добавь человека или расскажи о нём Кире.")); return; }
    main.append(networkGraph(data));
    const cold = data.people.filter((p) => !p.fields.loyalty);
    if (cold.length) main.append(el("p", { class: "sub" }, `Без оценки лояльности: ${cold.length}. Открой человека и поставь оценку — так сеть точнее.`));
    return;
  }
  const { items } = await api("GET", "/api/items?kind=person&order=title&limit=2000");
  const active = items.filter((p) => !p.closed).sort((a, b) => (b.fields.loyalty || 0) - (a.fields.loyalty || 0) || a.title.localeCompare(b.title));
  main.append(group("Контакты", active, { always: true, empty: "Пока никого. Кира заводит людей сама, когда ты о них рассказываешь." }));
}

export async function changes(main) {
  main.append(el("h1", { class: "view-title" }, "История"), el("p", { class: "view-sub" }, "Что менялось за последние 14 дней."));
  const { changes: list } = await api("GET", "/api/changes?days=14");
  if (!list.length) { main.append(el("p", { class: "empty" }, "Изменений пока нет.")); return; }
  main.append(el("ul", { class: "feed" }, list.map((c) => el("li", {},
    el("div", { class: "when" }, humanDue(c.at_local)),
    el("div", { class: "what" },
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); isCore(c.kind) ? navigate(`/o/${c.id}`) : hooks.openItem(c.id); } }, c.title),
      el("div", { class: "detail" }, `${T(c.kind).label}: `, describeHistory(c, c.kind), ` · ${SOURCE[c.source] || c.source}`),
    ),
  ))));
}

export async function assistant(main) {
  main.append(
    el("h1", { class: "view-title" }, "Ассистент"),
    el("p", { class: "view-sub" }, "То же, что в Telegram: пиши дела, мысли, что сделал, что мешает — разложу по проектам и миссиям."),
  );
  const chat = el("div", { class: "chat", "aria-live": "polite" });
  const input = el("textarea", { placeholder: "Например: позвонил Петру, договорились о встрече в четверг — запиши в миссию по Альфа-Строй", rows: 2, "aria-label": "Сообщение" });
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
        if (r.tools?.some((t) => /create|update|delete|restore/.test(t.tool))) hooks.loadTree();
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

export async function settings(main) {
  main.append(el("h1", { class: "view-title" }, "Настройки"));
  const bot = await api("GET", "/api/bot");
  const time = el("input", { type: "time", value: bot.morning_time === "off" ? "" : bot.morning_time, "aria-label": "Время утреннего плана" });
  main.append(el("div", { class: "settings" },
    el("section", {},
      el("h2", { class: "group-title" }, "Telegram-бот"),
      bot.owner
        ? el("p", {}, `Привязан к ${bot.owner.name}${bot.owner.username ? " (@" + bot.owner.username + ")" : ""} с ${isoToLocal(bot.owner.since)}.`)
        : el("p", {}, "Ещё не привязан. Пришли боту пароль от сайта обычным сообщением."),
      bot.owner ? el("button", { class: "btn danger", onclick: () => attempt(async () => {
        if (!confirm("Отвязать бота? Чтобы привязать снова, нужно будет прислать ему пароль.")) return;
        await api("PATCH", "/api/bot", { unlink_owner: true });
        toast("Бот отвязан");
        hooks.render();
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
      el("button", { class: "btn", onclick: async () => { await api("POST", "/api/logout"); hooks.showLogin(); } }, "Выйти")),
  ));
}

