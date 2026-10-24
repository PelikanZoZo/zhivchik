// Веб-интерфейс Киры. Без сборки и библиотек: модули в js/, общение с сервером через /api.
import { $, el, api, state, hooks, navigate } from "./js/core.js";
import { openItem, closeDrawer } from "./js/item.js";
import { objectView } from "./js/object.js";
import { today, inbox, tasks, coreList, people, changes, assistant, settings } from "./js/views.js";
import { jobsView, openJobDrawer } from "./js/jobs.js";
import { storageView, archiveView, catalogView } from "./js/storage.js";

hooks.openItem = openItem;
hooks.openJob = openJobDrawer;
hooks.closeDrawer = closeDrawer;
hooks.showLogin = showLogin;
hooks.render = render;
hooks.loadTree = loadTree;

const ROUTES = {
  today: today, inbox, tasks,
  tracks: (m) => coreList(m, { kind: "track" }),
  projects: (m) => coreList(m, { kind: "project" }),
  missions: (m) => coreList(m, { kind: "mission" }),
  people, changes, assistant, settings, jobs: jobsView, storage: storageView, archive: archiveView, catalog: catalogView,
};

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
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='/']");
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || a.getAttribute("href").startsWith("/api/")) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", render);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (state.selected || state.selectedJob)) closeDrawer();
});

function route() {
  const p = location.pathname;
  const m = p.match(/^\/o\/(\d+)/);
  if (m) return { view: "object", id: +m[1] };
  const v = p.replace(/^\/|\/$/g, "") || "today";
  return { view: ROUTES[v] ? v : "today" };
}

async function render() {
  const r = route();
  state.view = r;
  document.querySelectorAll(".side a").forEach((a) => {
    const active = (a.dataset.view && a.dataset.view === r.view) || (r.view === "object" && +a.dataset.id === r.id);
    a.classList.toggle("active", !!active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const main = $("#main");
  main.replaceChildren();
  try {
    if (r.view === "object") await objectView(main, r);
    else await ROUTES[r.view](main, r);
  } catch (e) {
    if (e.message !== "Нужно войти") main.append(el("p", { class: "empty" }, e.message));
  }
}

// ---------- боковое меню: треки и проекты ----------
async function loadTree() {
  const { items } = await api("GET", "/api/items?kinds=track,project&open=1&order=position&limit=300");
  state.tree = items;
  const tracks = items.filter((i) => i.kind === "track");
  const projects = items.filter((i) => i.kind === "project");
  const link = (i, cls = "") => el("a", { href: `/o/${i.id}`, "data-id": i.id, class: cls }, el("span", {}, i.title));
  const box = $("#tree");
  box.replaceChildren(
    ...tracks.map((t) => [link(t, "tree-track"), ...projects.filter((p) => p.parent_id === t.id).map((p) => link(p, "tree-sub"))]).flat(),
    ...projects.filter((p) => !p.parent_id || !tracks.some((t) => t.id === p.parent_id)).map((p) => link(p)),
  );
  if (!items.length) box.append(el("p", { class: "empty side-empty" }, "Пока нет"));
  render.markActive?.();
}

// ---------- запуск ----------
async function boot() {
  const me = await api("GET", "/api/me");
  if (!me.loggedIn) return showLogin();
  state.tz = me.tz || state.tz;
  state.schema = await api("GET", "/api/schema");
  $("#login").hidden = true;
  $("#app").hidden = false;
  await loadTree().catch(() => {});
  await render();
}

boot().catch(() => showLogin());
