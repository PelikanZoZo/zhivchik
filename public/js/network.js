// Сеть контактов: граф «я — мои люди — их связи». Раскладка — простая силовая модель, без библиотек.
// Цвет — моя лояльность, размер — влиятельность по оценке Киры, пунктир — связь, которую нашла Кира.
import { el, state, hooks } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  for (const kid of kids) if (kid) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};

export function networkGraph({ people, edges }, { height = 560 } = {}) {
  const W = 1000, H = height;
  const ME = 0;
  const nodes = [{ id: ME, title: "Я", me: true, fields: {} }, ...people].map((p, i) => ({
    ...p, x: W / 2 + Math.cos(i * 2.4) * (40 + i * 6), y: H / 2 + Math.sin(i * 2.4) * (40 + i * 6), vx: 0, vy: 0,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = [
    // моя связь — с каждым, кому я поставил лояльность
    ...people.filter((p) => p.fields.loyalty).map((p) => ({ a: ME, b: p.id, me: true, loyalty: p.fields.loyalty })),
    ...edges.filter((e) => byId.has(e.a) && byId.has(e.b)),
  ];
  // силовая раскладка: отталкивание всех, притяжение по связям, центр
  const meNode = byId.get(ME);
  meNode.x = W / 2; meNode.y = H / 2;
  for (let it = 0; it < 320; it++) {
    const alpha = 1 - it / 320;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = (9000 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const l of links) {
      const a = byId.get(l.a), b = byId.get(l.b);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const want = l.me ? 230 - (l.loyalty || 3) * 22 : 150;
      const f = ((d - want) / d) * 0.06 * alpha;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004 * alpha;
      n.vy += (H / 2 - n.y) * 0.004 * alpha;
      if (n.me) { n.vx = 0; n.vy = 0; continue; }
      n.x += Math.max(-20, Math.min(20, n.vx)); n.y += Math.max(-20, Math.min(20, n.vy));
      n.vx *= 0.6; n.vy *= 0.6;
      n.x = Math.max(30, Math.min(W - 30, n.x)); n.y = Math.max(24, Math.min(H - 24, n.y));
    }
  }

  // вписать в поле: растянуть раскладку на всю площадь
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min((W - 160) / Math.max(x1 - x0, 1), (H - 90) / Math.max(y1 - y0, 1), 2.5);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const n of nodes) { n.x = W / 2 + (n.x - cx) * k; n.y = H / 2 + (n.y - cy) * k - 8; }

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "net-svg", role: "img", "aria-label": "Сеть контактов" });
  const gEdges = svg("g");
  const gNodes = svg("g");
  for (const l of links) {
    const a = byId.get(l.a), b = byId.get(l.b);
    const cls = l.me ? `edge me l${l.loyalty}` : `edge${l.origin === "ai" ? " ai" : ""}${/конфликт|конкурент/.test(l.role || "") ? " bad" : ""}`;
    const line = svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls });
    if (!l.me) line.append(svg("title", {}, `${a.title} — ${l.role} — ${b.title}${l.note ? `: ${l.note}` : ""}${l.origin === "ai" ? " (Кира)" : ""}`));
    gEdges.append(line);
    if (!l.me && l.role) {
      gEdges.append(svg("text", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 3, class: "edge-label" }, l.role));
    }
  }
  for (const n of nodes) {
    const r = n.me ? 18 : 7 + (n.fields.ai_influence || 2) * 2.2;
    const g = svg("g", { class: `nd${n.me ? " me" : ""} l${n.fields.loyalty || 0}`, transform: `translate(${n.x},${n.y})`, tabindex: n.me ? undefined : 0, role: n.me ? undefined : "button", "aria-label": n.me ? undefined : n.title });
    g.append(svg("circle", { r }));
    g.append(svg("text", { y: r + 13, class: "nd-label" }, n.title));
    if (!n.me) {
      const tip = [n.title, n.fields.position, n.fields.company, n.fields.loyalty ? `лояльность ${n.fields.loyalty} — ${state.schema?.loyalty?.[n.fields.loyalty] || ""}` : null, n.fields.ai_summary].filter(Boolean).join("\n");
      g.append(svg("title", {}, tip));
      const open = () => hooks.openItem(n.id);
      g.addEventListener("click", open);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    }
    gNodes.append(g);
  }
  root.append(gEdges, gNodes);
  const legend = el("div", { class: "net-legend" },
    [5, 4, 3, 2, 1].map((v) => el("span", { class: `lg l${v}` }, el("i"), state.schema?.loyalty?.[v] || v)),
    el("span", { class: "lg none" }, el("i"), "не оценён"),
    el("span", { class: "lg-ai" }, "пунктир — связь нашла Кира; размер — влиятельность"));
  return el("div", { class: "net-wrap" }, root, legend);
}
