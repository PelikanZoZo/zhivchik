// Личный чат с DeepSeek — без логирования. Переписка хранится только в этой вкладке (в памяти страницы):
// на сервере её нет, в журнал не пишется, Кира её не видит. Перезагрузка страницы или «Новый чат» — всё стирается.
import { el, toast } from "./core.js";

const chat = { messages: [], model: "flash", system: "", temperature: 0.7, busy: false, ctrl: null };

window.addEventListener("beforeunload", (e) => {
  if (chat.messages.length) { e.preventDefault(); e.returnValue = ""; }
});

export async function privateChatView(main) {
  main.classList.add("pc-main");
  const list = el("div", { class: "pc-list", "aria-live": "polite" });
  const input = el("textarea", { class: "pc-input", rows: 1, placeholder: window.innerWidth < 720 ? "Сообщение…" : "Спроси DeepSeek… (Enter — отправить, Shift+Enter — новая строка)", "aria-label": "Сообщение" });
  const sendBtn = el("button", { class: "btn primary pc-send", type: "submit" }, "Отправить");
  const modelTabs = el("div", { class: "tabs", role: "tablist" }, [["flash", "Быстрая"], ["pro", "Умная"]].map(([k, t]) => el("button", {
    type: "button", class: "tab" + (chat.model === k ? " on" : ""), role: "tab", "aria-selected": chat.model === k,
    title: k === "pro" ? "Рассуждает дольше, отвечает точнее" : "Быстрые ответы",
    onclick: (e) => { chat.model = k; modelTabs.querySelectorAll(".tab").forEach((b) => { b.classList.toggle("on", b === e.target); b.setAttribute("aria-selected", b === e.target); }); },
  }, t)));
  const sys = el("textarea", { rows: 3, placeholder: "Например: «Ты опытный юрист. Отвечай кратко»", "aria-label": "Системная инструкция" }, chat.system);
  sys.addEventListener("input", () => (chat.system = sys.value));
  const temp = el("input", { type: "range", min: 0, max: 1.5, step: 0.1, value: chat.temperature, "aria-label": "Креативность" });
  const tempVal = el("span", { class: "sub" }, String(chat.temperature));
  temp.addEventListener("input", () => { chat.temperature = +temp.value; tempVal.textContent = temp.value; });
  const settings = el("details", { class: "pc-settings" }, el("summary", {}, "Настройки"),
    el("label", {}, "Инструкция для модели"), sys,
    el("label", {}, "Креативность ", tempVal), temp);

  main.append(
    el("div", { class: "pc-head" },
      el("div", {}, el("h1", { class: "view-title" }, "DeepSeek"),
        el("p", { class: "pc-note" }, "🔒 Без логирования: переписка не сохраняется на сервере и не пишется в журнал. Живёт только в этой вкладке — закроешь или нажмёшь «Новый чат», и её нет.")),
      el("div", { class: "pc-tools" }, modelTabs, el("button", { class: "btn", type: "button", onclick: () => {
        if (chat.busy) chat.ctrl?.abort();
        if (chat.messages.length && !window.confirm("Начать новый чат? Текущий исчезнет без следа.")) return;
        chat.messages = [];
        paint();
        input.focus();
      } }, "Новый чат"))),
    settings,
    list,
    el("form", { class: "pc-composer", onsubmit: (e) => { e.preventDefault(); if (chat.busy) { chat.ctrl?.abort(); return; } submit(); } }, input, sendBtn),
  );

  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 260) + "px"; };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!chat.busy) submit(); }
  });

  function paint() {
    list.replaceChildren(...(chat.messages.length ? chat.messages.map((m, i) => bubble(m, i)) : [el("div", { class: "pc-empty" },
      el("p", {}, "О чём поговорим?"),
      el("p", { class: "sub" }, "Это отдельный чат с DeepSeek — не Кира: он не видит твои задачи и ничего не помнит после закрытия вкладки."))]));
    list.scrollTop = list.scrollHeight;
  }

  function bubble(m, i) {
    if (m.role === "user") return el("div", { class: "pc-msg user" }, el("div", { class: "pc-text plain" }, m.content));
    const last = i === chat.messages.length - 1;
    const body = el("div", { class: "pc-text md" });
    body.innerHTML = renderMd(m.content || "");
    enhanceCode(body);
    return el("div", { class: "pc-msg bot" + (m.error ? " error" : "") },
      m.reasoning ? el("details", { class: "pc-reason", open: m.pending && !m.content }, el("summary", {}, m.pending && !m.content ? "Размышляет…" : "Ход рассуждений"), el("div", { class: "pc-reason-text" }, m.reasoning)) : "",
      m.pending && !m.content && !m.reasoning ? el("div", { class: "pc-typing", "aria-label": "Печатает" }, el("span"), el("span"), el("span")) : body,
      !m.pending ? el("div", { class: "pc-actions" },
        el("button", { class: "linklike", type: "button", onclick: () => copy(m.content) }, "Копировать"),
        last && !chat.busy ? el("button", { class: "linklike", type: "button", onclick: () => regenerate() }, "Ответить заново") : "",
        m.meta ? el("span", { class: "sub" }, m.meta) : "") : "");
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autosize();
    chat.messages.push({ role: "user", content: text });
    await ask();
  }

  async function regenerate() {
    if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
    await ask();
  }

  async function ask() {
    const reply = { role: "assistant", content: "", reasoning: "", pending: true };
    const history = chat.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    chat.messages.push(reply);
    chat.busy = true;
    chat.ctrl = new AbortController();
    sendBtn.textContent = "Стоп";
    sendBtn.classList.add("stop");
    paint();
    let frame = null;
    const repaint = () => { if (!frame) frame = requestAnimationFrame(() => { frame = null; const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120; const node = list.lastElementChild; node?.replaceWith(bubble(reply, chat.messages.length - 1)); if (nearBottom) list.scrollTop = list.scrollHeight; }); };
    try {
      const res = await fetch("/api/private-chat", {
        method: "POST", credentials: "same-origin", signal: chat.ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model: chat.model, system: chat.system, temperature: chat.temperature }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Ошибка ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.error) throw new Error(ev.error);
          if (ev.done) {
            const u = ev.usage;
            reply.meta = [ev.model, u ? `${u.prompt_tokens}+${u.completion_tokens} ток.` : "", ev.finish === "length" ? "ответ обрезан по длине" : ""].filter(Boolean).join(" · ");
            continue;
          }
          reply.content += ev.content || "";
          reply.reasoning += ev.reasoning || "";
          repaint();
        }
      }
    } catch (e) {
      if (e.name === "AbortError") reply.meta = "остановлено";
      else { reply.error = true; reply.content = (reply.content ? reply.content + "\n\n" : "") + `⚠️ ${e.message}`; }
    } finally {
      reply.pending = false;
      chat.busy = false;
      chat.ctrl = null;
      sendBtn.textContent = "Отправить";
      sendBtn.classList.remove("stop");
      if (frame) cancelAnimationFrame(frame);
      paint();
      input.focus();
    }
  }

  paint();
  input.focus();
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Скопировано"), () => toast("Не получилось скопировать", true));
}

function enhanceCode(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const btn = el("button", { class: "pc-copy", type: "button" }, "Копировать");
    btn.addEventListener("click", () => copy(pre.querySelector("code")?.textContent || ""));
    pre.prepend(btn);
  }
}

// ---------- Markdown → безопасный HTML (сначала всё экранируется) ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${esc(codes[+i])}</code>`);
}

export function renderMd(src) {
  const out = [];
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[1] ? ` data-lang="${esc(fence[1])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="pc-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMd(q.join("\n"))}</blockquote>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) { items.push(m[3]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += "\n" + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${t.split("\n").map(inline).join("<br>")}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join("");
}
