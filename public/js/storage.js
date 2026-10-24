// Хранилище файлов и архив переписки с Кирой.
import { $, el, api, toast, attempt, state, hooks, humanDue, fileSize } from "./core.js";

const CHUNK = 4 * 1024 * 1024; // хостинг принимает запросы до ~8 МБ — большие файлы идут кусками
const KIND_ICON = { document: "📄", voice: "🎙", audio: "🎧", photo: "🖼", video: "🎬", other: "📎" };

// Загрузить файл в хранилище (кусками). attachTo — приложить к объекту.
export async function uploadFile(file, { attachTo, onProgress } = {}) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()).replace(/-/g, "");
  const total = Math.max(1, Math.ceil(file.size / CHUNK));
  let r;
  for (let i = 0; i < total; i++) {
    const part = file.slice(i * CHUNK, (i + 1) * CHUNK);
    r = await api("POST", "/api/storage/upload", part, { raw: true, headers: {
      "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Chunk": String(i), "X-Chunks": String(total),
      "X-File-Name": encodeURIComponent(file.name), "X-File-Type": encodeURIComponent(file.type || ""),
      ...(attachTo ? { "X-Attach-To": String(attachTo) } : {}),
    } });
    onProgress?.((i + 1) / total);
  }
  return r;
}

function dur(sec) {
  return sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : "";
}

const cell = (h, cls, ...kids) => el("td", { "data-h": h, class: cls }, el("div", { class: "cell" }, ...kids));

export async function storageView(main) {
  const params = new URLSearchParams(location.search);
  const q = params.get("q") || "";
  const kind = params.get("kind") || "";
  const data = await api("GET", `/api/storage?q=${encodeURIComponent(q)}&kind=${kind}&limit=100`);
  main.append(
    el("h1", { class: "view-title" }, "Хранилище"),
    el("p", { class: "view-sub" }, `Всё, что ты присылал Кире и загружал сюда: документы, голосовые, фото. ${data.total.files} файлов, ${fileSize(data.total.bytes)}. Кира читает документы и расшифровывает голосовые — по ним и ищет.`),
  );

  const search = el("input", { type: "search", value: q, placeholder: "Найти: договор, смета, голосовое про…", "aria-label": "Поиск по хранилищу" });
  const kindSel = el("select", { "aria-label": "Вид" }, el("option", { value: "" }, "Все виды"),
    Object.entries(data.kinds).map(([k, t]) => el("option", { value: k, selected: k === kind }, t)));
  const go = () => {
    const p = new URLSearchParams();
    if (search.value.trim()) p.set("q", search.value.trim());
    if (kindSel.value) p.set("kind", kindSel.value);
    history.replaceState({}, "", "/storage" + (p.toString() ? "?" + p : ""));
    hooks.render();
  };
  kindSel.addEventListener("change", go);
  const input = el("input", { type: "file", multiple: true, class: "visually-hidden", id: "store-in" });
  const upload = async (files) => {
    for (const f of files) {
      if (f.size > 50 * 1024 * 1024) { toast(`${f.name}: больше 50 МБ`, true); continue; }
      toast(`Загружаю ${f.name}…`);
      await attempt(async () => {
        const r = await uploadFile(f, { onProgress: (p) => p < 1 && toast(`Загружаю ${f.name}… ${Math.round(p * 100)}%`) });
        toast(r.duplicate ? `${f.name}: такой файл уже есть` : `${f.name}: сохранено`);
      });
    }
    hooks.render();
  };
  input.addEventListener("change", () => input.files.length && upload([...input.files]));
  main.append(el("form", { class: "quick store-bar", onsubmit: (e) => { e.preventDefault(); go(); } },
    search, kindSel, el("button", { class: "btn", type: "submit" }, "Найти"),
    el("label", { class: "btn primary", for: "store-in" }, "Загрузить"), input));
  const drop = el("label", { class: "dropzone", for: "store-in" }, "Перетащи файлы сюда — до 50 МБ");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); });
  main.append(drop);

  if (!data.files.length) {
    main.append(el("p", { class: "empty" }, q || kind ? "Ничего не нашлось." : "Пока пусто. Перешли Кире документ или голосовое в Telegram — оно появится здесь."));
    return;
  }
  main.append(el("div", { class: "table-wrap" }, el("table", { class: "jobs files" },
    el("thead", {}, el("tr", {}, ["Файл", "Когда", "Размер", "Текст"].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, data.files.map((f) => el("tr", { "data-id": f.id, tabindex: 0, onclick: () => openFile(f.id), onkeydown: (e) => { if (e.key === "Enter") openFile(f.id); } },
      cell("Файл", "what",
        el("div", { class: "jt" }, el("span", { class: "ficon", "aria-hidden": "true" }, KIND_ICON[f.kind] || "📎"), " ", f.name),
        f.summary ? el("div", { class: "sub" }, f.summary) : f.caption ? el("div", { class: "sub" }, f.caption) : "",
        q && f.snippet ? el("div", { class: "sub snip" }, f.snippet) : ""),
      cell("Когда", null, humanDue(f.created), el("div", { class: "sub" }, f.kind_text + (f.duration ? ` · ${dur(f.duration)}` : "") + (f.pages ? ` · ${f.pages} стр.` : ""))),
      cell("Размер", "num", fileSize(f.size)),
      cell("Текст", null, el("span", { class: "badge " + (f.text_status === "ok" ? "ok" : f.text_status === "failed" ? "bad" : "") }, f.text_status_text)),
    ))),
  )));
}

