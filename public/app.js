// Интерфейс. Если рядом есть сервер — показывает его живой мир.
// Если сервера нет (статичный хостинг, превью) — считает мир сам, тем же кодом.

import { World, SPECIES, W, H } from "./sim/world.js";
import { KINDS, SENSOR } from "./sim/sensors.js";

const $ = (id) => document.getElementById(id);
const cv = $("dish"), ctx = cv.getContext("2d");
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const fmt = (n) => (n == null ? "—" : n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "к" : String(n));

let mode = null;          // "server" | "local"
let local = null;         // World в локальном режиме
let view = null, prevView = null, viewAt = 0, pollMs = 150;
let details = null;
let selected = null;      // id выбранного существа
let locked = false;

// ---------- источники данных ----------
async function detect() {
  try {
    const r = await fetch("api/state", { cache: "no-store" });
    const j = await r.json();
    if (j.mode === "server") { mode = "server"; setView(j); return; }
  } catch {}
  mode = "local";
  local = new World();
  for (let i = 0; i < 3000; i++) local.step(); // немного прожитой истории, чтобы было что показать
  setView(local.view());
}

function setView(v) {
  // Ответы могут приходить от разных копий сервера; чуть устаревшую картинку пропускаем
  if (view && v.tick < view.tick && view.tick - v.tick < 400) return;
  prevView = view; view = v; viewAt = performance.now();
}

async function pollState() {
  try { const r = await fetch("api/state", { cache: "no-store" }); if (r.ok) setView(await r.json()); } catch {}
  setTimeout(pollState, pollMs);
}
async function pollDetails() {
  try { const r = await fetch("api/details", { cache: "no-store" }); if (r.ok) { details = await r.json(); setLocked(details.locked); } } catch {}
  setTimeout(pollDetails, 1000);
}

