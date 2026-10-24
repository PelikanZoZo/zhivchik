// Инструменты ассистента: через них он читает и меняет задачи, проекты, цели и заметки.
// Каждый инструмент — описание для модели (JSON Schema) и функция, которая его выполняет.

import { KINDS } from "../nodes.js";
import { parseLocal, localNow, addDays } from "../time.js";

const KIND_ENUM = Object.keys(KINDS);
const ALL_STATUSES = [...new Set(Object.values(KINDS).flatMap((k) => k.statuses))];

const itemFields = {
  title: { type: "string", description: "Короткое название" },
  body: { type: "string", description: "Описание, подробности, заметки" },
  parent_id: { type: ["integer", "null"], description: "id родителя: проекта, цели или задачи (для подзадач). null — без родителя" },
  status: { type: "string", enum: ALL_STATUSES, description: "Статус. Задача: todo, doing, waiting, done, cancelled. Проект: active, paused, done, archived. Цель: active, achieved, dropped. Заметка: active, archived" },
  priority: { type: "integer", minimum: 0, maximum: 3, description: "0 — нет, 1 — низкий, 2 — средний, 3 — высокий" },
  due: { type: ["string", "null"], description: "Срок по местному времени: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ. null — убрать срок" },
  tags: { type: "array", items: { type: "string" }, description: "Метки без #" },
};

function fn(name, description, properties, required = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const TOOL_DEFS = [
  fn("get_agenda", "Сводка дел: просроченные, на сегодня, на ближайшие дни, важные без срока и задачи в работе. Используй для плана на день и вопросов «что у меня».", {
    days: { type: "integer", description: "На сколько дней вперёд смотреть (по умолчанию 3)" },
  }),
  fn("list_items", "Найти записи по фильтрам. Без фильтра по статусу показывает только открытые.", {
    kind: { type: "string", enum: KIND_ENUM, description: "project, task, goal, note" },
    parent_id: { type: "integer", description: "Только дочерние записи этого родителя (например, задачи проекта)" },
    query: { type: "string", description: "Поиск по словам в названии, описании, метках" },
    tag: { type: "string" },
    status: { type: "string", enum: ALL_STATUSES },
    include_closed: { type: "boolean", description: "Показать и закрытые (выполненные, отменённые, архив)" },
    due_until: { type: "string", description: "Срок не позже этой даты (ГГГГ-ММ-ДД)" },
    limit: { type: "integer", description: "Сколько максимум (по умолчанию 50)" },
  }),
  fn("get_item", "Полная информация о записи: описание, путь (в каком проекте), дочерние записи.", {
    id: { type: "integer" },
  }, ["id"]),
  fn("create_item", "Создать запись: задачу, проект, цель или заметку. Для задачи внутри проекта укажи parent_id проекта.", {
    kind: { type: "string", enum: KIND_ENUM },
    ...itemFields,
  }, ["kind", "title"]),
  fn("update_item", "Изменить запись. Передавай только то, что меняется. Выполнить задачу — status=done.", {
    id: { type: "integer" },
    kind: { type: "string", enum: KIND_ENUM, description: "Сменить вид (например, задачу превратить в проект)" },
    ...itemFields,
  }, ["id"]),
  fn("delete_item", "Удалить запись (вместе с вложенными). Удаление обратимо, история сохраняется. Удаляй только по явной просьбе.", {
    id: { type: "integer" },
  }, ["id"]),
  fn("restore_item", "Вернуть удалённую запись.", { id: { type: "integer" } }, ["id"]),
  fn("get_history", "История изменений записи: когда и что менялось.", { id: { type: "integer" } }, ["id"]),
  fn("recent_changes", "Что менялось за последние дни во всей системе (создано, выполнено, перенесено).", {
    days: { type: "integer", description: "За сколько дней (по умолчанию 1)" },
  }),
];

// Компактный вид записи для модели
function brief(item, parents = {}) {
  const o = { id: item.id, kind: item.kind, title: item.title, status: item.status };
  if (item.priority) o.priority = item.priority;
  if (item.due) o.due = item.due;
  if (item.overdue) o.overdue = true;
  if (item.tags?.length) o.tags = item.tags;
  if (item.parent_id) {
    o.parent_id = item.parent_id;
    if (parents[item.parent_id]) o.parent = parents[item.parent_id];
  }
  return o;
}

async function withParents(nodes, items) {
  const ids = [...new Set(items.map((i) => i.parent_id).filter(Boolean))];
  const parents = {};
  for (const id of ids) {
    const p = await nodes.getRow(id);
    if (p) parents[id] = p.title;
  }
  return items.map((i) => brief(i, parents));
}

export function createToolRunner(nodes, tz, source = "ai") {
  const run = {
    async get_agenda({ days = 3 } = {}) {
      const a = await nodes.agenda({ days: Math.min(Math.max(+days || 3, 1), 30) });
      const out = { today: a.today };
      for (const k of ["overdue", "today_tasks", "upcoming", "important_no_date", "in_progress"]) {
        out[k] = await withParents(nodes, a[k]);
      }
      return out;
    },

    async list_items({ kind, parent_id, query, tag, status, include_closed, due_until, limit = 50 } = {}) {
      const f = { kind, parent_id, query, tag, limit: Math.min(+limit || 50, 200) };
      if (status) f.status = status;
      else if (!include_closed) f.open = true;
      if (due_until) {
        const d = parseLocal(`${due_until} 23:59`, tz);
        if (d) f.due_before = d.utc;
      }
      const items = await nodes.list(f);
      return { count: items.length, items: await withParents(nodes, items) };
    },

    async get_item({ id }) {
      const item = await nodes.get(+id, { withChildren: true, withPath: true });
      if (!item) return { error: `Нет записи #${id}` };
      const o = { ...brief(item), body: item.body, created: item.created, updated: item.updated };
      if (item.completed) o.completed = item.completed;
      if (item.deleted) o.deleted = true;
      o.path = item.path.map((p) => `${p.title} (#${p.id})`).join(" → ");
      o.children = item.children.map((c) => brief(c));
      return o;
    },

    async create_item(args) {
      const item = await nodes.create(args, source);
      return { created: brief(item) };
    },

    async update_item({ id, ...patch }) {
      const item = await nodes.update(+id, patch, source);
      return { updated: brief(item) };
    },

    async delete_item({ id }) {
      const item = await nodes.get(+id);
      if (!item) return { error: `Нет записи #${id}` };
      const r = await nodes.remove(+id, source);
      return { deleted: item.title, with_nested: r.deleted - 1 };
    },

    async restore_item({ id }) {
      return { restored: brief(await nodes.restore(+id, source)) };
    },

    async get_history({ id }) {
      return { history: await nodes.history(+id, 30) };
    },

    async recent_changes({ days = 1 } = {}) {
      const today = localNow(tz).date;
      const since = parseLocal(`${addDays(today, -Math.min(Math.max(+days || 1, 1), 60) + 1)} 00:00`, tz).utc;
      return { changes: await nodes.changes({ since, limit: 150 }) };
    },
  };

  return async function runTool(name, args) {
    const f = run[name];
    if (!f) return { error: `Нет такого инструмента: ${name}` };
    try {
      return await f(args || {});
    } catch (e) {
      return { error: e.message };
    }
  };
}
