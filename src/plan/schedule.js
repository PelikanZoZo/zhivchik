// Расчёт графика: даты — целые дни (календарные), окончание включительно.
// Связи как в MS Project: FS (окончание→начало), SS (начало→начало), FF (окончание→окончание),
// SF (начало→окончание) и задержка в днях (может быть отрицательной — «опережение»).
//
// Вехи (цели) — точки в конце своего дня: задача после вехи начинается на следующий день,
// веха после задачи может стоять в последний день этой задачи.
//
// Автосдвиг — только вперёд: если последователь начинается раньше, чем позволяет связь, он
// сдвигается (длительность сохраняется), и дальше по цепочке. Раньше задачи сами не переезжают —
// это решает человек.

export const LINK_TYPES = { FS: "окончание → начало", SS: "начало → начало", FF: "окончание → окончание", SF: "начало → окончание" };
export const DHX_TYPE = { FS: "0", SS: "1", FF: "2", SF: "3" };
export const FROM_DHX = { 0: "FS", 1: "SS", 2: "FF", 3: "SF" };

const DAY = 86400000;
export const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
export const dayStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);

// Самое раннее допустимое начало последователя по одной связи
export function earliestStart(pred, succ, link) {
  const lag = +link.lag || 0;
  const dur = succ.finish - succ.start + 1;
  switch (link.type) {
    case "SS": return pred.start + lag;
    case "FF": return pred.finish + lag - dur + 1;
    case "SF": return pred.start + lag - dur; // закончить до начала предшественника
    default: return pred.finish + 1 + lag - (succ.milestone ? 1 : 0); // FS
  }
}

// items: Map id → {start, finish, milestone, summary}; links: [{pred_id, succ_id, type, lag}]
// changed: id, с которых начинается расчёт. Меняет items на месте, возвращает Map id → {from, to}.
export function propagate(items, links, changed) {
  const out = new Map();
  const bySource = new Map();
  for (const l of links) {
    if (!bySource.has(l.pred_id)) bySource.set(l.pred_id, []);
    bySource.get(l.pred_id).push(l);
  }
  const queue = [...changed];
  let guard = (items.size + 1) * (links.length + 1) + 100;
  while (queue.length && guard-- > 0) {
    const id = queue.shift();
    const pred = items.get(id);
    if (!pred || pred.start == null) continue;
    for (const l of bySource.get(id) || []) {
      const succ = items.get(l.succ_id);
      if (!succ || succ.start == null || succ.summary) continue;
      const need = earliestStart(pred, succ, l);
      if (succ.start < need) {
        const shift = need - succ.start;
        if (!out.has(l.succ_id)) out.set(l.succ_id, { from: { start: succ.start, finish: succ.finish } });
        succ.start += shift;
        succ.finish += shift;
        out.get(l.succ_id).to = { start: succ.start, finish: succ.finish };
        queue.push(l.succ_id);
      }
    }
  }
  return out;
}

// Будет ли цикл, если добавить связь pred → succ
export function createsCycle(links, predId, succId) {
  if (predId === succId) return true;
  const next = new Map();
  for (const l of links) {
    if (!next.has(l.pred_id)) next.set(l.pred_id, []);
    next.get(l.pred_id).push(l.succ_id);
  }
  const seen = new Set();
  const stack = [succId];
  while (stack.length) {
    const x = stack.pop();
    if (x === predId) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(next.get(x) || []));
  }
  return false;
}

// Нарушенные связи (например, после ручного переноса предшественника назад или последователя вперёд не нужно,
// а вот последователь раньше допустимого — нарушение)
export function violations(items, links) {
  const out = [];
  for (const l of links) {
    const p = items.get(l.pred_id);
    const s = items.get(l.succ_id);
    if (!p || !s || p.start == null || s.start == null || s.summary) continue;
    const need = earliestStart(p, s, l);
    if (s.start < need) out.push({ link: l, days: need - s.start });
  }
  return out;
}
