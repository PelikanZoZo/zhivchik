// База MySQL. Таблицы создаются и обновляются сами при запуске (миграции по номерам).
//
// Главная идея: всё хранится во времени. Ничего не перезаписывается без следа —
// каждое изменение записи (задачи, проекта, цели…) сохраняет полный снимок в node_history.
// Поэтому всегда можно посмотреть, какой была задача неделю назад и что с ней происходило.

import mysql from "mysql2/promise";

const MIGRATIONS = [
  // 1. Ядро
  [
    // Узлы — всё, из чего состоит система: проекты, задачи, цели, заметки, сценарии.
    // Дерево через parent_id: проект → задачи → подзадачи, цель → шаги, сценарий → ветки.
    `CREATE TABLE nodes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(20) NOT NULL,
      parent_id BIGINT NULL,
      title VARCHAR(500) NOT NULL,
      body MEDIUMTEXT NULL,
      status VARCHAR(20) NOT NULL,
      priority TINYINT NOT NULL DEFAULT 0,
      due_at DATETIME NULL,
      due_has_time TINYINT NOT NULL DEFAULT 0,
      tags VARCHAR(500) NOT NULL DEFAULT '',
      meta MEDIUMTEXT NULL,
      position INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      completed_at DATETIME(3) NULL,
      deleted_at DATETIME(3) NULL,
      INDEX (kind, status), INDEX (parent_id), INDEX (due_at), INDEX (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // История: снимок узла после каждого изменения и что именно поменялось
    `CREATE TABLE node_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      node_id BIGINT NOT NULL,
      version INT NOT NULL,
      action VARCHAR(20) NOT NULL,
      source VARCHAR(20) NOT NULL,
      changed_at DATETIME(3) NOT NULL,
      diff MEDIUMTEXT NULL,
      snapshot MEDIUMTEXT NOT NULL,
      INDEX (node_id, version), INDEX (changed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // Переписка с ассистентом (из Telegram и с сайта)
    `CREATE TABLE messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel VARCHAR(20) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      meta MEDIUMTEXT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX (channel, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // Уже обработанные сообщения Telegram — чтобы повтор не выполнился дважды
    `CREATE TABLE tg_updates (
      update_id BIGINT PRIMARY KEY,
      received_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB`,
    // Очередь сообщений, которые бот должен отправить сам (утренний план, напоминания)
    `CREATE TABLE outbox (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text MEDIUMTEXT NOT NULL,
      kind VARCHAR(30) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      sent_at DATETIME(3) NULL,
      INDEX (sent_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // Отметки о запусках задач по расписанию: одна строка = один запуск (защита от двойного)
    `CREATE TABLE job_runs (
      job VARCHAR(50) NOT NULL,
      run_key VARCHAR(50) NOT NULL,
      started_at DATETIME(3) NOT NULL,
      PRIMARY KEY (job, run_key)
    ) ENGINE=InnoDB`,
    // Настройки и состояние: владелец бота, время утреннего плана и т.п.
    `CREATE TABLE kv (
      k VARCHAR(100) PRIMARY KEY,
      v MEDIUMTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  // 2. Задания Киры: что ей сделать, когда, разово или регулярно, и история каждого запуска
  [
    `CREATE TABLE jobs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(300) NOT NULL,
      instruction MEDIUMTEXT NULL,
      action VARCHAR(20) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      created_by VARCHAR(20) NOT NULL,
      schedule VARCHAR(20) NOT NULL,
      run_at DATETIME NULL,
      cron VARCHAR(100) NULL,
      interval_min INT NULL,
      until_at DATETIME NULL,
      max_runs INT NULL,
      next_run_at DATETIME NULL,
      last_run_at DATETIME(3) NULL,
      run_count INT NOT NULL DEFAULT 0,
      fail_streak INT NOT NULL DEFAULT 0,
      exec_status VARCHAR(20) NOT NULL,
      last_result MEDIUMTEXT NULL,
      status VARCHAR(20) NOT NULL,
      links VARCHAR(500) NOT NULL DEFAULT '',
      system_key VARCHAR(50) NULL,
      lock_until DATETIME(3) NULL,
      version INT NOT NULL DEFAULT 1,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY (system_key), INDEX (status, next_run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE job_runs_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      job_id BIGINT NOT NULL,
      planned_at DATETIME NULL,
      started_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      status VARCHAR(20) NOT NULL,
      result MEDIUMTEXT NULL,
      meta MEDIUMTEXT NULL,
      INDEX (job_id, id), INDEX (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE job_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      job_id BIGINT NOT NULL,
      version INT NOT NULL,
      action VARCHAR(20) NOT NULL,
      source VARCHAR(20) NOT NULL,
      changed_at DATETIME(3) NOT NULL,
      diff MEDIUMTEXT NULL,
      snapshot MEDIUMTEXT NOT NULL,
      INDEX (job_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  // 3. Система управления: стадии, дата события (действия, блокеры), связи с ролями, комментарии
  [
    "ALTER TABLE nodes ADD COLUMN stage_id BIGINT NULL AFTER parent_id, ADD COLUMN event_at DATETIME(3) NULL AFTER due_has_time, ADD INDEX (stage_id), ADD INDEX (event_at)",
    "UPDATE nodes SET kind = 'memo' WHERE kind = 'note'",
    "UPDATE nodes SET status = 'open' WHERE kind = 'goal' AND status = 'active'",
    "UPDATE nodes SET status = 'dropped' WHERE kind = 'goal' AND status NOT IN ('open', 'achieved', 'missed', 'dropped')",
    "UPDATE nodes SET meta = '{\"goal_type\":\"milestone\"}' WHERE kind = 'goal' AND (meta IS NULL OR meta = '')",
    // Связи между объектами: «объект — роль — человек», «блокер — блокирует — задача», «связано»
    `CREATE TABLE node_links (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      a_id BIGINT NOT NULL,
      b_id BIGINT NOT NULL,
      role VARCHAR(60) NOT NULL,
      note VARCHAR(500) NULL,
      created_at DATETIME(3) NOT NULL,
      removed_at DATETIME(3) NULL,
      INDEX (a_id), INDEX (b_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE node_comments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      node_id BIGINT NOT NULL,
      author VARCHAR(20) NOT NULL,
      text MEDIUMTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      deleted_at DATETIME(3) NULL,
      INDEX (node_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  // 4. (была контактная книжка) поле «откуда связь» — оставлено, чтобы схема совпадала с уже обновлёнными базами
  [
    "ALTER TABLE node_links ADD COLUMN origin VARCHAR(10) NOT NULL DEFAULT 'owner' AFTER note",
  ],
  // 5. Контактная книжка удалена: стираем лояльность, комментарии об отношениях и модели ИИ —
  //    и в текущих записях, и в истории изменений; связи между людьми, построенные ИИ, удаляем совсем
  [
    "DELETE FROM node_links WHERE origin = 'ai'",
    purgeContactBook,
  ],
  // 6. Хранилище файлов (документы, голосовые, фото — из Telegram и с сайта) и DWH:
  //    полный архив переписки с Кирой. Файлы для отправки из очереди — outbox.payload.
  [
    `CREATE TABLE storage_files (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      mime VARCHAR(100) NOT NULL DEFAULT '',
      kind VARCHAR(20) NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      sha256 CHAR(64) NULL,
      file_key VARCHAR(100) NULL,
      source VARCHAR(20) NOT NULL,
      tg_type VARCHAR(20) NULL,
      tg_file_id VARCHAR(255) NULL,
      tg_unique_id VARCHAR(100) NULL,
      tg_message_id BIGINT NULL,
      duration_sec INT NULL,
      caption MEDIUMTEXT NULL,
      text MEDIUMTEXT NULL,
      text_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      text_note VARCHAR(300) NULL,
      pages INT NULL,
      summary TEXT NULL,
      keywords VARCHAR(500) NULL,
      described_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      deleted_at DATETIME(3) NULL,
      INDEX (created_at), INDEX (kind, created_at), INDEX (sha256), INDEX (tg_unique_id),
      FULLTEXT KEY ft_files (name, caption, summary, keywords, text)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE dwh_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      at DATETIME(3) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      direction VARCHAR(3) NOT NULL,
      author VARCHAR(20) NOT NULL,
      msg_type VARCHAR(20) NOT NULL,
      text MEDIUMTEXT NULL,
      file_id BIGINT NULL,
      job_id BIGINT NULL,
      tg_chat_id BIGINT NULL,
      tg_message_id BIGINT NULL,
      meta MEDIUMTEXT NULL,
      INDEX (at), INDEX (file_id), INDEX (channel, at),
      FULLTEXT KEY ft_text (text)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // вся прежняя переписка — в архив
    `INSERT INTO dwh_messages (at, channel, direction, author, msg_type, text, meta)
       SELECT created_at, channel, IF(role = 'user', 'in', 'out'), IF(role = 'user', 'owner', 'kira'),
              IF(role = 'assistant' AND meta LIKE '%proactive%', 'proactive', 'text'), content, meta
       FROM messages WHERE role IN ('user', 'assistant') ORDER BY id`,
    "ALTER TABLE outbox ADD COLUMN payload MEDIUMTEXT NULL AFTER text",
  ],
  // 7. Каталог документов — общий реестр всех файлов системы (файлы хранилища и вложения объектов, без дублей).
  //    У документа: описание (текст сообщения, с которым он пришёл; можно править), откуда он
  //    (чат с Кирой, пересылка — от кого или из какого чата, сайт, вложение объекта), исходная дата пересылки.
  [
    `ALTER TABLE storage_files
       ADD COLUMN description TEXT NULL AFTER name,
       ADD COLUMN origin_type VARCHAR(20) NOT NULL DEFAULT 'chat' AFTER source,
       ADD COLUMN origin VARCHAR(300) NULL AFTER origin_type,
       ADD COLUMN original_at DATETIME NULL AFTER origin`,
    "UPDATE storage_files SET description = caption WHERE caption IS NOT NULL AND caption <> ''",
    "UPDATE storage_files SET origin_type = IF(source = 'web', 'web', 'chat'), origin = IF(source = 'web', 'Загружено на сайте', 'Чат с Кирой')",
    attachmentsToCatalog,
  ],
  // 8. Кира не читает документы: убираем извлечённый текст документов и описания, которые ИИ сделал по нему.
  //    Расшифровки и суть голосовых и аудио остаются.
  [
    // описание вложения, которое Кира заполнила по содержимому документа, — тоже убрать
    `UPDATE nodes n JOIN storage_files f ON f.id = JSON_EXTRACT(n.meta, '$.storage_id')
       SET n.body = NULL WHERE n.kind = 'attachment' AND f.kind NOT IN ('voice', 'audio', 'video') AND f.summary IS NOT NULL AND n.body = f.summary`,
    `UPDATE storage_files SET text = NULL, summary = NULL, keywords = NULL, pages = NULL, described_at = NULL, text_status = 'none', text_note = NULL
       WHERE kind NOT IN ('voice', 'audio', 'video')`,
  ],
  // 9. Напоминание: отдельный текст, который получит владелец (инструкция — служебная, для Киры)
  [
    async (conn) => {
      const [cols] = await conn.query("SHOW COLUMNS FROM jobs LIKE 'message'");
      if (!cols.length) await conn.query("ALTER TABLE jobs ADD COLUMN message VARCHAR(1000) NULL AFTER instruction");
    },
  ],
];

// Файлы, приложенные к объектам до появления каталога, — в реестр (сам файл не копируется)
async function attachmentsToCatalog(conn) {
  const [rows] = await conn.query(
    "SELECT n.id, n.title, n.parent_id, n.meta, n.created_at, p.title AS parent_title FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id WHERE n.kind = 'attachment'",
  );
  for (const r of rows) {
    let m;
    try { m = JSON.parse(r.meta || "{}"); } catch { continue; }
    if (!m || !m.file_key || m.storage_id) continue;
    const mime = String(m.file_type || "");
    const kind = /^audio\//.test(mime) ? "audio" : /^image\//.test(mime) ? "photo" : /^video\//.test(mime) ? "video" : "document";
    const [ins] = await conn.query(
      `INSERT INTO storage_files (name, mime, kind, size, file_key, source, origin_type, origin, text_status, text_note, created_at)
       VALUES (?, ?, ?, ?, ?, 'web', 'attachment', ?, 'pending', NULL, ?)`,
      [String(m.file_name || r.title || "файл").slice(0, 255), mime.slice(0, 100), kind, +m.file_size || 0, m.file_key,
        `Вложение: ${String(r.parent_title || "#" + r.parent_id).slice(0, 250)}`, r.created_at],
    );
    m.storage_id = ins.insertId;
    await conn.query("UPDATE nodes SET meta = ? WHERE id = ?", [JSON.stringify(m), r.id]);
  }
}

const CONTACT_KEYS = ["loyalty", "relation", "ai_summary", "ai_influence", "ai_approach", "ai_assessed_at", "ai_for_version"];

async function purgeContactBook(conn) {
  const clean = (metaStr) => {
    if (!metaStr) return metaStr;
    let m;
    try { m = typeof metaStr === "string" ? JSON.parse(metaStr) : metaStr; } catch { return metaStr; }
    if (!m || typeof m !== "object") return metaStr;
    for (const k of CONTACT_KEYS) delete m[k];
    return JSON.stringify(m);
  };
  const [people] = await conn.query("SELECT id, meta FROM nodes WHERE kind = 'person'");
  for (const p of people) {
    const meta = clean(p.meta);
    if (meta !== p.meta) await conn.query("UPDATE nodes SET meta = ? WHERE id = ?", [meta, p.id]);
  }
  const ids = people.map((p) => p.id);
  if (!ids.length) return;
  const [hist] = await conn.query(`SELECT id, diff, snapshot FROM node_history WHERE node_id IN (${ids.map(() => "?").join(",")})`, ids);
  for (const h of hist) {
    let snap = h.snapshot;
    try {
      const s = JSON.parse(h.snapshot);
      s.meta = clean(s.meta);
      snap = JSON.stringify(s);
    } catch {}
    let diff = h.diff;
    if (diff) {
      try {
        const d = JSON.parse(diff);
        for (const k of Object.keys(d)) if (CONTACT_KEYS.some((c) => k === `fields.${c}`)) delete d[k];
        if (d.meta) d.meta = d.meta.map(clean);
        diff = Object.keys(d).length ? JSON.stringify(d) : null;
      } catch {}
    }
    if (snap !== h.snapshot || diff !== h.diff) await conn.query("UPDATE node_history SET snapshot = ?, diff = ? WHERE id = ?", [snap, diff, h.id]);
  }
}

export async function openDb(cfg) {
  if (!cfg.database || !cfg.user) throw new Error("Не заданы параметры базы (DBNAME/DBUSER)");
  const pool = mysql.createPool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    connectionLimit: 4, charset: "utf8mb4", timezone: "Z", dateStrings: false,
    supportBigNumbers: true, bigNumberStrings: false,
  });
  await pool.query("SET time_zone = '+00:00'").catch(() => {});
  return new Db(pool);
}

export class Db {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET time_zone = '+00:00'");
      const [rows] = await conn.query(sql, params);
      return rows;
    } finally {
      conn.release();
    }
  }

  // Несколько запросов одной транзакцией
  async tx(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET time_zone = '+00:00'");
      await conn.beginTransaction();
      const q = async (sql, params) => (await conn.query(sql, params))[0];
      const res = await fn(q);
      await conn.commit();
      return res;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async migrate() {
    await this.query(`CREATE TABLE IF NOT EXISTS schema_version (
      id TINYINT PRIMARY KEY, version INT NOT NULL
    ) ENGINE=InnoDB`);
    // Несколько копий приложения могут стартовать одновременно — миграции под блокировкой
    const conn = await this.pool.getConnection();
    try {
      const [[lock]] = await conn.query("SELECT GET_LOCK('kira_migrate', 30) AS ok");
      if (!lock.ok) throw new Error("Не дождался блокировки миграций");
      const [rows] = await conn.query("SELECT version FROM schema_version WHERE id = 1");
      let v = rows.length ? rows[0].version : 0;
      for (let i = v; i < MIGRATIONS.length; i++) {
        for (const step of MIGRATIONS[i]) {
          if (typeof step === "function") await step(conn);
          else await conn.query(step);
        }
        v = i + 1;
        await conn.query(
          "INSERT INTO schema_version (id, version) VALUES (1, ?) ON DUPLICATE KEY UPDATE version = VALUES(version)", [v],
        );
      }
      await conn.query("SELECT RELEASE_LOCK('kira_migrate')");
      return v;
    } finally {
      conn.release();
    }
  }

  async version() {
    const [row] = await this.query("SELECT VERSION() AS v");
    return row.v;
  }

  // ---------- kv ----------
  async get(k, dflt = null) {
    const rows = await this.query("SELECT v FROM kv WHERE k = ?", [k]);
    if (!rows.length) return dflt;
    try { return JSON.parse(rows[0].v); } catch { return dflt; }
  }

  async set(k, v) {
    await this.query(
      "INSERT INTO kv (k, v, updated_at) VALUES (?, ?, NOW(3)) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)",
      [k, JSON.stringify(v)],
    );
  }

  // Занять запуск задачи по расписанию. true — этот процесс выполняет, false — уже кто-то выполнил.
  async claimRun(job, runKey) {
    const r = await this.query("INSERT IGNORE INTO job_runs (job, run_key, started_at) VALUES (?, ?, NOW(3))", [job, runKey]);
    return r.affectedRows === 1;
  }

  async close() {
    await this.pool.end();
  }
}
