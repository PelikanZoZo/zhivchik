// Инструменты Киры: через них она читает и меняет треки, проекты, миссии и всё, что в них живёт,
// ведёт журнал действий, связывает людей, комментирует, оценивает риски и управляет своими заданиями.
// Каждый инструмент — описание для модели (JSON Schema) и функция, которая его выполняет.

import { TYPES } from "../pm/schema.js";
import { parseLocal, localNow, addDays } from "../time.js";

const KIND_ENUM = Object.keys(TYPES);

const itemFields = {
  title: { type: "string", description: "Короткое название. У действия — что сделано" },
  body: { type: "string", description: "Описание, подробности" },
  parent_id: { type: ["integer", "null"], description: "id дома: трека, проекта, миссии (для подзадачи — задачи). null — без дома" },
  stage_id: { type: ["integer", "null"], description: "id стадии проекта/трека, к которой относится" },
  status: { type: "string", description: "Статус — из списка статусов этого вида (см. модель в системном сообщении)" },
  priority: { type: "integer", minimum: 0, maximum: 3, description: "0 — нет, 1 — низкий, 2 — средний, 3 — высокий" },
  due: { type: ["string", "null"], description: "Срок/дедлайн, местное время: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ. null — без срока" },
  event_at: { type: "string", description: "Для действия — когда сделано; для блокера — с какого числа мешает. ГГГГ-ММ-ДД ЧЧ:ММ" },
  tags: { type: "array", items: { type: "string" }, description: "Метки без #" },
  fields: { type: "object", description: "Поля конкретного вида: risk {probability, impact, mitigation} (оценка владельца 1–5, ставь её только со слов владельца); goal {goal_type: milestone|final, unit, baseline, target, current}; action {result}; blocker {waiting_for}; mission {outcome}; attachment {url}; person {company, position, phone, email, telegram}" },
};

