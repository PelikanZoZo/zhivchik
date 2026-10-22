// Интерфейс. Если рядом есть сервер — показывает его живой мир.
// Если сервера нет (статичный хостинг, превью) — считает мир сам, тем же кодом.

import { World, SPECIES, RULES, TPS, W, H } from "./sim/world.js";
import { SIGNALS, SENSOR } from "./sim/sensors.js";

const $ = (id) => document.getElementById(id);
const cv = $("dish"), ctx = cv.getContext("2d");
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

let mode = null;          // "server" | "local"
let local = null;         // World в локальном режиме
let view = null, prevView = null, viewAt = 0;
const pollMs = 150;
let details = null;
let selected = null;

// ---------- время ----------
const clock = (ticks) => {
  const s = Math.max(0, Math.round(ticks / TPS));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const minutes = (ticks) => (ticks == null ? "—" : (ticks / TPS / 60).toFixed(ticks < 600 * TPS ? 1 : 0));

// ---------- данные ----------
async function detect() {
  try {
    const r = await fetch("api/state", { cache: "no-store" });
    const j = await r.json();
    if (j.mode === "server") { mode = "server"; setView(j); return; }
  } catch {}
  mode = "local";
  local = new World();
  for (let i = 0; i < 20 * TPS; i++) local.step(); // 20 секунд прожитой жизни для начала
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
  try { const r = await fetch("api/details", { cache: "no-store" }); if (r.ok) { details = await r.json(); $("key-row").hidden = !details.locked; } } catch {}
  setTimeout(pollDetails, 1000);
}

async function act(type, p = {}) {
  $("error").textContent = "";
  if (mode === "local") {
    try { local.action(type, p); } catch (e) { $("error").textContent = e.message; return false; }
    return true;
  }
  let key = "";
  try { key = localStorage.getItem("zhivchik-key") || ""; } catch {}
  key = $("key").value || key;
  const r = await fetch("api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, key, ...p }) }).catch(() => null);
  if (!r || !r.ok) {
    const j = r ? await r.json().catch(() => ({})) : {};
    $("error").textContent = j.error || "Сервер не ответил. Попробуй ещё раз.";
    if (r?.status === 403) $("key-row").hidden = false;
    return false;
  }
  try { if ($("key").value) localStorage.setItem("zhivchik-key", $("key").value); } catch {}
  return true;
}

// ---------- рисование ----------
function lerped(list, prevList) {
  if (!prevList || mode === "local") return list;
  const k = Math.min(1, (performance.now() - viewAt) / pollMs);
  const prev = new Map(prevList.map((c) => [c.id, c]));
  return list.map((c) => {
    const p = prev.get(c.id);
    if (!p || Math.hypot(p.x - c.x, p.y - c.y) > 40) return c;
    const da = Math.atan2(Math.sin(c.a - p.a), Math.cos(c.a - p.a));
    return { ...c, x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k, a: p.a + da * k };
  });
}

const scaleColor = (v) => `hsl(${Math.round((v / 100) * 120)}, 60%, 46%)`; // 0 — красный, 100 — зелёный

function draw() {
  const v = view, t = performance.now() / 1000;
  ctx.fillStyle = "#0b140f"; ctx.fillRect(0, 0, W, H);
  // лёгкая синяя дымка влажности
  if (v.humidity > 1) { ctx.fillStyle = `rgba(70,130,220,${(v.humidity / 100) * 0.12})`; ctx.fillRect(0, 0, W, H); }

  // плесень: синие колонии, отмирающие — темнее
  for (const [x, y, bio, dying] of v.molds) {
    const r = 4 + bio / 5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
    g.addColorStop(0, dying ? "rgba(70,95,140,.9)" : "rgba(90,150,240,.95)");
    g.addColorStop(1, "rgba(60,110,200,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dying ? "#4a6187" : "#6aa6f5";
    for (let i = 0; i < 5; i++) {
      const ang = i * 1.26 + x, rr = r * 0.55;
      ctx.beginPath(); ctx.arc(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, Math.max(1.5, r * 0.35), 0, Math.PI * 2); ctx.fill();
    }
  }

  // агенты
  const agents = lerped(v.agents, prevView?.agents);
  for (const c of agents) {
    const col = SPECIES[c.species].color;
    ctx.strokeStyle = col + "40"; ctx.lineWidth = 2; ctx.beginPath();
    c.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(c.x, c.y); ctx.stroke();
  }
  // близость: тонкая линия между агентами, которые рядом
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 45) {
        ctx.strokeStyle = "rgba(255,190,210,.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  for (const c of agents) {
    const col = SPECIES[c.species].color;
    const r = 9 + c.strength / 25, pulse = 1 + Math.sin(t * 4 + c.id) * 0.05;
    if (c.fleeing) { ctx.fillStyle = "rgba(255,80,80,.18)"; ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 0.4 + 0.6 * (c.health / 100);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, r * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    // кольцо энергии
    ctx.strokeStyle = scaleColor(c.energy); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(c.x, c.y, r + 4, -Math.PI / 2, -Math.PI / 2 + (c.energy / 100) * Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#0b140f"; ctx.beginPath(); ctx.arc(c.x + Math.cos(c.a) * r * 0.5, c.y + Math.sin(c.a) * r * 0.5, 2.4, 0, Math.PI * 2); ctx.fill();
    if (c.id === selected) {
      ctx.strokeStyle = "#e3ece5"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c.x, c.y, r + 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#e3ece5"; ctx.font = "12px JetBrains Mono, monospace"; ctx.fillText(c.name, c.x + r + 12, c.y - r - 4);
    }
  }

  // хищники: фиолетовые клинья
  for (const p of lerped(v.predators, prevView?.predators)) {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
    ctx.globalAlpha = p.stunned ? 0.5 + 0.5 * Math.abs(Math.sin(t * 12)) : p.leaving ? 0.55 : 1;
    ctx.fillStyle = "#9b7cf0"; ctx.strokeStyle = "#d9ccff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, 10); ctx.lineTo(-5, 0); ctx.lineTo(-10, -10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(217,204,255,.6)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 20, -Math.PI / 2, -Math.PI / 2 + (p.hp / 100) * Math.PI * 2); ctx.stroke();
  }
}

// ---------- панели ----------
function renderTop() {
  const d = details?.species || {};
  $("species").innerHTML = Object.entries(SPECIES).map(([sp, s]) => {
    const st = d[sp] || {};
    const members = view.agents.filter((a) => a.species === sp);
    const brain = s.brain === "associative" ? "ассоциации" : "нейросеть";
    return `<article class="card">
      <div class="sp-head"><i style="background:${s.color}"></i>${s.plural}<small>${brain}</small></div>
      <div class="sp-nums">
        <div><b>${members.length}</b><small>живых</small></div>
        <div><b>${st.births ?? 0}</b><small>родилось</small></div>
        <div><b>${st.deaths ?? 0}</b><small>погибло, из них хищн. ${st.eaten ?? 0}</small></div>
        <div><b>${minutes(st.avgLife)}</b><small>средняя жизнь, мин</small></div>
      </div>
      <div class="members">${members.length ? members.map((c) => `<button type="button" data-id="${c.id}" aria-pressed="${c.id === selected}">${esc(c.name)}<span class="mini"><i style="width:${c.energy}%;background:${scaleColor(c.energy)}"></i><i style="width:${c.health}%;background:${scaleColor(c.health)}"></i></span></button>`).join("") : `<span class="empty">никого не осталось</span>`}</div>
    </article>`;
  }).join("");

  $("hum-bar").style.width = view.humidity + "%";
  $("hum-v").textContent = Math.round(view.humidity) + "%";
  $("t-hum").textContent = "через " + clock(view.nextHumidity);
  $("t-birth").textContent = view.nextBirth > 0 ? "через " + clock(view.nextBirth) : "уже можно";
  $("t-pred").textContent = `${view.predatorsInWindow} из ${RULES.predatorMax}` + (view.predators.length ? ` · сейчас в мире: ${view.predators.length}` : "");
}

function scaleRow(name, v, color) {
  return `<div class="scale"><span>${name}</span><div class="track"><i style="width:${v}%;background:${color}"></i></div><code>${v}</code></div>`;
}

function bars(rows, scale) {
  return rows.map((r) => {
    const p = Math.max(-1, Math.min(1, r.v / scale)) * 50;
    return `<div class="pref"><span>${r.name}</span><div class="bar"><i style="left:${p < 0 ? 50 + p : 50}%;width:${Math.abs(p)}%;background:${r.v >= 0 ? "var(--good)" : "var(--bad)"}"></i></div><code>${r.v > 0 ? "+" : ""}${r.v.toFixed(scale < 5 ? 2 : 1)}</code></div>`;
  }).join("");
}

function renderAgent() {
  let c = view.agents.find((x) => x.id === selected);
  if (!c && view.agents.length) { c = view.agents.reduce((a, b) => (b.age > a.age ? b : a)); selected = c.id; }
  if (!c) {
    $("who").textContent = ""; $("scales").innerHTML = `<p class="empty">Агентов нет. Скоро появится новая пара.</p>`;
    $("prefs").innerHTML = ""; $("legend").innerHTML = ""; $("brain-note").textContent = ""; $("agent-meta").textContent = "";
    return;
  }
  const sp = SPECIES[c.species];
  $("who").innerHTML = `<span style="color:${sp.color}">${esc(c.name)}</span>`;
  $("scales").innerHTML =
    scaleRow("Энергия", c.energy, scaleColor(c.energy)) +
    scaleRow("Эмоции", c.emotions, scaleColor(c.emotions)) +
    scaleRow("Сила", c.strength, "var(--warn)") +
    scaleRow("Здоровье", c.health, scaleColor(c.health));
  const state = c.fleeing ? "убегает от хищника · " : c.energy >= RULES.greenEnergy ? "сыт, готов к размножению · " : "";
  $("agent-meta").textContent = `${state}возраст ${clock(c.age)} · поколение ${c.gen}` + (c.parents?.length ? ` · родители: ${c.parents.join(" и ")}` : "");

  const b = details?.brains?.[c.id];
  if (!b) { $("prefs").innerHTML = ""; return; }
  if (b.type === "associative") {
    $("prefs").innerHTML = bars(SIGNALS.map((s) => ({ name: s.name, v: b.values[s.id] })), 30);
    $("legend").innerHTML = "<span>← плохо</span><span>хорошо →</span>";
    $("brain-note").textContent = "Каждое число — ожидание: насколько хороша встреча с этим. После каждого опыта поправляется на разницу между ожиданием и тем, что случилось на самом деле.";
  } else {
    const rows = SIGNALS.map((s) => ({ name: s.name, v: b.influence[SENSOR.diff(s.id)] }));
    const scale = Math.max(0.5, ...rows.map((r) => Math.abs(r.v)));
    $("prefs").innerHTML = bars(rows, scale);
    $("legend").innerHTML = "<span>← поворачивает прочь</span><span>поворачивает к →</span>";
    $("brain-note").textContent = `Связи нейросети: как сильно запах с одной стороны разворачивает её туда или прочь. Родилась с рефлексами «к еде, от хищника», дальше учится на награде. Удивление сейчас: ${(b.surprise ?? 0).toFixed(2)}.`;
  }
}

function renderMode() {
  const v = view;
  $("mode").innerHTML = mode === "server"
    ? `<b>●</b> мир живёт на сервере · возраст мира ${clock(v.tick)}` + (v.catchup ? ` · догоняет пропущенное: ещё ${clock(v.catchup)}` : "")
    : `мир считается в этом браузере · возраст мира ${clock(v.tick)}`;
}

let lastLog = "";
function renderLog() {
  const log = details?.log || [];
  const key = log.map((l) => l.t + l.text).join("|");
  if (key === lastLog) return;
  lastLog = key;
  $("log").innerHTML = log.map((l) => `<li><span class="t">${clock(l.t).padStart(7, " ")}</span>${esc(l.text)}</li>`).join("");
}

// ---------- события ----------
$("species").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) selected = +b.dataset.id; });
cv.addEventListener("click", (e) => {
  const r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
  const hit = view.agents.find((c) => Math.hypot(c.x - x, c.y - y) < 20);
  if (hit) selected = hit.id; else act("mold", { x, y });
});
$("b-hum").onclick = () => act("humidity");
$("b-pred").onclick = () => act("predator");
$("b-reset").onclick = () => { $("confirm").hidden = false; };
$("b-reset-no").onclick = () => { $("confirm").hidden = true; };
$("b-reset-yes").onclick = async () => { $("confirm").hidden = true; if (await act("reset")) selected = null; };
$("speed").oninput = (e) => ($("speed-v").textContent = "×" + e.target.value);

// ---------- цикл ----------
let frame = 0, acc = 0, last = performance.now();
function loop(now) {
  if (mode === "local") {
    // реальное время: 20 тиков в секунду, умноженные на скорость
    acc += Math.min(0.25, (now - last) / 1000) * TPS * +$("speed").value;
    while (acc >= 1) { local.step(); acc--; }
    setView(local.view());
    if (frame % 15 === 0) details = local.details();
  }
  last = now;
  draw();
  if (frame % 6 === 0) { renderTop(); renderAgent(); renderMode(); renderLog(); }
  frame++;
  requestAnimationFrame(loop);
}

await detect();
$("speed-row").hidden = mode !== "local";
if (mode === "server") { pollState(); await pollDetails(); }
else details = local.details();
requestAnimationFrame(loop);
