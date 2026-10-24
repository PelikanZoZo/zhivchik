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
  // ссылки [текст](https://…)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
  return s;
}

// Отправить файл из хранилища. Если он уже был в Telegram — по file_id (без загрузки),
// иначе Worker сам скачает его с сайта ({kira_file: id}) и загрузит в Telegram.
const BY_TG_TYPE = {
  voice: ["sendVoice", "voice"], audio: ["sendAudio", "audio"], photo: ["sendPhoto", "photo"],
  video: ["sendVideo", "video"], video_note: ["sendVideoNote", "video_note"], document: ["sendDocument", "document"],
};

export function fileAction(chatId, f, caption = "") {
  const [method, field] = (f.tg_file_id && BY_TG_TYPE[f.tg_type]) || ["sendDocument", "document"];
  const params = { chat_id: chatId, [field]: f.tg_file_id || { kira_file: f.id, name: f.name, mime: f.mime || "application/octet-stream" } };
  const cap = String(caption || "").slice(0, 1000);
  if (cap && method !== "sendVideoNote") params.caption = cap;
  return { method, params, fallback_file: f.tg_file_id ? { kira_file: f.id, name: f.name, mime: f.mime || "application/octet-stream", field: "document" } : undefined };
}
