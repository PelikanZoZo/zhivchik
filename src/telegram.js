// Подготовка сообщений для Telegram: разбиение длинного текста и простое оформление.
// Сайт сам в Telegram не ходит — он отдаёт готовые действия Cloudflare Worker'у, а тот их выполняет.

const LIMIT = 3800; // у Telegram предел 4096 символов, оставляем запас на разметку

// Текст → одно или несколько действий sendMessage
export function sendMessageActions(chatId, text, extra = {}) {
  return splitText(String(text || "…")).map((chunk) => ({
    method: "sendMessage",
    params: { chat_id: chatId, text: toHtml(chunk), parse_mode: "HTML", disable_web_page_preview: true, ...extra },
    fallback_text: chunk, // если Telegram не примет разметку — Worker отправит как есть
  }));
}

export function splitText(text) {
  if (text.length <= LIMIT) return [text];
  const out = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n\n", LIMIT);
    if (cut < LIMIT / 2) cut = rest.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT / 2) cut = rest.lastIndexOf(" ", LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

// Мини-разметка: *жирный* или **жирный**, _курсив_, `код`. Всё остальное экранируется.
export function toHtml(text) {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(«"])\*([^*\n]+)\*(?=$|[\s.,:;!?)»"])/gm, "$1<b>$2</b>");
  s = s.replace(/(^|[\s(«"])_([^_\n]+)_(?=$|[\s.,:;!?)»"])/gm, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  return s;
}
