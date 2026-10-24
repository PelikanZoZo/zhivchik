// Общие помощники интерфейса: элементы, запросы к серверу, даты, состояние, навигация.

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false && kid !== "") n.append(kid.nodeType ? kid : String(kid));
  return n;
};

export const PRIORITY = ["Нет", "Низкий", "Средний", "Высокий"];
export const SOURCE = { web: "сайт", bot: "бот", ai: "ассистент", system: "система", kira: "Кира" };

export const state = {
  tz: "Europe/Moscow",
  schema: null,      // типы объектов с сервера
  tree: [],          // треки и проекты для бокового меню
  selected: null,    // открытая карточка объекта
  selectedJob: null, // открытая карточка задания
  view: null,
};

// Хуки, которые подключает app.js (чтобы модули не зависели друг от друга по кругу)
export const hooks = { render: async () => {}, openItem: async () => {}, openJob: async () => {}, closeDrawer: () => {}, showLogin: () => {}, loadTree: async () => {} };

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: body && !raw ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { hooks.showLogin(); throw new Error("Нужно войти"); }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

export function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), error ? 4500 : 2200);
}

export async function attempt(fn) {
  try { return await fn(); } catch (e) { if (e.message !== "Нужно войти") toast(e.message, true); }
}

// ---------- даты ----------
export function localToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: state.tz }).format(new Date());
}
export function addDays(d, n) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEK = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
export function humanDate(d) {
  const today = localToday();
  if (d === today) return "сегодня";
  if (d === addDays(today, 1)) return "завтра";
  if (d === addDays(today, -1)) return "вчера";
  const x = new Date(d + "T00:00:00Z");
  const sameYear = d.slice(0, 4) === today.slice(0, 4);
  return `${WEEK[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${sameYear ? "" : " " + d.slice(0, 4)}`;
}
export function humanDue(due) {
  if (!due) return "";
  const [d, t] = due.split(" ");
  return humanDate(d) + (t ? ` ${t}` : "");
}
export function isoToLocal(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: state.tz, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

// ---------- навигация ----------
export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  hooks.render();
}

let refreshing = null;
export function refresh() {
  clearTimeout(refreshing);
  refreshing = setTimeout(async () => {
    const y = scrollY;
    await hooks.loadTree().catch(() => {});
    await hooks.render();
    scrollTo(0, y);
    if (state.selected) hooks.openItem(state.selected, { keepScroll: true });
    else if (state.selectedJob) hooks.openJob(state.selectedJob, { keepScroll: true });
  }, 50);
}

// ---------- модель ----------
export const T = (kind) => state.schema?.types[kind] || { label: kind, plural: kind, statuses: {}, closed: [], parents: [] };
export const statusOptions = (kind) => Object.entries(T(kind).statuses);
export const doneStatus = (kind) => ({ task: "done", mission: "done", project: "done", goal: "achieved", blocker: "resolved", risk: "closed", stage: "done", memo: "archived", attachment: "archived", person: "archived", track: "archived" }[kind]);
export const openStatus = (kind) => T(kind).initial || Object.keys(T(kind).statuses)[0];
export const coreLink = (item) => `/o/${item.id}`;
export const isCore = (kind) => ["track", "project", "mission"].includes(kind);

export function fileSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
