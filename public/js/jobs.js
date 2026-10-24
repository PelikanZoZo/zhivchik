// Раздел «Задания Киры»: что она сделает сама, без команды.
import { $, el, api, toast, attempt, refresh, state, hooks, humanDue, localToday, SOURCE } from "./core.js";

// ---------- задания Киры ----------
const WEEKDAYS = [[1, "пн"], [2, "вт"], [3, "ср"], [4, "чт"], [5, "пт"], [6, "сб"], [0, "вс"]];
const EXEC_CLASS = { failed: "bad", retrying: "warn", running: "run", succeeded: "ok", skipped: "", scheduled: "" };

// Конструктор расписания: разово / каждый день / по дням недели / раз в месяц / интервал / своё (cron)
export function scheduleEditor(job) {
  const init = { type: "once", date: localToday(), time: "09:00", days: [1], dom: 1, every: 60, unit: "min", cron: "0 9 * * *", until: job?.until || "" };
  if (job) {
    if (job.schedule === "once" && job.run_at) [init.date, init.time] = job.run_at.split(" ");
    else if (job.schedule === "interval") {
      init.type = "interval";
      if (job.every_minutes % 60 === 0) { init.every = job.every_minutes / 60; init.unit = "hour"; } else init.every = job.every_minutes;
    } else if (job.schedule === "cron") {
      init.cron = job.cron;
      const [mi, ho, dom, mon, dow] = job.cron.split(" ");
      const simple = /^\d+$/.test(mi) && /^\d+$/.test(ho) && mon === "*";
      if (simple) init.time = `${ho.padStart(2, "0")}:${mi.padStart(2, "0")}`;
      if (simple && dom === "*" && dow === "*") init.type = "daily";
      else if (simple && dom === "*" && /^[\d,]+$/.test(dow)) { init.type = "weekly"; init.days = dow.split(",").map(Number).map((d) => (d === 7 ? 0 : d)); }
      else if (simple && dom === "*" && dow === "1-5") { init.type = "weekly"; init.days = [1, 2, 3, 4, 5]; }
      else if (simple && /^\d+$/.test(dom) && dow === "*") { init.type = "monthly"; init.dom = +dom; }
      else init.type = "cron";
    }
  }
  const type = el("select", { "aria-label": "Как часто" },
    [["once", "Разово"], ["daily", "Каждый день"], ["weekly", "По дням недели"], ["monthly", "Раз в месяц"], ["interval", "С интервалом"], ["cron", "Своё (cron)"]]
      .map(([v, t]) => el("option", { value: v, selected: v === init.type }, t)));
  const date = el("input", { type: "date", value: init.date, "aria-label": "Дата" });
  const time = el("input", { type: "time", value: init.time, "aria-label": "Время" });
  const days = el("div", { class: "days" }, WEEKDAYS.map(([d, t]) => el("label", { class: "day" },
    el("input", { type: "checkbox", value: d, checked: init.days.includes(d) }), t)));
  const dom = el("input", { type: "number", min: 1, max: 31, value: init.dom, "aria-label": "Число месяца", style: "width:80px" });
  const every = el("input", { type: "number", min: 1, value: init.every, "aria-label": "Интервал", style: "width:90px" });
  const unit = el("select", { "aria-label": "Единица" }, el("option", { value: "min", selected: init.unit === "min" }, "минут"), el("option", { value: "hour", selected: init.unit === "hour" }, "часов"));
  const cron = el("input", { type: "text", value: init.cron, placeholder: "минута час день месяц день_недели", "aria-label": "cron" });
  const until = el("input", { type: "date", value: init.until, "aria-label": "До даты" });
  const row = (label, ...kids) => el("div", { class: "sched-row" }, el("span", { class: "sched-label" }, label), ...kids);
  const box = el("div", { class: "sched" });
  const paint = () => {
    const t = type.value;
    box.replaceChildren(
      row("Как часто", type),
      t === "once" ? row("Когда", date, time) : "",
      t === "daily" ? row("Во сколько", time) : "",
      t === "weekly" ? row("Дни", days) : "", t === "weekly" ? row("Во сколько", time) : "",
      t === "monthly" ? row("Число", dom) : "", t === "monthly" ? row("Во сколько", time) : "",
      t === "interval" ? row("Каждые", every, unit) : "",
      t === "cron" ? row("Расписание", cron) : "",
      t !== "once" ? row("До даты", until, el("span", { class: "hint" }, "необязательно")) : "",
    );
  };
  type.addEventListener("change", paint);
  paint();
  box.value = () => {
    const t = type.value;
    const [h, m] = (time.value || "09:00").split(":").map(Number);
    const out = { until: t === "once" ? null : until.value || null };
    if (t === "once") { if (!date.value) throw new Error("Укажи дату"); out.run_at = `${date.value} ${time.value || "09:00"}`; }
    if (t === "daily") out.cron = `${m} ${h} * * *`;
    if (t === "weekly") {
      const ds = [...days.querySelectorAll("input:checked")].map((i) => i.value);
      if (!ds.length) throw new Error("Выбери хотя бы один день");
      out.cron = `${m} ${h} * * ${ds.join(",")}`;
    }
    if (t === "monthly") out.cron = `${m} ${h} ${Math.min(31, Math.max(1, +dom.value || 1))} * *`;
    if (t === "interval") out.every_minutes = (+every.value || 1) * (unit.value === "hour" ? 60 : 1);
    if (t === "cron") out.cron = cron.value.trim();
    return out;
  };
  return box;
}

