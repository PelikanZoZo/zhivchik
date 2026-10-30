// Личный чат с DeepSeek на сайте — без логирования.
//
// Сервер только передаёт сообщения в DeepSeek и потоком отдаёт ответ в браузер. Переписка нигде не хранится:
// ни в базе, ни в журнале сайта, ни в архиве (DWH), ни в памяти Киры. История живёт только во вкладке
// браузера и пропадает при её закрытии или по кнопке «Новый чат».
// В журнал ошибок может попасть только код ошибки DeepSeek — без текста сообщений.

const MAX_MESSAGES = 200;
const MAX_CHARS = 400000; // ~100 тыс. токенов — с запасом под контекст модели

export function createPrivateChat({ key, url, model, smartModel }) {
  const models = { flash: model, pro: smartModel || model };

  // Проверить и почистить то, что прислал браузер
  function prepare(body) {
    const list = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
    const messages = [];
    let total = 0;
    for (const m of list) {
      if (!m || !["user", "assistant"].includes(m.role)) continue;
      const content = String(m.content ?? "");
      if (!content.trim()) continue;
      total += content.length;
      messages.push({ role: m.role, content });
    }
    if (!messages.length || messages[messages.length - 1].role !== "user") throw Object.assign(new Error("Нет сообщения"), { status: 400, expose: true });
    if (total > MAX_CHARS) throw Object.assign(new Error("Переписка слишком длинная — начни новый чат"), { status: 413, expose: true });
    const system = String(body.system || "").trim().slice(0, 20000);
    const temperature = Number.isFinite(+body.temperature) ? Math.max(0, Math.min(2, +body.temperature)) : 0.7;
    return {
      model: models[body.model] || models.flash,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      temperature,
    };
  }

  // Поток ответа: onDelta({content, reasoning}), в конце — {usage, model, finish}
  async function stream(body, { onDelta, signal }) {
    if (!key) throw Object.assign(new Error("Не задан ключ DeepSeek"), { status: 503, expose: true });
    const req = prepare(body);
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...req, stream: true, stream_options: { include_usage: true }, max_tokens: 8000 }),
      signal,
    });
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json())?.error?.message || ""; } catch {}
      throw Object.assign(new Error(`DeepSeek: ${res.status}${msg ? " " + msg.slice(0, 200) : ""}`), { status: 502, expose: true });
    }
    const decoder = new TextDecoder();
    let buf = "";
    let usage = null;
    let finish = null;
    let usedModel = req.model;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.model) usedModel = j.model;
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta || {};
        if (d.content || d.reasoning_content) onDelta({ content: d.content || "", reasoning: d.reasoning_content || "" });
      }
    }
    return { usage, model: usedModel, finish };
  }

  return { stream, models };
}
