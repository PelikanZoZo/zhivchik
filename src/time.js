// Время. В базе всё хранится в UTC, человеку показываем в его часовом поясе (по умолчанию Москва).

// Смещение пояса в минутах для данного момента (учитывает летнее время, если оно есть в поясе).
export function tzOffsetMinutes(tz, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Местные дата и время сейчас: { date: "2026-10-24", time: "13:05", weekday: "суббота" }
export function localNow(tz, date = new Date()) {
  const l = new Date(date.getTime() + tzOffsetMinutes(tz, date) * 60000);
  const iso = l.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    weekday: new Intl.DateTimeFormat("ru-RU", { timeZone: tz, weekday: "long" }).format(date),
  };
}

// "2026-10-25" или "2026-10-25 14:30" (местное время) → { utc: Date, hasTime }
// Возвращает null, если строку не удалось понять.
export function parseLocal(str, tz) {
  if (str == null || str === "") return null;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const hasTime = h !== undefined;
  // Дата без времени — считаем концом дня по местному времени (для сортировки и «просрочено»)
  const naive = Date.UTC(+y, +mo - 1, +d, hasTime ? +h : 23, hasTime ? +mi : 59, 0);
  if (Number.isNaN(naive)) return null;
  // Смещение берём для приблизительного момента и уточняем один раз (на случай перехода времени)
  let off = tzOffsetMinutes(tz, new Date(naive));
  off = tzOffsetMinutes(tz, new Date(naive - off * 60000));
  return { utc: new Date(naive - off * 60000), hasTime };
}

// UTC → местная строка "2026-10-25" или "2026-10-25 14:30"
export function formatLocal(date, tz, hasTime = true) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const l = new Date(d.getTime() + tzOffsetMinutes(tz, d) * 60000).toISOString();
  return hasTime ? `${l.slice(0, 10)} ${l.slice(11, 16)}` : l.slice(0, 10);
}

// Начало и конец местного дня в UTC
export function localDayBounds(tz, dateStr) {
  const start = parseLocal(`${dateStr} 00:00`, tz).utc;
  const end = parseLocal(`${dateStr} 23:59`, tz).utc;
  return { start, end: new Date(end.getTime() + 59999) };
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
