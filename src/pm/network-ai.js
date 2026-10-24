// Сеть контактов. По моему комментарию об отношениях с человеком Кира строит модель связи:
// кто он, насколько влиятелен, как выстраивать отношения, и с кем он связан (коллега, руководитель,
// друг, рекомендовал…). Связи, найденные ИИ, хранятся отдельно от поставленных мной (origin = 'ai')
// и пересобираются при каждом изменении комментария. Мою лояльность ИИ не трогает.

import { formatLocal } from "../time.js";
import { LOYALTY, PERSON_LINKS } from "./schema.js";
import { findOrCreatePerson } from "../ai/tools.js";

const MAX_PER_TICK = 3;

export function createNetworkAssessor({ nodes, llm, tz, log = () => {} }) {
  async function pending() {
    const people = await nodes.list({ kind: "person", limit: 2000, order: "recent" });
    return people.filter((p) => !p.closed && p.fields.relation && p.fields.ai_for_version !== p.version);
  }

  async function assess(id) {
    const person = await nodes.get(+id, { full: true });
    if (!person || person.kind !== "person") throw new Error(`Нет человека #${id}`);
    const f = person.fields;
    const others = (await nodes.list({ kind: "person", limit: 400, order: "title" })).filter((p) => p.id !== person.id);
    const roles = person.links.filter((l) => l.kind !== "person").map((l) => `${l.role} в «${l.title}»`);
    const mine = person.links.filter((l) => l.kind === "person" && l.origin !== "ai").map((l) => `${l.title} — ${l.role}`);
    const prompt = [
      `Человек: ${person.title}${f.position ? `, ${f.position}` : ""}${f.company ? `, ${f.company}` : ""}`,
      `Моя оценка лояльности: ${f.loyalty ? `${f.loyalty} из 5 (${LOYALTY[f.loyalty]})` : "не указана"}`,
      `Мой комментарий об отношениях: ${f.relation}`,
      person.body ? `Заметки: ${person.body.slice(0, 2000)}` : null,
      roles.length ? `Роли в моих проектах: ${roles.join("; ")}` : null,
      mine.length ? `Связи, которые я указал сам: ${mine.join("; ")}` : null,
      `Люди в моей книжке (id: имя, компания, должность):\n${others.map((p) => `${p.id}: ${p.title}${p.fields.company ? `, ${p.fields.company}` : ""}${p.fields.position ? `, ${p.fields.position}` : ""}`).join("\n") || "пока никого"}`,
    ].filter(Boolean).join("\n");
    const messages = [
      {
        role: "system",
        content: [
          "Ты — Кира, ассистент владельца. Строишь модель его сети контактов по его комментарию о человеке.",
          "Верни только JSON-объект:",
          '{"summary": "кто это для владельца, 1–2 предложения", "influence": 1-5, "approach": "как выстраивать и использовать отношения, 1–3 предложения", "relations": [{"id": число или null, "name": "имя", "type": "тип связи", "note": "коротко, откуда известно", "company": "если сказано", "position": "если сказано"}]}',
          `Типы связей: ${PERSON_LINKS.join(", ")} (или свой, одним-двумя словами).`,
          "relations — только люди, о связи с которыми прямо сказано или однозначно следует из комментария. Ничего не выдумывай.",
          "Если человек уже есть в книжке — укажи его id; иначе id = null и имя как в комментарии.",
          "influence — насколько этот человек может повлиять на дела владельца (1 — никак, 5 — решающе).",
          "Пиши по-русски. Лояльность владельца не оценивай — это его оценка.",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ];
    let data = null;
    let last = "";
    for (const json of [true, false]) {
      const res = await llm.chat({ messages, temperature: 0.2, maxTokens: 1500, json });
      last = res.message.content || "";
      data = extractJson(last);
      if (data && typeof data === "object") break;
    }
    if (!data) throw new Error(`Модель ответила не JSON: ${last.slice(0, 160) || "(пусто)"}`);

    // связи: старые от ИИ убираем, новые ставим
    await nodes.removeAiLinks(person.id);
    const made = [];
    const valid = new Set(others.map((o) => o.id));
    for (const r of Array.isArray(data.relations) ? data.relations.slice(0, 30) : []) {
      if (!r || !(r.name || r.id)) continue;
      let other = r.id && valid.has(+r.id) ? others.find((o) => o.id === +r.id) : null;
      if (!other) {
        if (!r.name || String(r.name).trim().toLowerCase() === person.title.toLowerCase()) continue;
        other = await findOrCreatePerson(nodes, { name: r.name, company: r.company, position: r.position }, "kira");
      }
      if (other.id === person.id) continue;
      const type = String(r.type || "знакомый").trim().slice(0, 40) || "знакомый";
      // не дублировать: такая же связь уже есть (поставлена мной или найдена с другой стороны)
      const existing = await nodes.db.query(
        `SELECT role, origin, a_id FROM node_links WHERE removed_at IS NULL AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`,
        [person.id, other.id, other.id, person.id],
      );
      if (existing.some((e) => e.role.toLowerCase() === type.toLowerCase() || (e.origin === "ai" && e.a_id === other.id))) { made.push(`${other.title} — ${type} (уже есть)`); continue; }
      await nodes.link(person.id, other.id, type, "kira", r.note ? String(r.note).slice(0, 400) : null, { origin: "ai", quiet: true });
      made.push(`${other.title} — ${type}`);
    }
    const fresh = await nodes.getRow(person.id);
    const clamp = (x) => (x ? Math.min(5, Math.max(1, Math.round(+x) || 3)) : null);
    const updated = await nodes.update(person.id, {
      fields: {
        ai_summary: data.summary ? String(data.summary).slice(0, 2000) : null,
        ai_influence: clamp(data.influence),
        ai_approach: data.approach ? String(data.approach).slice(0, 2000) : null,
        ai_assessed_at: formatLocal(new Date(), tz),
        ai_for_version: fresh.version + 1,
      },
      allowSystemFields: true,
    }, "kira");
    log(`сеть: ${person.title} — связей ${made.length}`);
    return { person: updated, relations: made };
  }

  async function runPending() {
    const list = (await pending()).slice(0, MAX_PER_TICK);
    for (const p of list) {
      try { await assess(p.id); } catch (e) { log(`модель связей для #${p.id} не построена: ${e.message}`); }
    }
    return list.length;
  }

  // Как выйти на человека: короткие цепочки знакомств от тех, кто ко мне лоялен
  async function paths(targetId, { maxDepth = 4, limit = 3 } = {}) {
    const { people, edges } = await nodes.network();
    const byId = new Map(people.map((p) => [p.id, p]));
    if (!byId.has(+targetId)) throw new Error(`Нет человека #${targetId}`);
    const adj = new Map();
    for (const e of edges) {
      if (e.role === "конфликт" || e.role === "конкурент") continue;
      for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
        if (!adj.has(x)) adj.set(x, []);
        adj.get(x).push({ to: y, role: e.role });
      }
    }
    const target = byId.get(+targetId);
    if ((target.fields.loyalty || 0) >= 3) return { direct: true, target: target.title, loyalty: target.fields.loyalty, paths: [] };
    // обход в ширину от цели к тем, кто лоялен (4–5)
    const found = [];
    const queue = [[+targetId]];
    const seenDepth = new Map([[+targetId, 0]]);
    while (queue.length && found.length < limit * 3) {
      const path = queue.shift();
      if (path.length > maxDepth + 1) break;
      const last = path.at(-1);
      for (const { to } of adj.get(last) || []) {
        if (path.includes(to)) continue;
        const np = [...path, to];
        if ((byId.get(to)?.fields.loyalty || 0) >= 4) { found.push(np); continue; }
        if ((seenDepth.get(to) ?? 99) < np.length - 1) continue;
        seenDepth.set(to, np.length - 1);
        queue.push(np);
      }
    }
    const roleOf = (x, y) => edges.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x))?.role;
    const score = (p) => p.length * 10 - (byId.get(p.at(-1)).fields.loyalty || 0) - (byId.get(p.at(-1)).fields.ai_influence || 0);
    const best = found.sort((a, b) => score(a) - score(b)).slice(0, limit);
    return {
      direct: false,
      target: target.title,
      paths: best.map((p) => {
        const chain = [...p].reverse(); // от моего лояльного контакта к цели
        return {
          start: `${byId.get(chain[0]).title} (лояльность ${byId.get(chain[0]).fields.loyalty})`,
          chain: chain.map((id, i) => (i === 0 ? byId.get(id).title : `—${roleOf(chain[i - 1], id) || "связан"}→ ${byId.get(id).title}`)).join(" "),
          steps: chain.length - 1,
        };
      }),
    };
  }

  return { assess, runPending, pending, paths };
}

function extractJson(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