// Выбор связанных задач и проектов
export async function linksEditor(initial = []) {
  const { items } = await api("GET", "/api/items?open=1&kinds=track,project,mission,task,goal,risk,blocker&order=recent&limit=400");
  const chosen = new Map(initial.map((l) => [l.id, l.title || `#${l.id}`]));
  const listId = "links-" + Math.random().toString(36).slice(2);
  const input = el("input", { type: "text", list: listId, placeholder: "Начни вводить название задачи или проекта", "aria-label": "Связать с" });
  const dl = el("datalist", { id: listId }, items.map((i) => el("option", { value: `#${i.id} ${i.title}` })));
  const chips = el("div", { class: "chips" });
  const paint = () => chips.replaceChildren(...[...chosen].map(([id, title]) => el("span", { class: "chip" }, title,
    el("button", { type: "button", "aria-label": `Убрать ${title}`, onclick: () => { chosen.delete(id); paint(); } }, "×"))));
  input.addEventListener("change", () => {
    const m = input.value.match(/^#(\d+)\s*(.*)$/);
    if (m) { chosen.set(+m[1], m[2] || `#${m[1]}`); input.value = ""; paint(); }
  });
  paint();
  const box = el("div", { class: "links-editor" }, chips, input, dl);
  box.value = () => [...chosen.keys()];
  return box;
}

const cell = (h, cls, ...kids) => el("td", { "data-h": h, class: cls }, el("div", { class: "cell" }, ...kids));

export async function jobsView(main) {
  const filter = new URLSearchParams(location.search).get("status") || "active";
  main.append(
    el("h1", { class: "view-title" }, "Задания Киры"),
    el("p", { class: "view-sub" }, "Что Кира сделает сама, без команды: напомнит, проверит, пришлёт сводку. Можно попросить её в чате или добавить здесь."),
  );
  const tabs = el("div", { class: "tabs", role: "tablist" }, [["active", "Активные"], ["done", "Выполненные"], ["cancelled", "Отменённые"], ["all", "Все"]]
    .map(([v, t]) => el("a", { href: `/jobs${v === "active" ? "" : "?status=" + v}`, class: "tab" + (v === filter ? " on" : ""), role: "tab", "aria-selected": v === filter }, t)));
  const addBtn = el("button", { class: "btn primary", onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector("input").focus(); } }, "Новое задание");
  main.append(el("div", { class: "jobs-bar" }, tabs, addBtn));

  // форма нового задания
  const title = el("input", { type: "text", placeholder: "Что сделать, например: прислать итоги недели", "aria-label": "Что сделать" });
  const instruction = el("textarea", { placeholder: "Подробнее для Киры: что проверить, на что смотреть, что написать (необязательно)", rows: 3, "aria-label": "Инструкция" });
  const action = el("select", { "aria-label": "Как" }, el("option", { value: "remind" }, "Напомнить — прислать этот текст"), el("option", { value: "do" }, "Выполнить — Кира подумает и сделает"));
  const sched = scheduleEditor(null);
  const links = await linksEditor([]);
  const form = el("form", { class: "job-form", hidden: true, onsubmit: (e) => {
    e.preventDefault();
    attempt(async () => {
      if (!title.value.trim()) throw new Error("Напиши, что сделать");
      const remind = action.value === "remind";
      await api("POST", "/api/jobs", { title: title.value.trim(), message: remind ? title.value.trim() : null, instruction: remind ? null : instruction.value.trim() || null, action: action.value, ...sched.value(), links: links.value() });
      toast("Задание поставлено");
      refresh();
    });
  } },
  el("div", { class: "fields" },
    el("label", {}, "Что сделать"), title,
    el("label", {}, "Подробнее"), instruction,
    el("label", {}, "Как"), action,
    el("label", {}, "Когда"), sched,
    el("label", {}, "Связано с"), links),
  el("div", { class: "drawer-actions" }, el("button", { class: "btn primary", type: "submit" }, "Поставить"), el("button", { class: "btn ghost", type: "button", onclick: () => (form.hidden = true) }, "Отмена")));
  main.append(form);

  const { jobs } = await api("GET", `/api/jobs?status=${filter}`);
  if (!jobs.length) { main.append(el("p", { class: "empty" }, filter === "active" ? "Активных заданий нет. Скажи Кире, например: «каждую пятницу в 18:00 присылай итоги недели»." : "Пусто.")); return; }
  main.append(el("div", { class: "table-wrap" }, el("table", { class: "jobs" },
    el("thead", {}, el("tr", {}, ["№", "Создано", "Кем", "Когда", "Что сделать", "Связано", "Исполнение", "Статус"].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, jobs.map((j) => el("tr", { class: (state.selectedJob === j.id ? "selected " : "") + (j.status !== "active" ? "closed" : ""), "data-id": j.id, tabindex: 0,
      onclick: () => openJobDrawer(j.id), onkeydown: (e) => { if (e.key === "Enter") openJobDrawer(j.id); } },
      cell("№", "num", j.id),
      cell("Создано", null, humanDue(j.created)),
      cell("Кем", null, j.created_by_text),
      cell("Когда", null, el("div", {}, j.schedule_text), j.next_run && j.status === "active" ? el("div", { class: "sub" }, "следующий: " + humanDue(j.next_run)) : ""),
      cell("Что сделать", "what", el("div", { class: "jt" }, j.title), el("div", { class: "sub" }, j.action_text)),
      cell("Связано", null, j.links.length ? j.links.map((l) => el("div", { class: "sub" }, l.title || `#${l.id}`)) : el("span", { class: "sub" }, "—")),
      cell("Исполнение", null, el("span", { class: "badge " + (EXEC_CLASS[j.exec_status] || "") }, j.exec_status_text), j.last_run ? el("div", { class: "sub" }, humanDue(j.last_run)) : ""),
      cell("Статус", null, j.status_text),
    ))),
  )));
}

export async function openJobDrawer(id, { keepScroll = false } = {}) {
  const d = $("#drawer");
  const y = d.scrollTop;
  let data;
  try { data = await api("GET", `/api/jobs/${id}`); } catch (e) { toast(e.message, true); return; }
  const { job, runs, history } = data;
  state.selected = null;
  state.selectedJob = id;
  document.querySelectorAll("table.jobs tr[data-id]").forEach((r) => r.classList.toggle("selected", +r.dataset.id === id));
  $("#app").classList.add("with-drawer");
  d.hidden = false;
  const save = (patch, note) => attempt(async () => { await api("PATCH", `/api/jobs/${id}`, patch); if (note) toast(note); refresh(); });

  const title = el("textarea", { class: "title-input", rows: 1, "aria-label": "Что сделать", disabled: job.system }, job.title);
  title.addEventListener("change", () => title.value.trim() && save({ title: title.value.trim() }));
  const instruction = job.action === "remind"
    ? el("textarea", { placeholder: "Текст, который ты получишь", "aria-label": "Текст напоминания", rows: 2 }, job.message || job.title)
    : el("textarea", { placeholder: "Инструкция для Киры", "aria-label": "Инструкция", disabled: job.system }, job.instruction || "");
  instruction.addEventListener("change", () => save(job.action === "remind" ? { message: instruction.value || null } : { instruction: instruction.value || null }));
  const action = el("select", { disabled: job.system, onchange: () => save({ action: action.value }) },
    el("option", { value: "remind", selected: job.action === "remind" }, "Напомнить"), el("option", { value: "do", selected: job.action === "do" }, "Выполнить"));
  const sched = scheduleEditor(job);
  const links = job.system ? null : await linksEditor(job.links);

  d.replaceChildren(...[
    el("div", { class: "drawer-top" }, el("span", {}, `Задание №${job.id}${job.system ? " · системное" : ""}`),
      el("button", { class: "icon-btn", "aria-label": "Закрыть", onclick: () => hooks.closeDrawer() }, "×")),
    title,
    el("div", { class: "fields" },
      el("label", {}, "Статус"), el("div", {}, job.status_text),
      el("label", {}, "Исполнение"), el("div", {}, el("span", { class: "badge " + (EXEC_CLASS[job.exec_status] || "") }, job.exec_status_text), job.last_run ? ` · ${humanDue(job.last_run)}` : ""),
      el("label", {}, "Следующий раз"), el("div", {}, job.next_run ? humanDue(job.next_run) : "—"),
      el("label", {}, "Расписание"), el("div", {}, job.schedule_text),
      el("label", {}, "Создано"), el("div", {}, `${humanDue(job.created)} · ${job.created_by_text}`),
      el("label", {}, "Запусков"), el("div", {}, job.run_count),
      el("label", {}, "Как"), action),
    instruction,
    el("h3", {}, "Изменить расписание"),
    sched,
    el("div", { class: "drawer-actions" }, el("button", { class: "btn", onclick: () => attempt(async () => { await api("PATCH", `/api/jobs/${id}`, sched.value()); toast("Расписание изменено"); refresh(); }) }, "Сохранить расписание")),
    links ? [el("h3", {}, "Связано с"), links, el("div", { class: "drawer-actions" }, el("button", { class: "btn", onclick: () => save({ links: links.value() }, "Связи сохранены") }, "Сохранить связи"))] : "",
    job.last_result ? [el("h3", {}, "Итог последнего запуска"), el("p", { class: "result" }, job.last_result)] : "",
    el("div", { class: "drawer-actions" },
      job.status === "active" ? el("button", { class: "btn primary", onclick: (e) => attempt(async () => {
        e.target.disabled = true; e.target.textContent = "Выполняю…";
        try { const r = await api("POST", `/api/jobs/${id}/run`); toast(r.result.status === "succeeded" ? "Выполнено" : `Итог: ${r.result.status}`); refresh(); }
        finally { e.target.disabled = false; e.target.textContent = "Выполнить сейчас"; }
      }) }, "Выполнить сейчас") : "",
      job.status === "active" && !job.system ? el("button", { class: "btn", onclick: () => save({ status: "done" }, "Отмечено выполненным") }, "Отметить выполненным") : "",
      job.status === "active" ? el("button", { class: "btn danger", onclick: () => save({ status: "cancelled" }, "Задание отменено") }, "Отменить")
        : el("button", { class: "btn", onclick: () => save({ status: "active" }, "Задание снова активно") }, "Вернуть в работу")),
    el("h3", {}, "Запуски"),
    runs.length ? el("ul", { class: "timeline" }, runs.map((r) => el("li", {},
      el("div", { class: "when" }, `${humanDue(r.started)} · `, el("span", { class: "badge " + (EXEC_CLASS[r.status] || "") }, r.status_text),
        r.planned && r.planned !== r.started ? ` · по плану ${humanDue(r.planned)}` : ""),
      r.result ? el("div", { class: "what" }, r.result) : "",
      r.meta?.tools?.length ? el("div", { class: "when" }, "действия: " + r.meta.tools.map((t) => t.tool).join(", ")) : ""))) : el("p", { class: "empty" }, "Ещё не запускалось."),
    el("h3", {}, "История изменений"),
    el("ul", { class: "timeline" }, history.map((h) => el("li", {},
      el("div", { class: "when" }, `${humanDue(h.at_local)} · ${SOURCE[h.source] || h.source}`),
      el("div", { class: "what" }, h.action === "create" ? "Создано" : h.action === "run" ? "Запуск" : describeJobDiff(h.changes))))),
  ].flat(Infinity).filter(Boolean));
  title.style.height = "auto";
  title.style.height = title.scrollHeight + "px";
  if (keepScroll) d.scrollTop = y;
}

function describeJobDiff(diff) {
  if (!diff) return "Изменено";
  const names = { title: "название", message: "текст напоминания", instruction: "инструкция", action: "способ", schedule: "тип расписания", run_at: "время", cron: "расписание", interval_min: "интервал", until_at: "срок окончания", max_runs: "число запусков", links: "связи", status: "статус", next_run_at: null };
  const st = { active: "активно", done: "выполнено", cancelled: "отменено" };
  return Object.entries(diff).filter(([f]) => names[f] !== null).map(([f, [a, b]]) =>
    f === "status" ? `статус: ${st[a] || a} → ${st[b] || b}` : f === "cron" ? `расписание: ${b}` : names[f] || f).join("; ") || "Изменено";
}