async function act(type, p = {}) {
  $("error").textContent = "";
  if (mode === "local") { local.action(type, p); return true; }
  let key = "";
  try { key = localStorage.getItem("zhivchik-key") || ""; } catch {}
  key = $("key").value || key;
  const r = await fetch("api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, key, ...p }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); $("error").textContent = j.error || "Сервер не ответил. Попробуй ещё раз."; setLocked(true); return false; }
  try { if ($("key").value) localStorage.setItem("zhivchik-key", $("key").value); } catch {}
  return true;
}

function setLocked(v) { locked = !!v; $("key-row").hidden = !locked; }

// ---------- отрисовка мира ----------
function lerpCreatures() {
  if (!prevView || mode === "local") return view.creatures;
  const k = Math.min(1, (performance.now() - viewAt) / pollMs);
  const prev = new Map(prevView.creatures.map((c) => [c.id, c]));
  return view.creatures.map((c) => {
    const p = prev.get(c.id);
    if (!p || Math.hypot(p.x - c.x, p.y - c.y) > 40) return c;
    const da = Math.atan2(Math.sin(c.a - p.a), Math.cos(c.a - p.a));
    return { ...c, x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k, a: p.a + da * k };
  });
}

function draw() {
  const v = view;
  ctx.fillStyle = "#0b140f"; ctx.fillRect(0, 0, W, H);
  for (const z of v.cold) {
    const g = ctx.createRadialGradient(z.x, z.y, 0, z.x, z.y, z.r);
    g.addColorStop(0, "rgba(90,150,220,.38)"); g.addColorStop(1, "rgba(90,150,220,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
  }
  for (const [k, x, y] of v.items) {
    ctx.fillStyle = KIND[k].color; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
  }
  const t = performance.now() / 1000;
  for (const c of lerpCreatures()) {
    const col = SPECIES[c.species].color;
    ctx.strokeStyle = col + "40"; ctx.lineWidth = 2; ctx.beginPath();
    c.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(c.x, c.y); ctx.stroke();
    const r = 6 + c.energy / 30, pulse = 1 + Math.sin(t * 5 + c.id) * 0.06;
    ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, c.energy / 60);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, r * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b140f"; ctx.beginPath(); ctx.arc(c.x + Math.cos(c.a) * r * 0.5, c.y + Math.sin(c.a) * r * 0.5, 2.2, 0, Math.PI * 2); ctx.fill();
    if (c.id === selected) {
      ctx.strokeStyle = "#e3ece5"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c.x, c.y, r + 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#e3ece5"; ctx.font = "12px JetBrains Mono, monospace"; ctx.fillText(c.name, c.x + r + 10, c.y - r - 4);
    }
  }
}

// ---------- панели ----------
function renderSpecies() {
  const d = details?.species || {};
  $("species").innerHTML = Object.entries(SPECIES).map(([sp, s]) => {
    const st = d[sp] || {};
    const members = view.creatures.filter((c) => c.species === sp);
    return `<article class="sp">
      <div class="sp-head"><i style="background:${s.color}"></i>${s.name}</div>
      <div class="sp-nums">
        <div><b>${fmt(st.avgLife)}</b><small>средняя жизнь, тиков</small></div>
        <div><b>${fmt(st.best)}</b><small>рекорд</small></div>
        <div><b>${fmt(st.deaths)}</b><small>смертей</small></div>
        <div><b>${st.topGen ?? "—"}</b><small>поколение</small></div>
      </div>
      <div class="members">${members.map((c) => `<button type="button" data-id="${c.id}" aria-pressed="${c.id === selected}">${c.name}<span class="e"><i style="width:${Math.min(100, (c.energy / 150) * 100)}%"></i></span></button>`).join("")}</div>
    </article>`;
  }).join("");
}

function bars(rows, scale) {
  return rows.map((r) => {
    const p = Math.max(-1, Math.min(1, r.v / scale)) * 50;
    return `<div class="pref"><span><i class="dot" style="background:${r.color}"></i>${r.name}</span><div class="bar"><i style="left:${p < 0 ? 50 + p : 50}%;width:${Math.abs(p)}%;background:${r.v >= 0 ? "var(--good)" : "var(--bad)"}"></i></div><code>${r.v > 0 ? "+" : ""}${r.v.toFixed(scale < 5 ? 2 : 1)}</code></div>`;
  }).join("");
}

function renderBrain() {
  let c = view.creatures.find((x) => x.id === selected);
  if (!c) { c = view.creatures.reduce((a, b) => (b.age > a.age ? b : a), view.creatures[0]); selected = c?.id; }
  if (!c) return;
  $("who").innerHTML = `<span style="color:${SPECIES[c.species].color}">${c.name}</span> · ${SPECIES[c.species].name.toLowerCase()}`;
  $("vitals").innerHTML = `
    <div class="vital"><b>${c.energy}</b><small>энергия</small></div>
    <div class="vital"><b>${fmt(c.age)}</b><small>возраст, тиков</small></div>
    <div class="vital"><b>${c.gen}</b><small>поколение</small></div>`;
  const b = details?.brains?.[c.id];
  if (!b) { $("prefs").innerHTML = ""; return; }
  const kindsRows = (val) => [...KINDS.map((k) => ({ name: k.name, color: k.color, v: val(k.id) }))];
  if (b.type === "associative") {
    $("prefs").innerHTML = bars([...kindsRows((id) => b.values[id]), { name: "холод", color: "#74a6e0", v: b.values.cold }], 35);
    $("legend").innerHTML = "<span>← избегает</span><span>тянется →</span>";
    $("brain-note").textContent = "Каждое число — ожидание: насколько это хорошо. После каждой пробы поправляется на разницу между ожиданием и реальностью.";
  } else {
    const inf = b.influence;
    const rows = [...kindsRows((id) => inf[SENSOR.diff(id)]), { name: "холод", color: "#74a6e0", v: inf[SENSOR.COLD_DIFF] }];
    const scale = Math.max(0.5, ...rows.map((r) => Math.abs(r.v)));
    $("prefs").innerHTML = bars(rows, scale);
    $("legend").innerHTML = "<span>← поворачивает прочь</span><span>поворачивает к →</span>";
    $("brain-note").textContent = "Сети никто не говорил, что такое вещества. Это её собственные связи: как сильно запах с одной стороны разворачивает её туда или прочь. Удивление сейчас: " + (b.surprise ?? 0).toFixed(2) + ".";
  }
}

function renderWorld() {
  const v = view;
  $("law").innerHTML = "Сейчас: " + KINDS.map((k) => `<strong>${k.name}</strong> ${v.effects[k.id] > 0 ? "+" : ""}${v.effects[k.id]}`).join(", ") + (v.winter ? ". Зима." : ".") + (v.famine ? " Голод." : "");
  $("b-winter").setAttribute("aria-pressed", v.winter);
  $("b-famine").setAttribute("aria-pressed", v.famine);
  $("inherit").checked = v.inherit;
  $("mode").innerHTML = mode === "server"
    ? `<b>●</b> мир живёт на сервере · тик ${v.tick.toLocaleString("ru")}` + (v.catchup ? ` · догоняет пропущенное: ещё ${v.catchup.toLocaleString("ru")}` : "")
    : `мир считается в этом браузере · тик ${v.tick.toLocaleString("ru")}`;
}

let lastLog = "";
function renderLog() {
  const log = details?.log || [];
  const key = log.map((l) => l.t + l.text).join("|");
  if (key === lastLog) return;
  lastLog = key;
  $("log").innerHTML = log.map((l) => `<li><span class="t">${String(l.t).padStart(7, " ")}</span>${l.text.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch])}</li>`).join("");
}

// ---------- события ----------
$("species").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) selected = +b.dataset.id; });
cv.addEventListener("click", (e) => {
  const r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
  const hit = view.creatures.find((c) => Math.hypot(c.x - x, c.y - y) < 18);
  if (hit) selected = hit.id; else act("food", { x, y });
});
$("b-flip").onclick = () => act("flip");
$("b-winter").onclick = () => act("winter");
$("b-famine").onclick = () => act("famine");
$("b-reset").onclick = () => { $("confirm").hidden = false; };
$("b-reset-no").onclick = () => { $("confirm").hidden = true; };
$("b-reset-yes").onclick = async () => { $("confirm").hidden = true; if (await act("reset")) selected = null; };
$("inherit").onchange = (e) => act("inherit", { on: e.target.checked });
$("speed").oninput = (e) => ($("speed-v").textContent = "×" + e.target.value);

// ---------- цикл ----------
let frame = 0;
function loop() {
  if (mode === "local") {
    const n = +$("speed").value;
    for (let i = 0; i < n; i++) local.step();
    setView(local.view());
    if (frame % 15 === 0) details = local.details();
  }
  draw();
  if (frame % 6 === 0) { renderSpecies(); renderBrain(); renderWorld(); renderLog(); }
  frame++;
  requestAnimationFrame(loop);
}

await detect();
$("speed-row").hidden = mode !== "local";
if (mode === "server") { pollState(); await pollDetails(); }
else details = local.details();
loop();