export async function openFile(id) {
  const d = $("#drawer");
  let data;
  try { data = await api("GET", `/api/storage/${id}`); } catch (e) { toast(e.message, true); return; }
  const { file: f, messages } = data;
  state.selected = null;
  state.selectedJob = null;
  document.querySelectorAll("table.files tr[data-id]").forEach((r) => r.classList.toggle("selected", +r.dataset.id === id));
  $("#app").classList.add("with-drawer");
  d.hidden = false;
  const name = el("textarea", { class: "title-input", rows: 1, "aria-label": "Название" }, f.name);
  name.addEventListener("change", () => name.value.trim() && attempt(async () => { await api("PATCH", `/api/storage/${id}`, { name: name.value.trim() }); toast("Переименовано"); hooks.render(); }));
  const src = `/api/storage/${id}/download`;
  const preview = !f.on_disk ? "" : f.kind === "photo" ? el("img", { class: "file-preview", src: src + "?inline=1", alt: f.name })
    : f.kind === "voice" || f.kind === "audio" ? el("audio", { controls: true, preload: "none", src: src + "?inline=1", class: "file-audio" })
    : f.kind === "video" ? el("video", { controls: true, preload: "none", src: src + "?inline=1", class: "file-preview" }) : "";
  d.replaceChildren(...[
    el("div", { class: "drawer-top" }, el("span", {}, `${f.kind_text} №${f.id}`),
      el("button", { class: "icon-btn", "aria-label": "Закрыть", onclick: () => hooks.closeDrawer() }, "×")),
    name,
    preview,
    el("div", { class: "fields" },
      el("label", {}, "Когда"), el("div", {}, humanDue(f.created), f.source === "telegram" ? " · из Telegram" : " · с сайта"),
      el("label", {}, "Размер"), el("div", {}, fileSize(f.size), f.pages ? ` · ${f.pages} стр.` : "", f.duration ? ` · ${dur(f.duration)}` : ""),
      el("label", {}, "Текст"), el("div", {}, f.text_status_text, f.text_note ? el("div", { class: "sub" }, f.text_note) : ""),
      f.caption ? [el("label", {}, "Подпись"), el("div", {}, f.caption)] : "",
      f.keywords ? [el("label", {}, "Ключевые слова"), el("div", { class: "sub" }, f.keywords)] : ""),
    f.summary ? [el("h3", {}, "О чём"), el("p", { class: "result" }, f.summary)] : "",
    el("div", { class: "drawer-actions" },
      f.on_disk ? el("a", { class: "btn primary", href: src }, "Скачать") : "",
      el("button", { class: "btn", onclick: () => attempt(async () => { await api("POST", `/api/storage/${id}/send`); toast("Отправлю в Telegram в течение минуты"); }) }, "Прислать в Telegram"),
      el("button", { class: "btn danger", onclick: () => attempt(async () => {
        await api("DELETE", `/api/storage/${id}`);
        hooks.closeDrawer(); hooks.render();
        toast("Удалено");
      }) }, "Удалить")),
    f.total_chars ? [el("h3", {}, f.kind === "voice" || f.kind === "audio" || f.kind === "video" ? "Расшифровка" : `Текст${f.more ? ` (начало, всего ${f.total_chars.toLocaleString("ru-RU")} знаков)` : ""}`),
      el("pre", { class: "file-text" + (["voice", "audio", "video"].includes(f.kind) ? " spoken" : "") }, f.text)] : "",
    messages.length ? [el("h3", {}, "В переписке"), el("ul", { class: "timeline" }, messages.map((m) => el("li", {},
      el("div", { class: "when" }, `${humanDue(m.at)} · ${m.author === "owner" ? "ты" : "Кира"}`),
      el("div", { class: "what" }, String(m.text || "").slice(0, 400)))))] : "",
  ].flat(Infinity).filter(Boolean));
  name.style.height = "auto";
  name.style.height = name.scrollHeight + "px";
}

