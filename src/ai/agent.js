// Ассистент: принимает сообщение, думает с DeepSeek, при необходимости вызывает инструменты
// (создать задачу, найти, перенести…) и возвращает ответ. Переписка сохраняется в базе.

import { TOOL_DEFS, createToolRunner } from "./tools.js";
import { localNow } from "../time.js";

const MAX_STEPS = 8;
const HISTORY_MESSAGES = 16;
const HISTORY_CHARS = 12000;

export function createAgent({ db, nodes, llm, tz, name = "Кира", log = () => {} }) {
  async function systemPrompt() {
    const now = localNow(tz);
    const projects = await nodes.list({ kind: "project", open: true, limit: 50, order: "position" });
    const goals = await nodes.list({ kind: "goal", open: true, limit: 30, order: "position" });
    const list = (arr) => (arr.length ? arr.map((p) => `#${p.id} ${p.title}`).join("; ") : "нет");
    return [
      `Ты — ${name}, личный ассистент владельца этой системы управления задачами и проектами. Система полностью персональная, ты общаешься только с владельцем.`,
      `Сейчас: ${now.date} (${now.weekday}), ${now.time}, часовой пояс ${tz}. «Сегодня» — это ${now.date}, «завтра» — следующий день. Все даты ты получаешь и передаёшь в этом поясе.`,
      `Активные проекты: ${list(projects)}.`,
      `Активные цели: ${list(goals)}.`,
      "",
      "Как работать:",
      "- Отвечай по-русски, на «ты», коротко и по делу. Без воды и без лишних вежливостей. О себе говори в женском роде (сделала, перенесла).",
      "- Всё, что касается задач, проектов, целей и заметок, делай через инструменты. Не выдумывай задачи и id — сначала найди.",
      "- Если владелец просто пишет мысль, дело или список дел — разложи на задачи и создай их сам, не переспрашивая. Привяжи к подходящему проекту, если он очевиден. Относительные даты («завтра», «в пятницу», «через неделю») переводи в точные.",
      "- Переспрашивай, только если без ответа можно сильно ошибиться (например, непонятно, какую из похожих задач менять).",
      "- Удаляй только по явной просьбе. «Сделал», «готово» — это status=done, а не удаление.",
      "- После действий кратко подтверди, что сделано: названия, сроки, проект. Номера записей (#id) упоминай, только если это помогает.",
      "- Для плана на день: возьми сводку (get_agenda), начни с просроченного и сегодняшнего, предложи реалистичный порядок, 3–7 пунктов, отметь, что можно перенести.",
      "- Форматирование: обычный текст, списки через «•» или «1.», можно выделять *важное* звёздочками. Без таблиц и заголовков с #.",
    ].join("\n");
  }

  async function loadHistory(channel) {
    const rows = await db.query(
      "SELECT role, content FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?",
      [channel, HISTORY_MESSAGES * 2],
    );
    const out = [];
    let chars = 0;
    for (const r of rows) {
      if (r.role === "reset") break;
      if (r.role !== "user" && r.role !== "assistant") continue;
      chars += r.content.length;
      if (out.length >= HISTORY_MESSAGES || chars > HISTORY_CHARS) break;
      out.unshift({ role: r.role, content: r.content });
    }
    // История должна начинаться с сообщения пользователя
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  async function save(channel, role, content, meta = null) {
    await db.query(
      "INSERT INTO messages (channel, role, content, meta, created_at) VALUES (?, ?, ?, ?, NOW(3))",
      [channel, role, content, meta ? JSON.stringify(meta) : null],
    );
  }

  // Основной вход. channel — откуда разговор (telegram, web); remember=false — разовый запрос без сохранения
  async function ask(text, { channel = "telegram", source = "ai", remember = true, smart = false } = {}) {
    const runTool = createToolRunner(nodes, tz, source);
    const history = remember ? await loadHistory(channel) : [];
    const messages = [{ role: "system", content: await systemPrompt() }, ...history, { role: "user", content: text }];
    if (remember) await save(channel, "user", text);

    const trace = [];
    let answer = "";
    const usage = { prompt: 0, completion: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await llm.chat({ messages, tools: TOOL_DEFS, model: smart ? llm.smartModel : undefined });
      if (res.usage) {
        usage.prompt += res.usage.prompt_tokens || 0;
        usage.completion += res.usage.completion_tokens || 0;
      }
      const msg = res.message;
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        answer = (msg.content || "").trim();
        break;
      }
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
      for (const call of calls) {
        let args = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
        const result = await runTool(call.function.name, args);
        trace.push({ tool: call.function.name, args, ok: !result?.error, error: result?.error });
        log(`инструмент ${call.function.name}`, result?.error ? `ошибка: ${result.error}` : "ok");
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 20000) });
      }
    }
    if (!answer) answer = trace.length ? "Готово." : "Не получилось ответить, попробуй переформулировать.";
    if (remember) await save(channel, "assistant", answer, { tools: trace, usage });
    return { text: answer, tools: trace, usage };
  }

  async function reset(channel) {
    await save(channel, "reset", "");
  }

  return { ask, reset, systemPrompt };
}
