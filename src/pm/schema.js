// Модель системы управления: какие бывают объекты, их статусы, поля и куда что можно вкладывать.
//
// Основные объекты — трек, проект, миссия. В них живут задачи, действия, риски, блокеры, памятки,
// вложения; у проектов и треков есть стадии и цели (вехи и финальная). Люди — общий справочник,
// с объектами их связывают роли.

export const TYPES = {
  track: {
    label: "Трек", plural: "Треки", core: true,
    about: "постоянное направление без финала (здоровье, развитие компании)",
    statuses: { active: "Идёт", paused: "На паузе", archived: "В архиве" },
    initial: "active", closed: ["archived"],
    parents: [],
    stages: true,
  },
  project: {
    label: "Проект", plural: "Проекты", core: true,
    about: "работа с результатом и сроком",
    statuses: { planned: "Запланирован", active: "Идёт", paused: "На паузе", done: "Завершён", cancelled: "Отменён", archived: "В архиве" },
    initial: "active", closed: ["done", "cancelled", "archived"],
    parents: ["track"],
    stages: true,
  },
  mission: {
    label: "Миссия", plural: "Миссии", core: true,
    about: "целевая операция: подготовка, сбор информации, документы, люди (например, выйти на гендиректора)",
    statuses: { preparing: "Подготовка", active: "В работе", done: "Выполнена", failed: "Провалена", cancelled: "Отменена" },
    initial: "preparing", closed: ["done", "failed", "cancelled"],
    parents: ["project", "track"],
    fields: { outcome: { type: "text", label: "Итог" } },
  },
  stage: {
    label: "Стадия", plural: "Стадии",
    about: "этап проекта или трека; текущая — в статусе active",
    statuses: { planned: "Впереди", active: "Текущая", done: "Пройдена" },
    initial: "planned", closed: ["done"],
    parents: ["project", "track"], parentRequired: true,
  },
  goal: {
    label: "Цель", plural: "Цели",
    about: "промежуточная (веха) или финальная цель проекта/трека; срок необязателен",
    statuses: { open: "В работе", achieved: "Достигнута", missed: "Не достигнута", dropped: "Снята" },
    initial: "open", closed: ["achieved", "missed", "dropped"],
    parents: ["project", "track", "mission"], parentRequired: true,
    fields: {
      goal_type: { type: "enum", values: { milestone: "Веха", final: "Финальная" }, default: "milestone", label: "Тип" },
      unit: { type: "string", label: "Единица" },
      baseline: { type: "number", label: "Было" },
      target: { type: "number", label: "Нужно" },
      current: { type: "number", label: "Сейчас" },
    },
  },
  task: {
    label: "Задача", plural: "Задачи",
    about: "конкретное дело со сроком и статусом; может иметь подзадачи (один уровень)",
    statuses: { todo: "К выполнению", doing: "В работе", waiting: "Ждёт", done: "Сделано", cancelled: "Отменено" },
    initial: "todo", closed: ["done", "cancelled"],
    parents: ["project", "track", "mission", "task"],
  },
  action: {
    label: "Действие", plural: "Действия",
    about: "запись в журнале: что я сделал, когда и какой получил результат",
    statuses: { logged: "Записано" },
    initial: "logged", closed: [],
    parents: ["project", "track", "mission", "task"],
    eventLabel: "Когда",
    fields: { result: { type: "text", label: "Результат" } },
  },
  risk: {
    label: "Риск", plural: "Риски",
    about: "что может пойти не так; моя оценка и оценка ИИ (вероятность и влияние 1–5), меры",
    statuses: { open: "Открыт", watching: "Под контролем", occurred: "Случился", closed: "Снят" },
    initial: "open", closed: ["closed"],
    parents: ["project", "track", "mission", "task"],
    fields: {
      probability: { type: "scale", label: "Вероятность (моя)" },
      impact: { type: "scale", label: "Влияние (моё)" },
      mitigation: { type: "text", label: "Меры" },
      ai_probability: { type: "scale", label: "Вероятность (ИИ)", system: true },
      ai_impact: { type: "scale", label: "Влияние (ИИ)", system: true },
      ai_comment: { type: "text", label: "Комментарий ИИ", system: true },
      ai_assessed_at: { type: "string", label: "Оценено ИИ", system: true },
      ai_for_version: { type: "number", label: "Версия, которую оценил ИИ", system: true },
    },
  },
  blocker: {
    label: "Блокер", plural: "Блокеры",
    about: "что мешает прямо сейчас: чего или кого ждём, с какого числа",
    statuses: { active: "Мешает", resolved: "Снят" },
    initial: "active", closed: ["resolved"],
    parents: ["project", "track", "mission", "task"],
    eventLabel: "С какого числа",
    fields: { waiting_for: { type: "string", label: "Чего или кого ждём" } },
  },
  memo: {
    label: "Памятка", plural: "Памятки",
    about: "заметка, договорённость, важная информация",
    statuses: { active: "Актуальна", archived: "В архиве" },
    initial: "active", closed: ["archived"],
    parents: ["project", "track", "mission", "task"],
  },
  attachment: {
    label: "Вложение", plural: "Вложения",
    about: "файл или ссылка",
    statuses: { active: "Актуально", archived: "В архиве" },
    initial: "active", closed: ["archived"],
    parents: ["project", "track", "mission", "task"],
    fields: {
      url: { type: "string", label: "Ссылка" },
      file_name: { type: "string", label: "Файл", system: true },
      file_size: { type: "number", label: "Размер", system: true },
      file_type: { type: "string", label: "Тип файла", system: true },
      file_key: { type: "string", label: "Где лежит", system: true },
      storage_id: { type: "number", label: "Файл в хранилище", system: true },
    },
  },
  person: {
    label: "Человек", plural: "Люди",
    about: "общий справочник людей; с объектами связывается ролью",
    statuses: { active: "Актуален", archived: "В архиве" },
    initial: "active", closed: ["archived"],
    parents: [],
    fields: {
      company: { type: "string", label: "Компания" },
      position: { type: "string", label: "Должность" },
      phone: { type: "string", label: "Телефон" },
      email: { type: "string", label: "Почта" },
      telegram: { type: "string", label: "Telegram" },
    },
  },
};

