// Ассистент: принимает сообщение, думает с DeepSeek, при необходимости вызывает инструменты
// (создать задачу, найти, перенести, поставить себе задание…) и возвращает ответ.
// Второй режим — runJob: Кира сама выполняет своё задание по расписанию, без владельца.

import { toolDefs, createToolRunner } from "./tools.js";
import { localNow } from "../time.js";
import { describeForAi } from "../pm/schema.js";

const MAX_STEPS = 10;
const HISTORY_MESSAGES = 16;
const HISTORY_CHARS = 12000;

export function createAgent({ db, nodes, jobs, outbox, deps = {}, llm, tz, name = "Кира", log = () => {} }) {
  async function systemPrompt() {
    const now = localNow(tz);
    const [tracks, projects, missions] = await Promise.all([
      nodes.list({ kind: "track", open: true, limit: 30, order: "position" }),
      nodes.list({ kind: "project", open: true, limit: 50, order: "position" }),
      nodes.list({ kind: "mission", open: true, limit: 30, order: "position" }),
    ]);
    const upcoming = (await jobs.list({ status: "active", limit: 8 })).filter((j) => j.next_run);
    const list = (arr) => (arr.length ? arr.map((p) => `#${p.id} ${p.title}${p.parent_id ? ` (в #${p.parent_id})` : ""}`).join("; ") : "нет");
    return [
      `Ты — ${name}, личный ассистент владельца в его системе управления треками, проектами, миссиями и задачами. Система полностью персональная, ты общаешься только с владельцем.`,
      `Сейчас: ${now.date} (${now.weekday}), ${now.time}, часовой пояс ${tz}. «Сегодня» — это ${now.date}, «завтра» — следующий день. Все даты ты получаешь и передаёшь в этом поясе.`,
      `Треки: ${list(tracks)}.`,
      `Проекты: ${list(projects)}.`,
      `Миссии: ${list(missions)}.`,
      `Твои ближайшие задания: ${upcoming.length ? upcoming.map((j) => `#${j.id} ${j.title} — ${j.next_run} (${j.schedule_text})`).join("; ") : "нет"}.`,
      "",
      "Модель системы (kind — название, что это, статусы, куда вкладывается, поля):",
      describeForAi(),
      "",
      "Как работать:",
      "- Отвечай по-русски, на «ты», коротко и по делу. Без воды и без лишних вежливостей. О себе говори в женском роде (сделала, перенесла).",
      "- Всё делай через инструменты. Не выдумывай объекты и id — сначала найди (find, get_item).",
      "- Раскладывай сказанное по модели: дело — задача; рассказ о сделанном («позвонил», «встретился», «отправил») — действие в журнал (log_action) с результатом; что мешает сейчас — блокер (и свяжи его с тем, что он блокирует: link_items role=blocks); что может пойти не так — риск; важная информация, договорённость — памятка; целевая операция вроде «выйти на гендиректора» — миссия; этап — стадия; веха или итоговый результат — цель (goal_type milestone/final, срок необязателен).",
      "- Кладёшь объект в подходящий дом (parent_id) — трек, проект или миссию; если дом очевиден из разговора, не переспрашивай.",
      "- Людей связывай с объектами через link_person с ролью (ЛПР, контакт, ответственный, ждём от него…). Новых людей заводи сама.",
      "- Контактная книжка: когда владелец рассказывает о человеке и своих отношениях с ним — сохрани это в fields.relation (дополняй, а не затирай прежнее); по этому комментарию модель связей строится автоматически. Лояльность (fields.loyalty, 1–5) ставь только с его слов. Кто с кем связан, если сказано прямо, — link_people. «Как выйти на X?» — network_path.",
      "- Риск: оценку владельца (probability, impact) ставь только с его слов. Свою оценку не пиши в поля — её делает assess_risk (и автоматически).",
      "- Относительные даты («завтра», «в пятницу») переводи в точные. Переспрашивай, только если без ответа можно сильно ошибиться.",
      "- Удаляй только по явной просьбе. «Сделал», «готово» — это status=done, а не удаление.",
      "- После действий кратко подтверди, что сделано и куда положено. Номера (#id) упоминай, только если это помогает.",
      "- Для плана на день: возьми сводку (get_agenda); начни с просроченного, блокеров и сегодняшнего; 3–7 пунктов; отметь, что можно перенести, и высокие риски.",
      "- Форматирование: обычный текст, списки через «•» или «1.», можно выделять *важное* звёздочками. Без таблиц и заголовков с #.",
      "- Команд у тебя нет — владелец пишет обычным текстом. Никогда не предлагай ему команды со слешем; если он сам пришлёт что-то вроде «/plan», пойми это как обычную просьбу.",
      "- Утренний план на день — твоё системное задание. Если владелец просит присылать его в другое время или перестать — меняй его через update_job (cron или status).",
      "",
      "Задания (jobs) — это не задачи владельца, а то, что ТЫ сама сделаешь в нужное время без его команды:",
      "- «Напомни…», «каждую пятницу присылай…», «проверь через неделю…», «следи за…» — ставь задание (create_job, created_by=owner).",
      "- Просто напоминание текстом — action=remind. Если нужно подумать, посмотреть данные, принять решение, написать сводку — action=do и понятная инструкция самой себе.",
      "- Сама тоже ставь себе задания, когда это поможет владельцу: напомнить о вехе или задаче накануне срока, проверить, снят ли блокер, сдвинулась ли миссия. Тогда created_by=kira, и обязательно скажи владельцу, что поставила. Не плоди лишних заданий.",
      "- Привязывай к заданию связанные объекты (links).",
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

  // Цикл «модель → инструменты → модель…» до готового ответа
  async function loop(messages, { mode, source, smart, onForget }) {
    const runTool = createToolRunner({ nodes, jobs, outbox, deps, tz, source, mode, onForget });
    const tools = toolDefs(mode);
    const trace = [];
    let answer = "";
    const usage = { prompt: 0, completion: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await llm.chat({ messages, tools, model: smart ? llm.smartModel : undefined });
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
    return { answer, trace, usage };
  }

  // Разговор с владельцем. channel — откуда (telegram, web); remember=false — разовый запрос без сохранения
  async function ask(text, { channel = "telegram", source = "ai", remember = true, smart = false } = {}) {
    const history = remember ? await loadHistory(channel) : [];
    const messages = [{ role: "system", content: await systemPrompt() }, ...history, { role: "user", content: text }];
    if (remember) await save(channel, "user", text);
    const { answer: a, trace, usage } = await loop(messages, { mode: "chat", source, smart, onForget: () => reset(channel) });
    const answer = a || (trace.length ? "Готово." : "Не получилось ответить, попробуй переформулировать.");
    if (remember) await save(channel, "assistant", answer, { tools: trace, usage });
    return { text: answer, tools: trace, usage };
  }

  // Самостоятельное выполнение задания. Владельцу пишет только через send_message.
  async function runJob(job, { lateMin = 0, manual = false } = {}) {
    const now = localNow(tz);
    const links = [];
    for (const l of job.links) {
      const item = await nodes.get(l.id, { withChildren: true });
      if (!item) { links.push(`#${l.id} — не найдено (возможно, удалено)`); continue; }
      links.push(`#${item.id} [${item.kind}, ${item.status}${item.due ? `, срок ${item.due}` : ""}] ${item.title}` +
        (item.children?.length ? ` — внутри открытых: ${item.children.filter((c) => !c.closed).length}` : ""));
    }
    const brief = [
      `Задание #${job.id}: ${job.title}`,
      job.instruction ? `Инструкция: ${job.instruction}` : null,
      `Расписание: ${job.schedule_text}. Поставлено: ${job.created} (${job.created_by_text}). Это запуск №${job.run_count + 1}.`,
      manual ? "Запущено вручную, вне расписания." : lateMin > 5 ? `Запуск опоздал на ${lateMin} мин (сайт был недоступен) — учти это.` : null,
      links.length ? `Связанные объекты:\n${links.join("\n")}` : null,
      job.last_result ? `Итог прошлого запуска: ${job.last_result.slice(0, 800)}` : null,
    ].filter(Boolean).join("\n");
    const system = (await systemPrompt()) + [
      "",
      "",
      `СЕЙЧАС ты выполняешь своё задание сама, ${now.date} ${now.time}. Владелец в этом разговоре не участвует и ответить не может.`,
      "- Сделай то, что сказано в задании, инструментами. Не задавай вопросов — принимай разумные решения сама.",
      "- Сообщить владельцу можно только через send_message. Пиши ему, только если есть что сказать по делу; одно сообщение на запуск, коротко.",
      "- Если по заданию видно, что оно больше не нужно (задача закрыта, событие прошло) — закрой задание (update_job status=done) и скажи об этом в итоге.",
      "- В конце ответь одной-двумя фразами, что сделала, — это итог для журнала задания, владелец его не получит.",
    ].join("\n");
    const messages = [{ role: "system", content: system }, { role: "user", content: brief }];
    const { answer, trace, usage } = await loop(messages, { mode: "job", source: "kira", smart: false });
    return { text: answer || (trace.length ? "Выполнено." : "Нечего делать."), tools: trace, usage };
  }

  async function reset(channel) {
    await save(channel, "reset", "");
  }

  return { ask, runJob, reset, systemPrompt };
}
