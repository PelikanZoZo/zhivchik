// Интерфейс. Если рядом есть сервер — показывает его живой мир.
// Если сервера нет (статичный хостинг, превью) — считает мир сам, тем же кодом.

import { World, SPECIES, RULES, TPS, W, H, GENES, PREDATOR_GENES } from "./sim/world.js";
import { SIGNALS, SENSOR } from "./sim/sensors.js";

const $ = (id) => document.getElementById(id);
const cv = $("dish"), ctx = cv.getContext("2d");
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

let mode = null;          // "server" | "local"
let local = null;         // World в локальном режиме
let view = null, prevView = null, viewAt = 0;
const pollMs = 250; // как часто страница спрашивает сервер о мире
let details = null;
let selected = null;

// ---------- время мира — в тиках ----------
const nf = new Intl.NumberFormat("ru-RU");
const ticks = (n) => nf.format(Math.max(0, Math.round(n)));
const kticks = (n) => (n == null ? "—" : n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(".", ",") + "к" : ticks(n));
// примерное реальное время при текущей скорости мира
const approx = (n) => {
  const s = Math.round(n / (view?.tps || TPS));
  return s < 90 ? `~${s} с` : s < 5400 ? `~${Math.round(s / 60)} мин` : `~${(s / 3600).toFixed(1).replace(".", ",")} ч`;
};

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
  // дождь: косые капли
  if (v.raining) {
    ctx.strokeStyle = "rgba(160,200,255,.35)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 140; i++) {
      const x = (i * 97 + t * 260) % (W + 60) - 30, y = (i * 53 + t * 620 + (i % 7) * 40) % H;
      ctx.moveTo(x, y); ctx.lineTo(x - 6, y + 14);
    }
    ctx.stroke();
  }

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
  // драка самцов: красная зигзагообразная черта между дерущимися
  for (const c of agents) {
    if (c.brawl == null || c.id > c.brawl) continue;
    const o = agents.find((x) => x.id === c.brawl);
    if (!o) continue;
    ctx.strokeStyle = "rgba(255,70,60,.9)"; ctx.lineWidth = 2.5; ctx.beginPath();
    const n = 6;
    for (let k = 0; k <= n; k++) {
      const x = c.x + (o.x - c.x) * (k / n), y = c.y + (o.y - c.y) * (k / n), off = k % 2 ? 5 : -5;
      const nx = -(o.y - c.y), ny = o.x - c.x, L = Math.hypot(nx, ny) || 1;
      k ? ctx.lineTo(x + (nx / L) * off, y + (ny / L) * off) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  const HALO = { flee: "rgba(255,80,80,.18)", survive: "rgba(255,60,60,.32)", fight: "rgba(255,160,40,.24)", help: "rgba(90,210,230,.22)", forage: "rgba(110,170,250,.16)", court: "rgba(255,150,190,.18)" };
  for (const c of agents) {
    const col = SPECIES[c.species].color;
    const r = (9 + c.health / 25) * (c.phase === "young" ? 0.7 : 1), pulse = c.mode === "sleep" ? 1 : 1 + Math.sin(t * 4 + c.id) * 0.05;
    const g = c.genes || {};
    if (HALO[c.mode]) { ctx.fillStyle = HALO[c.mode]; ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.2, 0, Math.PI * 2); ctx.fill(); }
    // скорость — светлые «струи» позади
    if ((g.speed ?? 0) > 0.2 && c.mode !== "sleep") {
      ctx.strokeStyle = `rgba(230,240,235,${0.15 + g.speed * 0.4})`; ctx.lineWidth = 1.5;
      for (const off of [-0.4, 0, 0.4]) {
        ctx.beginPath(); ctx.moveTo(c.x - Math.cos(c.a + off) * r, c.y - Math.sin(c.a + off) * r);
        ctx.lineTo(c.x - Math.cos(c.a + off) * (r + 6 + g.speed * 10), c.y - Math.sin(c.a + off) * (r + 6 + g.speed * 10)); ctx.stroke();
      }
    }
    // агрессия (сейчас) — шипы
    if (c.aggression > 25) {
      const lv = c.aggression / 100;
      ctx.strokeStyle = "#ffb050"; ctx.lineWidth = 2;
      const n = 6 + Math.round(lv * 6);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r);
        ctx.lineTo(c.x + Math.cos(ang) * (r + 3 + lv * 6), c.y + Math.sin(ang) * (r + 3 + lv * 6)); ctx.stroke();
      }
    }
    // хитрость — агент прозрачнее; сон и отдых — тусклее
    const dim = c.mode === "sleep" ? 0.45 : c.mode === "rest" ? 0.7 : c.mode === "hide" ? 0.35 : 1;
    ctx.globalAlpha = dim * (1 - 0.5 * (g.cunning ?? 0));
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, r * pulse, 0, Math.PI * 2); ctx.fill();
    // старость — седина: светлая серая шапка поверх
    if (c.phase === "old") { ctx.fillStyle = "rgba(225,228,226,.45)"; ctx.beginPath(); ctx.arc(c.x, c.y, r * pulse, Math.PI, 2 * Math.PI); ctx.fill(); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b140f"; ctx.font = "bold 10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(SPECIES[c.species].sex, c.x, c.y + 1); ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    // кольцо силы
    ctx.strokeStyle = scaleColor(c.strength); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(c.x, c.y, r + 4, -Math.PI / 2, -Math.PI / 2 + (c.strength / 100) * Math.PI * 2); ctx.stroke();
    // скука — серое пунктирное кольцо
    if (c.boredom > 60) {
      ctx.strokeStyle = "rgba(170,180,175,.6)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, r + 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    if (c.mode !== "sleep") { ctx.fillStyle = "#0b140f"; ctx.beginPath(); ctx.arc(c.x + Math.cos(c.a) * r * 0.5, c.y + Math.sin(c.a) * r * 0.5, 2.4, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.fillStyle = "#e3ece5"; ctx.font = "11px JetBrains Mono, monospace"; ctx.fillText("z z", c.x + r, c.y - r); }
    if (c.id === selected) {
      ctx.strokeStyle = "#e3ece5"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c.x, c.y, r + 11, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#e3ece5"; ctx.font = "12px JetBrains Mono, monospace"; ctx.fillText(c.name, c.x + r + 14, c.y - r - 4);
    }
  }

  // хищники: клинья; чем сильнее укус, тем краснее; размер — от поколения не зависит
  for (const p of lerped(v.predators, prevView?.predators)) {
    const bite = p.genes?.bite ?? 0.3;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
    ctx.globalAlpha = p.stunned ? 0.5 + 0.5 * Math.abs(Math.sin(t * 12)) : p.leaving ? 0.55 : p.tired ? 0.6 : 1 - 0.4 * (p.weak ?? 0);
    const sc = 1 - 0.25 * (p.weak ?? 0); ctx.scale(sc, sc); // ослабевший хищник «съёживается»
    ctx.fillStyle = `hsl(${265 - bite * 45}, 70%, ${62 - bite * 8}%)`; ctx.strokeStyle = "#d9ccff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, 10); ctx.lineTo(-5, 0); ctx.lineTo(-10, -10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
    // внешнее кольцо — здоровье, внутреннее — выносливость
    ctx.strokeStyle = "rgba(217,204,255,.6)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 20, -Math.PI / 2, -Math.PI / 2 + (p.hp / 100) * Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = p.tired ? "rgba(255,120,120,.8)" : "rgba(255,220,120,.7)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 24, -Math.PI / 2, -Math.PI / 2 + ((p.stamina ?? 100) / 100) * Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#d9ccff"; ctx.font = "11px JetBrains Mono, monospace";
    if (p.tired) ctx.fillText("z", p.x + 16, p.y - 16);
    else if (p.confused) ctx.fillText("?", p.x + 16, p.y - 16);
    else if ((p.weak ?? 0) >= 0.5) ctx.fillText("слаб", p.x + 16, p.y - 16);
    ctx.fillStyle = "rgba(217,204,255,.7)"; ctx.font = "10px JetBrains Mono, monospace"; ctx.fillText("п" + p.gen, p.x - 8, p.y + 34);
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
      <div class="sp-head"><i style="background:${s.color}"></i>${s.plural} ${s.sex}<small>${s.sexName} · ${brain}</small></div>
      <div class="sp-nums">
        <div><b>${members.length}</b><small>живых</small></div>
        <div><b>${st.births ?? 0}</b><small>родилось</small></div>
        <div><b>${st.deaths ?? 0}</b><small>погибло: хищн. ${st.eaten ?? 0}, старость ${st.oldAge ?? 0}${st.fightDeaths ? ", в драках " + st.fightDeaths : ""}</small></div>
        <div><b>${kticks(st.avgLife)}</b><small>средняя жизнь, тиков</small></div>
      </div>
      <div class="members">${members.length ? members.map((c) => `<button type="button" data-id="${c.id}" aria-pressed="${c.id === selected}">${esc(c.name)} ${SPECIES[c.species].sex}${PHASE_MARK[c.phase] ?? ""}<span class="mini"><i style="width:${c.strength}%;background:${scaleColor(c.strength)}"></i><i style="width:${c.health}%;background:${scaleColor(c.health)}"></i></span></button>`).join("") : `<span class="empty">никого не осталось</span>`}</div>
    </article>`;
  }).join("");

  $("hum-bar").style.width = view.humidity + "%";
  $("hum-v").textContent = Math.round(view.humidity) + "%";
  $("t-hum").textContent = `через ${ticks(view.nextHumidity)} тиков`;
  $("t-hum").title = approx(view.nextHumidity);
  $("t-birth").textContent = view.nextBirth > 0 ? `через ${ticks(view.nextBirth)} тиков` : "уже можно";
  $("t-birth").title = view.nextBirth > 0 ? approx(view.nextBirth) : "";
  $("t-rain").textContent = view.raining ? `идёт, ещё ${ticks(view.raining)} тиков` : view.sinceRain == null ? "ещё не было" : `был ${ticks(view.sinceRain)} тиков назад`;
  const pd = details?.predators;
  if (pd) {
    const genes = pd.genes ? PREDATOR_GENES.map((g) => `<span title="${g.name}">${g.name} <b>${pd.genes[g.id].toFixed(2)}</b></span>`).join("") : "";
    $("pred-info").innerHTML = `<div class="timers"><div><dt>Поколение хищников</dt><dd>${pd.gen || "—"}</dd></div><div><dt>Поймали агентов / погибло хищников</dt><dd>${pd.kills} / ${pd.died}</dd></div></div>` + (genes ? `<div class="pgenes">${genes}</div>` : "");
  }
  $("t-pred").textContent = `${view.predatorsInWindow} из ${RULES.predatorMax}` + (view.predators.length ? ` · сейчас в мире: ${view.predators.length}` : "");
}

const PHASE_NAME = { young: "молодой — быстрый, ещё не размножается", mature: "зрелый — сильный, может размножаться", old: "старый — медленнее и слабее, без потомства" };
const PHASE_MARK = { young: " ·мол", old: " ·стар" };

// Шкала жизни: три фазы разными оттенками и отметка «сейчас»
function lifeRow(c) {
  const L = c.lifespan || RULES.lifespan[1];
  const y = (RULES.youthEnd / L) * 100, o = (RULES.oldStart / L) * 100, now = Math.min(100, (c.age / L) * 100);
  return `<div class="scale" title="молодость до ${ticks(RULES.youthEnd)}, зрелость до ${ticks(RULES.oldStart)}, срок ${ticks(L)} тиков"><span>Жизнь</span>
    <div class="track life"><i style="width:${y}%;background:var(--life-young)"></i><i style="width:${o - y}%;background:var(--life-mature)"></i><i style="width:${100 - o}%;background:var(--life-old)"></i><b style="left:${now}%"></b></div>
    <code>${Math.round(now)}%</code></div>`;
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
    $("who").textContent = ""; $("scales").innerHTML = `<p class="empty">Агентов нет. Скоро появится новая пара.</p>`; $("genes").innerHTML = "";
    $("prefs").innerHTML = ""; $("legend").innerHTML = ""; $("brain-note").textContent = ""; $("agent-meta").textContent = "";
    return;
  }
  const sp = SPECIES[c.species];
  $("who").innerHTML = `<span style="color:${sp.color}">${esc(c.name)} ${sp.sex}</span>`;
  $("scales").innerHTML =
    lifeRow(c) +
    scaleRow("Сила", c.strength, scaleColor(c.strength)) +
    scaleRow("Здоровье", c.health, scaleColor(c.health)) +
    scaleRow("Эмоции", c.emotions, scaleColor(c.emotions)) +
    scaleRow("Голод", c.hunger ?? 0, scaleColor(100 - (c.hunger ?? 0))) +
    scaleRow("Скука", c.boredom, scaleColor(100 - c.boredom)) +
    scaleRow("Агрессия", c.aggression, "var(--gene-aggro)") +
    scaleRow("Страх", c.fear ?? 0, "var(--fear)") +
    scaleRow("Смелость", c.courage ?? 0, "var(--courage)");
  $("genes").innerHTML = GENES.map((g) => {
    const v = c.genes?.[g.id] ?? 0;
    return `<div class="scale" title="${g.hint}"><span>${g.name}</span><div class="track"><i style="width:${Math.round(v * 100)}%;background:var(--gene-${g.id})"></i></div><code>${v.toFixed(2)}</code></div>`;
  }).join("");
  const MODES = { sleep: "спит", rest: "отдыхает — мало сил", bored: "скучает, реагирует вяло", fight: "дерётся с хищником", help: "спешит на помощь сородичу", flee: (c.fear ?? 0) > 70 ? "в панике убегает" : "убегает от хищника", survive: "инстинкт выживания: ранен, спасается из последних сил", forage: "голоден — инстинкт гонит к еде", hide: "затаилась — хищник рядом", court: "инстинкт размножения: ищет самку" };
  let state = MODES[c.mode] || (c.strength >= RULES.breedStrength ? "полон сил, готов к размножению" : "");
  const add = (t) => (state = state ? `${state}, ${t}` : t);
  if (c.hunger > RULES.hungerStarve) add("голодает — теряет здоровье");
  else if (c.hunger > RULES.hungerStrong) add("голоден — думает только о еде");
  else if (c.hunger > RULES.hungerWeak) add("слабеет от голода");
  else if (c.hunger > RULES.hungerFocus) add("проголодался — тянет к еде");
  else if (!MODES[c.mode]) add("сыт — сам решает, чем заняться");
  if (c.healing) add("лечится (это вызывает голод)");
  const character = (c.courage ?? 0) >= 60 ? "смелый характер" : (c.fear ?? 0) >= 60 ? "пугливый характер" : "";
  if (character) state = state ? `${state}, ${character}` : character;
  state = state ? state + " · " : "";
  $("agent-meta").textContent = `${state}${PHASE_NAME[c.phase] ?? ""} · возраст ${ticks(c.age)} из ${ticks(c.lifespan ?? 0)} тиков · поколение ${c.gen}` + (c.parents?.length ? ` · родители: ${c.parents.join(" и ")}` : "");

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

function renderEvolution() {
  const hist = details?.geneHistory || [];
  const el = $("evo");
  if (hist.length < 2) { el.innerHTML = `<p class="empty">График появится после первых рождений. Каждая точка — среднее по живым после очередного рождения.</p>`; return; }
  const Wc = 320, Hc = 120, pad = 22;
  const x = (i) => pad + (i / (hist.length - 1)) * (Wc - pad - 6);
  const y = (v) => Hc - 16 - v * (Hc - 26);
  const lines = GENES.map((g) => `<polyline fill="none" stroke="var(--gene-${g.id})" stroke-width="2" points="${hist.map((h, i) => `${x(i).toFixed(1)},${y(h[g.id]).toFixed(1)}`).join(" ")}"/>`).join("");
  const grid = [0, 0.5, 1].map((v) => `<line x1="${pad}" x2="${Wc - 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("");
  const last = hist[hist.length - 1], first = hist[0];
  el.innerHTML = `<svg viewBox="0 0 ${Wc} ${Hc}" role="img" aria-label="Средние гены защиты по рождениям">${grid}${lines}
    <text x="${pad}" y="${Hc - 2}">поколение ${first.gen}</text><text x="${Wc - 6}" y="${Hc - 2}" text-anchor="end">поколение ${last.gen}</text></svg>
    <div class="evo-legend">${GENES.map((g) => `<span><i style="background:var(--gene-${g.id})"></i>${g.name} ${last[g.id].toFixed(2)}</span>`).join("")}</div>`;
}

function renderEpochs() {
  const e = details?.epochs || [];
  $("epochs").innerHTML = e.length
    ? `<table><thead><tr><th>Эпоха</th><th>Прожила, тиков</th><th>Поколений</th><th>Конец</th></tr></thead><tbody>${[...e].reverse().slice(0, 6).map((x) => `<tr><td>${x.epoch}</td><td>${ticks(x.ticks)}</td><td>${x.generations}</td><td>погибли ${esc(x.why)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">Это первая эпоха. Если погибнут все Красные или все Зелёные, мир начнётся заново, а здесь появятся итоги.</p>`;
}

function renderMode() {
  const v = view;
  $("mode").innerHTML = mode === "server"
    ? `<b>●</b> мир живёт на сервере · эпоха ${v.epoch ?? 1} · тик ${ticks(v.tick)} · ${v.tps || TPS} тиков/с` + (v.catchup ? ` · догоняет пропущенное: ещё ${ticks(v.catchup)} тиков` : "")
    : `мир считается в этом браузере · эпоха ${v.epoch ?? 1} · тик ${ticks(v.tick)}`;
}

let lastLog = "";
function renderLog() {
  const log = details?.log || [];
  const key = log.map((l) => l.t + l.text).join("|");
  if (key === lastLog) return;
  lastLog = key;
  $("log").innerHTML = log.map((l) => `<li><span class="t">${ticks(l.t).padStart(9, " ")}</span>${esc(l.text)}</li>`).join("");
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
$("b-rain").onclick = () => act("rain");
$("b-pred").onclick = () => act("predator");
$("b-reset").onclick = () => { $("confirm").hidden = false; };
$("b-reset-no").onclick = () => { $("confirm").hidden = true; };
$("b-reset-yes").onclick = async () => {
  $("confirm").hidden = true;
  if (await act("reset")) { selected = null; view = { ...view, tick: -1 }; prevView = null; lastLog = ""; } // принять первую же картинку нового мира
};
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
  if (frame % 60 === 0) { renderEvolution(); renderEpochs(); }
  frame++;
  requestAnimationFrame(loop);
}

await detect();
$("speed-row").hidden = mode !== "local";
if (mode === "server") { pollState(); await pollDetails(); }
else details = local.details();
requestAnimationFrame(loop);