export const CORE = Object.keys(TYPES).filter((t) => TYPES[t].core);
// Что показываем внутри основного объекта, по разделам
export const SECTIONS = ["stage", "goal", "mission", "project", "task", "blocker", "risk", "action", "memo", "attachment"];

// Роли людей в объектах (свободный текст тоже можно)
export const PERSON_ROLES = ["ЛПР", "контакт", "ответственный", "участник", "ждём от него", "эксперт"];
// Особые связи между объектами
export const LINK_ROLES = { blocks: "блокирует", related: "связано", participant: "участник" };

export function closedStatuses() {
  return [...new Set(Object.values(TYPES).flatMap((t) => t.closed))];
}

export function isClosed(kind, status) {
  return !!TYPES[kind]?.closed.includes(status);
}

export function riskScore(p, i) {
  return p && i ? p * i : null;
}

export function riskLevel(score) {
  if (!score) return null;
  if (score >= 15) return "high";
  if (score >= 8) return "medium";
  return "low";
}

// Краткое описание модели для Киры
export function describeForAi() {
  return Object.entries(TYPES).map(([k, t]) => {
    const st = Object.keys(t.statuses).join("/");
    const par = t.parents.length ? `внутри: ${t.parents.join(", ")}` : "сам по себе";
    const f = t.fields ? `; поля: ${Object.entries(t.fields).filter(([, d]) => !d.system).map(([n, d]) => (d.type === "enum" ? `${n} (${Object.keys(d.values).join("|")})` : d.type === "scale" ? `${n} (1–5)` : n)).join(", ")}` : "";
    return `- ${k} — ${t.label}: ${t.about}. Статусы ${st}; ${par}${t.eventLabel ? `; event_at — ${t.eventLabel.toLowerCase()}` : ""}${f}`;
  }).join("\n");
}