// ---------- архив переписки ----------
export async function archiveView(main) {
  const params = new URLSearchParams(location.search);
  const q = params.get("q") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const qs = (extra = "") => `/api/dwh/messages?q=${encodeURIComponent(q)}&from=${from}&to=${to}&limit=100${extra}`;
  const data = await api("GET", qs());
  main.append(
    el("h1", { class: "view-title" }, "Переписка"),
    el("p", { class: "view-sub" }, `Полный архив разговоров с Кирой — Telegram, сайт, её сообщения по заданиям. ${data.stats.messages.toLocaleString("ru-RU")} сообщений${data.stats.first ? `, с ${humanDue(data.stats.first)}` : ""}. Отсюда ничего не стирается.`),
  );
  const search = el("input", { type: "search", value: q, placeholder: "Что искать в переписке", "aria-label": "Поиск по переписке" });
  const f1 = el("input", { type: "date", value: from, "aria-label": "С даты" });
  const f2 = el("input", { type: "date", value: to, "aria-label": "По дату" });
  main.append(el("form", { class: "quick store-bar", onsubmit: (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    if (search.value.trim()) p.set("q", search.value.trim());
    if (f1.value) p.set("from", f1.value);
    if (f2.value) p.set("to", f2.value);
    history.replaceState({}, "", "/archive" + (p.toString() ? "?" + p : ""));
    hooks.render();
  } }, search, f1, f2, el("button", { class: "btn primary", type: "submit" }, "Найти")));

  const box = el("div", { class: "chat archive" });
  const paint = (msgs, atTop) => {
    const nodes = msgs.slice().reverse().map((m) => el("div", { class: `bubble ${m.author === "owner" ? "user" : "assistant"}` },
      el("div", { class: "bubble-meta" }, `${humanDue(m.at)}${m.channel === "web" ? " · сайт" : ""}${m.type === "voice" ? " · 🎙 голосовое" : m.type === "file" ? " · 📎 файл" : m.type === "photo" ? " · 🖼 фото" : m.type === "proactive" ? " · сама" : ""}`),
      m.text || "",
      m.file_id ? el("div", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); openFile(m.file_id); } }, `файл №${m.file_id}`)) : ""));
    if (atTop) box.prepend(...nodes); else box.append(...nodes);
  };
  if (!data.messages.length) { main.append(el("p", { class: "empty" }, "Ничего не нашлось.")); return; }
  let oldest = data.messages[data.messages.length - 1].id;
  const more = el("button", { class: "btn small", onclick: () => attempt(async () => {
    const r = await api("GET", qs(`&before=${oldest}`));
    if (!r.messages.length) { more.remove(); return; }
    oldest = r.messages[r.messages.length - 1].id;
    paint(r.messages, true);
    if (r.messages.length < 100) more.remove();
  }) }, "Показать раньше");
  paint(data.messages, false);
  main.append(data.messages.length >= 100 ? more : "", box);
}
