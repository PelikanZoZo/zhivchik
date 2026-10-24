// Расписания в формате cron (минута час день месяц день_недели) — по местному времени владельца.
// Примеры: "30 8 * * *" — каждый день в 8:30; "0 18 * * 5" — по пятницам в 18:00; "0 10 1 * *" — 1-го числа в 10:00.

import { parseLocal, tzOffsetMinutes } from "./time.js";

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Расписание должно состоять из 5 частей (минута час день месяц день_недели): «${expr}»`);
  const fields = parts.map((p, i) => parseField(p.toLowerCase(), i));
  if (fields[4].has(7)) { fields[4].delete(7); fields[4].add(0); }
  return {
    minutes: [...fields[0]].sort((a, b) => a - b),
    hours: [...fields[1]].sort((a, b) => a - b),
    dom: fields[2], month: fields[3], dow: fields[4],
    domAny: parts[2] === "*", dowAny: parts[4] === "*",
    expr: parts.join(" "),
  };
}

function parseField(text, i) {
  const [lo, hi] = RANGES[i];
  const out = new Set();
  for (const part of text.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : +stepStr;
    if (!(step >= 1)) throw new Error(`Неверный шаг в расписании: «${part}»`);
    let a, b;
    if (range === "*") { a = lo; b = hi; }
    else {
      const [x, y] = range.split("-").map((v) => (i === 4 && DOW_NAMES[v] !== undefined ? DOW_NAMES[v] : +v));
      a = x; b = y === undefined ? (stepStr === undefined ? x : hi) : y;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) {
      throw new Error(`Значение «${part}» вне допустимого диапазона ${lo}–${hi}`);
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

// Ближайший момент строго после `after` (Date, UTC) по местному времени tz
export function nextCron(expr, after, tz) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const off = tzOffsetMinutes(tz, after);
  const local = new Date(after.getTime() + off * 60000);
  // начинаем со следующей целой минуты местного времени
  let day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  let fromMinute = local.getUTCHours() * 60 + local.getUTCMinutes() + 1;
  for (let d = 0; d < 366 * 5; d++) {
    if (matchDay(c, day)) {
      for (const h of c.hours) {
        for (const m of c.minutes) {
          if (h * 60 + m < fromMinute) continue;
          const ds = day.toISOString().slice(0, 10);
          const t = parseLocal(`${ds} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, tz).utc;
          if (t.getTime() > after.getTime()) return t;
        }
      }
    }
    day = new Date(day.getTime() + 86400000);
    fromMinute = 0;
  }
  return null;
}

function matchDay(c, day) {
  if (!c.month.has(day.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(day.getUTCDate());
  const dowOk = c.dow.has(day.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk; // как в классическом cron: если заданы оба — любое из условий
}

const DOW_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Человеческое описание расписания
export function describeCron(expr) {
  let c;
  try { c = parseCron(expr); } catch { return `по расписанию «${expr}»`; }
  const [mi, ho, dom, mon, dow] = c.expr.split(" ");
  const simpleTime = /^\d+$/.test(mi) && /^\d+$/.test(ho);
  const at = simpleTime ? ` в ${ho.padStart(2, "0")}:${mi.padStart(2, "0")}` : "";
  if (simpleTime && mon === "*") {
    if (dom === "*" && dow === "*") return `каждый день${at}`;
    if (dom === "*" && dow === "1-5") return `по будням${at}`;
    if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `по выходным${at}`;
    if (dom === "*") return `по ${[...c.dow].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW_RU[d]).join(", ")}${at}`;
    if (/^\d+$/.test(dom) && dow === "*") return `каждое ${dom}-е число${at}`;
  }
  if (/^\*\/\d+$/.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*") return `каждые ${mi.slice(2)} мин`;
  if (mi === "0" && /^\*\/\d+$/.test(ho) && dom === "*" && mon === "*" && dow === "*") return `каждые ${ho.slice(2)} ч`;
  return `по расписанию «${c.expr}»`;
}

export function describeInterval(min) {
  if (min % 1440 === 0) return `каждые ${min / 1440} дн`;
  if (min % 60 === 0) return `каждые ${min / 60} ч`;
  return `каждые ${min} мин`;
}