function fn(name, description, properties, required = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const TOOL_DEFS = [
  fn("get_agenda", "Сводка: просроченное, на сегодня, ближайшие дни, важное без срока, в работе, вехи со сроком, активные блокеры, высокие риски, миссии в работе. Для плана на день и вопросов «что у меня».", {
    days: { type: "integer", description: "На сколько дней вперёд смотреть (по умолчанию 3)" },
  }),
  fn("find", "Найти объекты по фильтрам. Без фильтра по статусу — только открытые.", {
    kind: { type: "string", enum: KIND_ENUM },
    parent_id: { type: "integer", description: "Только внутри этого объекта (прямые потомки)" },
    stage_id: { type: "integer" },
    query: { type: "string", description: "Слова из названия, описания, полей" },
    status: { type: "string" },
    include_closed: { type: "boolean", description: "Показать и закрытые" },
    due_until: { type: "string", description: "Срок не позже (ГГГГ-ММ-ДД)" },
    limit: { type: "integer", description: "По умолчанию 50" },
  }),
  fn("get_item", "Полная карточка объекта: описание, поля, где живёт, стадия, всё внутри (по разделам), люди и связи, комментарии, что его блокирует.", {
    id: { type: "integer" },
  }, ["id"]),
  fn("create_item", "Создать объект любого вида. Задачи, риски, блокеры, памятки, вложения, действия — внутри трека/проекта/миссии (parent_id). Стадии и цели — только внутри проекта или трека.", {
    kind: { type: "string", enum: KIND_ENUM },
    ...itemFields,
  }, ["kind", "title"]),
  fn("update_item", "Изменить объект. Передавай только то, что меняется (поля вида — в fields, частично). Закрыть задачу — status=done; снять блокер — status=resolved; сделать стадию текущей — status=active.", {
    id: { type: "integer" },
    kind: { type: "string", enum: KIND_ENUM, description: "Сменить вид" },
    ...itemFields,
  }, ["id"]),
  fn("log_action", "Записать в журнал действие владельца: что сделал, когда, какой результат, с кем. Используй, когда владелец рассказывает о сделанном («позвонил…», «встретился…», «отправил…»).", {
    parent_id: { type: "integer", description: "К чему относится: задача, миссия, проект или трек" },
    title: { type: "string", description: "Что сделано" },
    result: { type: "string", description: "Какой результат" },
    event_at: { type: "string", description: "Когда (по умолчанию — сейчас), ГГГГ-ММ-ДД ЧЧ:ММ" },
    people: { type: "array", items: { type: "string" }, description: "С кем — имена людей" },
    close_task: { type: "boolean", description: "Если parent — задача и этим действием она сделана" },
  }, ["title"]),
  fn("link_person", "Связать человека с объектом и указать роль (ЛПР, контакт, ответственный, участник, ждём от него, эксперт или своя). Если такого человека в справочнике нет — создаётся.", {
    item_id: { type: "integer" },
    person_id: { type: "integer", description: "Если человек уже есть" },
    name: { type: "string", description: "Имя, если person_id неизвестен" },
    role: { type: "string" },
    company: { type: "string" },
    position: { type: "string" },
  }, ["item_id", "role"]),
  fn("link_items", "Связать два объекта: role=blocks — первый (блокер) блокирует второй; role=related — просто связаны.", {
    a_id: { type: "integer" }, b_id: { type: "integer" }, role: { type: "string" },
  }, ["a_id", "b_id"]),
  fn("unlink", "Убрать связь (link_id из карточки объекта).", { link_id: { type: "integer" } }, ["link_id"]),
  fn("add_comment", "Добавить комментарий к объекту от своего имени.", { id: { type: "integer" }, text: { type: "string" } }, ["id", "text"]),
  fn("assess_risk", "Оценить риск своей оценкой (вероятность, влияние, комментарий) прямо сейчас. Новые и изменённые риски оцениваются и автоматически.", { id: { type: "integer" } }, ["id"]),
  fn("delete_item", "Удалить объект (вместе с вложенными). Обратимо. Только по явной просьбе.", { id: { type: "integer" } }, ["id"]),
  fn("restore_item", "Вернуть удалённый объект.", { id: { type: "integer" } }, ["id"]),
  fn("get_history", "История изменений объекта.", { id: { type: "integer" } }, ["id"]),
  fn("recent_changes", "Что менялось за последние дни — во всей системе или внутри одного объекта.", {
    days: { type: "integer", description: "По умолчанию 1" },
    root_id: { type: "integer", description: "Только внутри этого трека/проекта/миссии" },
  }),
];

const jobFields = {
  title: { type: "string", description: "Что сделать — коротко. Для напоминания это текст напоминания" },
  instruction: { type: "string", description: "Подробная инструкция самой себе: что проверить, что сделать, когда и что написать владельцу" },
  action: { type: "string", enum: ["remind", "do"], description: "remind — просто отправить владельцу напоминание (title + instruction) без размышлений; do — выполнить: подумать, посмотреть данные, действовать инструментами" },
  run_at: { type: "string", description: "Разово: когда выполнить, местное время ГГГГ-ММ-ДД ЧЧ:ММ. Для интервала — когда первый раз" },
  cron: { type: "string", description: "Регулярно: расписание cron по местному времени, 5 полей «минута час день месяц день_недели» (0 или 7 — вс, 1 — пн). Примеры: «0 9 * * *» — каждый день в 9:00; «0 18 * * 5» — по пятницам в 18:00; «0 10 * * 1-5» — по будням в 10:00; «0 12 1 * *» — 1-го числа в 12:00" },
  every_minutes: { type: "integer", description: "Регулярно с интервалом в минутах (не меньше 5). Например 120 — каждые 2 часа" },
  until: { type: "string", description: "Для регулярных: до какой даты (ГГГГ-ММ-ДД) включительно" },
  max_runs: { type: "integer", description: "Для регулярных: сколько раз максимум" },
  links: { type: "array", items: { type: "integer" }, description: "id связанных задач, проектов, целей, заметок" },
};

export const JOB_TOOL_DEFS = [
  fn("create_job", "Поставить себе задание: напомнить владельцу или выполнить что-то в нужное время — разово (run_at) или регулярно (cron / every_minutes). Задания выполняются автоматически, без команды владельца.", {
    ...jobFields,
    created_by: { type: "string", enum: ["owner", "kira"], description: "owner — владелец попросил; kira — ты решила сама" },
  }, ["title", "action"]),
  fn("list_jobs", "Список твоих заданий с расписанием и статусами.", {
    status: { type: "string", enum: ["active", "done", "cancelled", "all"], description: "По умолчанию active" },
  }),
  fn("get_job", "Подробно о задании и его последних запусках.", { id: { type: "integer" } }, ["id"]),
  fn("update_job", "Изменить задание: расписание, текст, связи. Отменить — status=cancelled, вернуть — status=active, закрыть — status=done.", {
    id: { type: "integer" },
    ...jobFields,
    status: { type: "string", enum: ["active", "done", "cancelled"] },
  }, ["id"]),
];

// Интернет: поиск и чтение страниц — в разговоре и при выполнении заданий
export const WEB_TOOL_DEFS = [
  fn("web_search", "Поиск в интернете: новости, компании, люди, события, цены, документация — всё, чего нет в системе владельца. Возвращает заголовки, ссылки и фрагменты. Чтобы узнать подробности, открой нужные ссылки через read_page.", {
    query: { type: "string", description: "Поисковый запрос, как в поисковике: 2–8 ключевых слов. Для свежего добавь год или «новости»" },
    limit: { type: "integer", description: "Сколько результатов, по умолчанию 6 (до 10)" },
  }, ["query"]),
  fn("read_page", "Открыть страницу по ссылке и прочитать её текст (без меню и рекламы, первые ~9000 знаков).", {
    url: { type: "string", description: "Полная ссылка http(s)" },
  }, ["url"]),
];
const WEB_LIMITS = { searches: 6, pages: 6 };

// Хранилище файлов и архив переписки
export const FILE_TOOL_DEFS = [
  fn("find_files", "Найти файлы в хранилище: документы, голосовые, аудио, фото, видео, которые владелец присылал или загружал. Ищет по названию, подписи, описанию, ключевым словам и тексту (для голосовых — по расшифровке).", {
    query: { type: "string", description: "Что искать: слова из названия или содержания («договор Альфа-Строй», «смета пилот»). Пусто — последние файлы" },
    kind: { type: "string", enum: ["document", "voice", "audio", "photo", "video", "other"], description: "Только этого вида" },
    from: { type: "string", description: "Присланы не раньше (ГГГГ-ММ-ДД)" },
    to: { type: "string", description: "Присланы не позже (ГГГГ-ММ-ДД)" },
    limit: { type: "integer", description: "По умолчанию 8" },
  }),
  fn("read_file", "Прочитать текст файла из хранилища (документ или расшифровку голосового) — кусками по ~12000 знаков.", {
    id: { type: "integer" },
    offset: { type: "integer", description: "С какого знака читать (для продолжения — значение next_offset)" },
  }, ["id"]),
  fn("send_file", "Прислать владельцу файл из хранилища в Telegram (сам документ, голосовое и т.п.).", {
    id: { type: "integer" },
    caption: { type: "string", description: "Короткая подпись к файлу (необязательно)" },
  }, ["id"]),
  fn("attach_file", "Прикрепить файл из хранилища к треку, проекту, миссии или задаче (как вложение). ТОЛЬКО по прямой просьбе владельца.", {
    id: { type: "integer", description: "id файла в хранилище" },
    parent_id: { type: "integer", description: "id объекта, куда приложить" },
  }, ["id", "parent_id"]),
  fn("rename_file", "Переименовать файл в хранилище. Только по просьбе владельца.", {
    id: { type: "integer" },
    name: { type: "string" },
  }, ["id", "name"]),
  fn("catalog_find", "Каталог документов — реестр всех файлов системы. Поиск по названию, описанию документа и откуда он (от кого переслан, из какого чата, сайт, вложение объекта); у записей — и по сути. Возвращает дату, описание, источник и к чему прикреплён.", {
    query: { type: "string", description: "Слова из названия, описания или имени отправителя. Пусто — последние документы" },
    kind: { type: "string", enum: ["document", "voice", "audio", "photo", "video", "other"] },
    origin: { type: "string", enum: ["chat", "forward", "web", "attachment"], description: "chat — прислан тебе в чат; forward — переслан; web — загружен на сайте; attachment — вложение объекта" },
    from: { type: "string", description: "Добавлен не раньше (ГГГГ-ММ-ДД)" },
    to: { type: "string", description: "Добавлен не позже (ГГГГ-ММ-ДД)" },
    limit: { type: "integer", description: "По умолчанию 10" },
  }),
  fn("set_file_description", "Записать или поменять описание документа в каталоге. Только по просьбе владельца.", {
    id: { type: "integer" },
    description: { type: "string" },
  }, ["id", "description"]),
  fn("search_chat_history", "Поиск по всему архиву переписки с владельцем (все сообщения за всё время, и его, и твои). Для вопросов «что я говорил про…», «когда мы обсуждали…».", {
    query: { type: "string", description: "Слова, которые должны быть в сообщении" },
    from: { type: "string", description: "ГГГГ-ММ-ДД" },
    to: { type: "string", description: "ГГГГ-ММ-ДД" },
    limit: { type: "integer", description: "По умолчанию 20" },
  }),
];

const FORGET_DEF = fn("forget_conversation", "Забыть текущий разговор и начать с чистого листа (задачи и задания не трогаются). Только по просьбе владельца: «давай заново», «забудь, о чём говорили».", {});
const RUN_NOW_DEF = fn("run_job_now", "Выполнить задание прямо сейчас, не дожидаясь расписания.", { id: { type: "integer" } }, ["id"]);
const SEND_DEF = fn("send_message", "Отправить сообщение владельцу в Telegram. Единственный способ связаться с ним, пока ты выполняешь задание.", {
  text: { type: "string", description: "Текст сообщения" },
}, ["text"]);

// Набор инструментов: в разговоре с владельцем (chat) и при самостоятельном выполнении задания (job)
export function toolDefs(mode = "chat") {
  return mode === "job"
    ? [...TOOL_DEFS, ...JOB_TOOL_DEFS, ...WEB_TOOL_DEFS, ...FILE_TOOL_DEFS, SEND_DEF]
    : [...TOOL_DEFS, ...JOB_TOOL_DEFS, ...WEB_TOOL_DEFS, ...FILE_TOOL_DEFS, RUN_NOW_DEF, FORGET_DEF];
}

function briefJob(j) {
  const o = { id: j.id, title: j.title, action: j.action, schedule: j.schedule_text, status: j.status, exec_status: j.exec_status };
  if (j.next_run) o.next_run = j.next_run;
  if (j.last_run) o.last_run = j.last_run;
  if (j.links.length) o.links = j.links.map((l) => `#${l.id} ${l.title || ""}`.trim());
  if (j.system) o.system = true;
  return o;
}

// Компактный вид объекта для модели
function brief(item) {
  const o = { id: item.id, kind: item.kind, title: item.title, status: item.status };
  if (item.priority) o.priority = item.priority;
  if (item.due) o.due = item.due;
  if (item.overdue) o.overdue = true;
  if (item.event_at) o.event_at = item.event_at;
  if (item.tags?.length) o.tags = item.tags;
  if (item.stage_id) o.stage_id = item.stage_id;
  const f = { ...item.fields };
  for (const k of ["file_key", "ai_for_version"]) delete f[k];
  if (Object.keys(f).length) o.fields = f;
  if (item.risk) o.risk_score = { mine: item.risk.mine, ai: item.risk.ai };
  if (item.parent_id) o.parent_id = item.parent_id;
  if (item.home) o.home = `${item.home.title} (#${item.home.id})`;
  return o;
}

async function briefs(nodes, items) {
  await nodes.withHomes(items);
  return items.map(brief);
}

export function createToolRunner({ nodes, jobs, outbox, deps = {}, tz, source = "ai", mode = "chat", onForget, channel, actions = [] }) {
  let created = 0; // сколько заданий создано за этот разговор/запуск — защита от зацикливания
  const webUsed = { searches: 0, pages: 0 };
  const allowed = new Set(toolDefs(mode).map((t) => t.function.name));
  const run = {
    async get_agenda({ days = 3 } = {}) {
      const a = await nodes.agenda({ days: Math.min(Math.max(+days || 3, 1), 30) });
      const out = { today: a.today };
      for (const [k, v] of Object.entries(a)) if (Array.isArray(v)) out[k] = v.map(brief);
      return out;
    },

    async find({ kind, parent_id, stage_id, query, status, include_closed, due_until, limit = 50 } = {}) {
      const f = { kind, parent_id, stage_id, query, limit: Math.min(+limit || 50, 200) };
      if (status) f.status = status;
      else if (!include_closed) f.open = true;
      if (due_until) {
        const d = parseLocal(`${due_until} 23:59`, tz);
        if (d) f.due_before = d.utc;
      }
      const items = await nodes.list(f);
      return { count: items.length, items: await briefs(nodes, items) };
    },

    async get_item({ id }) {
      const item = await nodes.get(+id, { full: true });
      if (!item) return { error: `Нет записи #${id}` };
      const o = { ...brief(item), body: item.body, created: item.created, updated: item.updated };
      if (item.completed) o.completed = item.completed;
      if (item.deleted) o.deleted = true;
      o.path = item.path.map((p) => `${p.title} (#${p.id})`).join(" → ");
      if (item.stage) o.stage = item.stage;
      const groups = {};
      for (const c of item.children) (groups[c.kind] ||= []).push(brief(c));
      o.inside = groups;
      o.people = item.links.filter((l) => l.kind === "person").map((l) => ({ link_id: l.link_id, id: l.id, name: l.title, role: l.role, ...(l.fields?.company ? { company: l.fields.company } : {}) }));
      o.links = item.links.filter((l) => l.kind !== "person").map((l) => ({ link_id: l.link_id, id: l.id, kind: l.kind, title: l.title, role: l.role, direction: l.direction, closed: l.closed }));
      if (item.blocked_by.length) o.blocked_by = item.blocked_by.map((b) => `${b.title} (#${b.id})`);
      o.comments = item.comments.slice(-10).map((c) => `${c.at} ${c.author === "kira" ? "Кира" : "владелец"}: ${c.text}`);
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

    async log_action({ parent_id, title, result, event_at, people = [], close_task }) {
      const item = await nodes.create({ kind: "action", title, parent_id: parent_id || null, event_at: event_at || undefined, fields: { result: result || null } }, source);
      const linked = [];
      for (const name of people) {
        const p = await findOrCreatePerson(nodes, { name }, source);
        await nodes.link(item.id, p.id, "участник", source);
        linked.push(p.title);
      }
      let closed = null;
      if (close_task && parent_id) {
        const parent = await nodes.get(+parent_id);
        if (parent?.kind === "task" && !parent.closed) { await nodes.update(parent.id, { status: "done" }, source); closed = parent.title; }
      }
      return { logged: brief(item), people: linked, closed_task: closed };
    },

    async link_person({ item_id, person_id, name, role, company, position }) {
      const person = person_id ? await nodes.get(+person_id) : await findOrCreatePerson(nodes, { name, company, position }, source);
      if (!person || person.kind !== "person") return { error: "Человек не найден — укажи person_id или name" };
      const r = await nodes.link(+item_id, person.id, role, source);
      return { linked: `${person.title} — ${role}`, person_id: person.id, link_id: r.id, existed: !!r.existed };
    },

    async link_items({ a_id, b_id, role = "related" }) {
      const r = await nodes.link(+a_id, +b_id, role, source);
      return { link_id: r.id, existed: !!r.existed };
    },

    async unlink({ link_id }) {
      return await nodes.unlink(+link_id, source);
    },

    async add_comment({ id, text }) {
      return await nodes.addComment(+id, text, "kira");
    },

    async assess_risk({ id }) {
      if (!deps.riskAi) return { error: "Оценка рисков недоступна" };
      const r = await deps.riskAi.assess(+id);
      return { assessed: brief(r), comment: r.fields.ai_comment };
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

    async recent_changes({ days = 1, root_id } = {}) {
      const today = localNow(tz).date;
      const since = parseLocal(`${addDays(today, -Math.min(Math.max(+days || 1, 1), 60) + 1)} 00:00`, tz).utc;
      return { changes: await nodes.changes({ since, limit: 150, root: root_id ? +root_id : undefined }) };
    },

    // ---------- задания Киры ----------
    async create_job(args) {
      if (++created > (mode === "job" ? 3 : 10)) return { error: "Слишком много заданий за один раз" };
      const by = mode === "job" ? "kira" : args.created_by === "kira" ? "kira" : "owner";
      if (args.action === "remind" && !args.run_at && !args.cron && !args.every_minutes) return { error: "Укажи run_at, cron или every_minutes" };
      const job = await jobs.create({ ...args, created_by: by }, source);
      return { created: briefJob(job) };
    },

    async list_jobs({ status = "active" } = {}) {
      const list = await jobs.list({ status: status === "all" ? undefined : status, limit: 100 });
      return { count: list.length, jobs: list.map(briefJob) };
    },

    async get_job({ id }) {
      const j = await jobs.get(+id);
      if (!j) return { error: `Нет задания #${id}` };
      const runs = await jobs.runs(+id, 5);
      return {
        ...briefJob(j), instruction: j.instruction, created: j.created, created_by: j.created_by, run_count: j.run_count,
        last_result: j.last_result?.slice(0, 1500),
        runs: runs.map((r) => ({ started: r.started, status: r.status, result: r.result?.slice(0, 500) })),
      };
    },

    async update_job({ id, ...patch }) {
      const j = await jobs.get(+id);
      if (!j) return { error: `Нет задания #${id}` };
      if (j.system && (patch.action || patch.instruction)) return { error: "У системного задания можно менять только расписание и статус" };
      return { updated: briefJob(await jobs.update(+id, patch, source)) };
    },

    async run_job_now({ id }) {
      if (!deps.runner) return { error: "Планировщик недоступен" };
      const r = await deps.runner.runNow(+id);
      return { status: r.status, result: r.result?.slice(0, 1500), error: r.error };
    },

    async forget_conversation() {
      if (!onForget) return { error: "Недоступно" };
      await onForget();
      return { ok: true, note: "Разговор забыт. Задачи и задания на месте." };
    },

    async web_search({ query, limit }) {
      if (!deps.web) return { error: "Поиск в интернете не подключён" };
      if (++webUsed.searches > WEB_LIMITS.searches) return { error: "Хватит поисков на один ответ — отвечай по тому, что уже нашла" };
      try {
        const r = await deps.web.search(query, { limit });
        if (!r.results.length) return { query, results: [], note: "Ничего не нашлось — попробуй другие слова" };
        return { query, results: r.results };
      } catch (e) {
        return { error: e.message };
      }
    },

    async read_page({ url }) {
      if (!deps.web) return { error: "Чтение страниц не подключено" };
      if (++webUsed.pages > WEB_LIMITS.pages) return { error: "Хватит страниц на один ответ — отвечай по тому, что уже прочитала" };
      try {
        return await deps.web.read(url);
      } catch (e) {
        return { error: `${url}: ${e.message}` };
      }
    },

    async find_files({ query, kind, from, to, limit = 8 } = {}) {
      if (!deps.storage) return { error: "Хранилище недоступно" };
      const list = await deps.storage.search({ query, kind, from, to, limit: Math.min(+limit || 8, 30) });
      return {
        count: list.length,
        files: list.map((f) => ({
          id: f.id, name: f.name, kind: f.kind, created: f.created,
          ...(f.duration ? { duration_sec: f.duration } : {}), ...(f.pages ? { pages: f.pages } : {}),
          summary: f.summary, caption: f.caption || undefined, snippet: f.snippet || undefined,
          ...(f.text_status !== "ok" ? { text: f.text_status_text } : {}),
        })),
      };
    },

    async read_file({ id, offset = 0 }) {
      if (!deps.storage) return { error: "Хранилище недоступно" };
      const r = await deps.storage.readText(+id, { offset });
      if (!r) return { error: `Нет файла #${id}` };
      if (!r.total_chars) return { id: r.id, name: r.name, kind: r.kind, summary: r.summary, error: `Текста нет: ${r.text_note || r.text_status_text}` };
      return { id: r.id, name: r.name, kind: r.kind, summary: r.summary, text: r.text, total_chars: r.total_chars, ...(r.more ? { next_offset: r.offset + r.text.length } : {}) };
    },

    async send_file({ id, caption = "" }) {
      if (!deps.storage) return { error: "Хранилище недоступно" };
      const f = await deps.storage.row(+id);
      if (!f || f.deleted_at) return { error: `Нет файла #${id}` };
      if (!f.tg_file_id && !f.file_key) return { error: "Файл не сохранился на диске, прислать не могу" };
      if (actions.filter((a) => a.file_id).length >= 5) return { error: "Не больше 5 файлов за один ответ" };
      if (mode === "chat" && channel === "telegram") {
        actions.push({ file_id: f.id, caption });
        return { ok: true, note: "Файл уйдёт следом за твоим ответом" };
      }
      const r = await outbox.sendFile(f, caption);
      return r.sent ? { ok: true, note: "Файл отправлен в Telegram" } : { error: r.reason };
    },

    async attach_file({ id, parent_id }) {
      if (!deps.storage) return { error: "Хранилище недоступно" };
      const f = await deps.storage.row(+id);
      if (!f || f.deleted_at) return { error: `Нет файла #${id}` };
      if (!f.file_key) return { error: "Файл есть только в Telegram, на диске его нет — приложить не могу" };
      const parent = await nodes.get(+parent_id);
      if (!parent) return { error: `Нет записи #${parent_id}` };
      const already = ((await deps.storage.attachedMap([f.id]))[f.id] || []).find((a) => a.id === parent.id);
      if (already) return { ok: true, note: `Уже прикреплён к «${parent.title}»` };
      const item = await nodes.create({
        kind: "attachment", title: f.name, parent_id: parent.id, body: f.description || f.summary || null,
        fields: { file_name: f.name, file_size: Number(f.size), file_type: f.mime || "", file_key: f.file_key, storage_id: f.id },
        allowSystemFields: true,
      }, source);
      return { ok: true, attachment: brief(item), home: `${parent.title} (#${parent.id})` };
    },

    async rename_file({ id, name }) {
      if (!deps.storage) return { error: "Хранилище недоступно" };
      const f = await deps.storage.rename(+id, name).catch((e) => ({ error: e.message }));
      return f?.error ? f : f ? { ok: true, id: f.id, name: f.name } : { error: `Нет файла #${id}` };
    },

    async catalog_find({ query, kind, origin, from, to, limit = 10 } = {}) {
      if (!deps.storage) return { error: "Каталог недоступен" };
      const list = await deps.storage.catalog({ query, kind, origin, from, to, limit: Math.min(+limit || 10, 40) });
      return {
        count: list.length,
        documents: list.map((d) => ({
          id: d.id, name: d.name, kind: d.kind, added: d.created, ...(d.original ? { original_date: d.original } : {}),
          origin: d.origin, ...(d.description ? { description: d.description.slice(0, 400) } : {}),
          ...(d.summary ? { summary: d.summary } : {}), ...(d.duration ? { duration_sec: d.duration } : {}),
          ...(d.attached_to.length ? { attached_to: d.attached_to.map((a) => `${a.title} (#${a.id})`) } : {}),
        })),
      };
    },

    async set_file_description({ id, description }) {
      if (!deps.storage) return { error: "Каталог недоступен" };
      const f = await deps.storage.update(+id, { description });
      return f ? { ok: true, id: f.id, name: f.name, description: f.description } : { error: `Нет документа #${id}` };
    },

    async search_chat_history({ query, from, to, limit = 20 } = {}) {
      if (!deps.dwh) return { error: "Архив переписки недоступен" };
      const list = await deps.dwh.list({ query, from, to, limit: Math.min(+limit || 20, 60) });
      return {
        count: list.length,
        messages: list.reverse().map((m) => ({
          at: m.at, who: m.author === "owner" ? "владелец" : "ты", ...(m.type !== "text" ? { type: m.type } : {}),
          text: String(m.text || "").slice(0, 600), ...(m.file_id ? { file_id: m.file_id } : {}),
        })),
      };
    },

    async send_message({ text }) {
      if (!text?.trim()) return { error: "Пустое сообщение" };
      return await outbox.notifyOwner(String(text).trim(), "job");
    },
  };

  return async function runTool(name, args) {
    const f = allowed.has(name) && run[name];
    if (!f) return { error: `Нет такого инструмента: ${name}` };
    try {
      return await f(args || {});
    } catch (e) {
      return { error: e.message };
    }
  };
}

// Человек по имени: найти в справочнике (без учёта регистра) или завести
export async function findOrCreatePerson(nodes, { name, company, position }, source) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Нужно имя человека");
  const found = (await nodes.list({ kind: "person", query: n, limit: 20 })).find((p) => p.title.toLowerCase() === n.toLowerCase());
  if (found) return found;
  const fields = {};
  if (company) fields.company = company;
  if (position) fields.position = position;
  return nodes.create({ kind: "person", title: n, fields }, source);
}
