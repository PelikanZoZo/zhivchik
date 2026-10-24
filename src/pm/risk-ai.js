// Оценка рисков Кирой: вероятность и влияние (1–5) с комментарием — рядом с оценкой владельца.
// Новый или изменённый риск (а также риск, к которому добавили комментарий или связь) оценивается
// автоматически при ближайшем «пульсе» (раз в минуту). Свою оценку владельца ИИ не трогает.

import { formatLocal } from "../time.js";
import { TYPES } from "./schema.js";

const MAX_PER_TICK = 3;

export function createRiskAssessor({ db, nodes, llm, tz, log = () => {} }) {
  // Риски, которые ещё не оценены в текущем виде
  async function pending() {
    const risks = await nodes.list({ kind: "risk", status: ["open", "watching"], limit: 300, order: "recent" });
    return risks.filter((r) => r.fields.ai_for_version !== r.version);
  }

  async function context(risk) {
    const path = await nodes.path(risk.parent_id);
    const parent = risk.parent_id ? await nodes.get(risk.parent_id, { withChildren: true }) : null;
    const lines = [];
    if (path.length) lines.push(`Где: ${path.map((p) => `${p.title} (${TYPES[p.kind]?.label || p.kind})`).join(" → ")}`);
    if (parent?.body) lines.push(`Описание «${parent.title}»: ${parent.body.slice(0, 1500)}`);
    if (parent?.due) lines.push(`Срок «${parent.title}»: ${parent.due}`);
    const sib = (parent?.children || []).filter((c) => c.id !== risk.id && !c.closed);
    const show = (kind, label) => {
      const l = sib.filter((c) => c.kind === kind).slice(0, 15);
      if (l.length) lines.push(`${label}: ${l.map((c) => `${c.title}${c.due ? ` (срок ${c.due})` : ""}${c.status_label ? `, ${c.status_label.toLowerCase()}` : ""}`).join("; ")}`);
    };
    show("task", "Открытые задачи рядом");
    show("blocker", "Блокеры рядом");
    show("risk", "Другие риски рядом");
    const acts = (parent?.children || []).filter((c) => c.kind === "action").slice(-5);
    if (acts.length) lines.push(`Последние действия: ${acts.map((a) => `${a.event_at}: ${a.title}${a.fields.result ? ` → ${a.fields.result}` : ""}`).join("; ")}`);
    const full = await nodes.get(risk.id, { full: true });
    if (full.comments.length) lines.push(`Комментарии к риску: ${full.comments.map((c) => c.text).join(" | ").slice(0, 1500)}`);
    const people = full.links.filter((l) => l.kind === "person");
    if (people.length) lines.push(`Люди: ${people.map((p) => `${p.title} — ${p.role}`).join("; ")}`);
    return lines.join("\n");
  }

  async function assess(id) {
    const risk = await nodes.get(+id);
    if (!risk || risk.kind !== "risk") throw new Error(`Нет риска #${id}`);
    const f = risk.fields;
    const prompt = [
      `Риск: ${risk.title}`,
      risk.body ? `Подробности: ${risk.body}` : null,
      f.mitigation ? `Меры: ${f.mitigation}` : null,
      `Статус: ${risk.status_label}`,
      f.probability || f.impact ? `Оценка владельца: вероятность ${f.probability ?? "—"}, влияние ${f.impact ?? "—"} (из 5)` : "Владелец ещё не оценил.",
      await context(risk),
    ].filter(Boolean).join("\n");
    const res = await llm.chat({
      messages: [
        { role: "system", content: "Ты — Кира, ассистент по управлению проектами. Оцени риск независимо от владельца: вероятность (1 — почти невозможно, 5 — почти наверняка) и влияние на результат (1 — незаметно, 5 — провал цели). Комментарий 1–3 предложения по-русски: почему так и что стоит сделать; если твоя оценка сильно расходится с оценкой владельца — скажи, в чём. Ответ строго JSON: {\"probability\": 1-5, \"impact\": 1-5, \"comment\": \"...\"}" },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 400,
      json: true,
    });
    let data;
    try { data = JSON.parse((res.message.content || "").replace(/^```(json)?|```$/g, "").trim()); } catch { throw new Error("Модель ответила не JSON"); }
    const clamp = (x) => Math.min(5, Math.max(1, Math.round(+x) || 3));
    const fresh = await nodes.getRow(risk.id);
    const updated = await nodes.update(risk.id, {
      fields: {
        ai_probability: clamp(data.probability), ai_impact: clamp(data.impact),
        ai_comment: String(data.comment || "").slice(0, 2000),
        ai_assessed_at: formatLocal(new Date(), tz), ai_for_version: fresh.version + 1,
      },
      allowSystemFields: true,
    }, "kira");
    log(`риск #${risk.id} оценён ИИ: ${data.probability}×${data.impact}`);
    return updated;
  }

  // Вызывается раз в минуту: оценить несколько ждущих рисков
  async function runPending() {
    const list = (await pending()).slice(0, MAX_PER_TICK);
    for (const r of list) {
      try { await assess(r.id); } catch (e) { log(`оценка риска #${r.id} не удалась: ${e.message}`); }
    }
    return list.length;
  }

  return { assess, runPending, pending };
}
