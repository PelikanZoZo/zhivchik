// Хранилище в MySQL: для хостинга. Таблицы создаются сами при первом запуске.
//   world_state — снимок мира целиком (одна строка, перезаписывается)
//   lives       — каждая закончившаяся жизнь: вид, возраст, поколение и мозг на момент смерти.
//                 Это летопись, по ней потом можно изучать, как эволюционировали мозги.

export class MysqlStore {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async init() {
    const mysql = (await import("mysql2/promise")).default;
    this.pool = mysql.createPool({
      host: this.cfg.host, port: this.cfg.port, user: this.cfg.user,
      password: this.cfg.password, database: this.cfg.database,
      connectionLimit: 3, charset: "utf8mb4",
    });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS world_state (
      id TINYINT PRIMARY KEY,
      saved_at BIGINT NOT NULL,
      data LONGTEXT NOT NULL
    ) CHARACTER SET utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS lives (
      id INT AUTO_INCREMENT PRIMARY KEY,
      species VARCHAR(32) NOT NULL,
      name VARCHAR(32) NOT NULL,
      gen INT NOT NULL,
      age INT NOT NULL,
      eaten INT NOT NULL,
      ended_tick BIGINT NOT NULL,
      brain LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (species), INDEX (ended_tick)
    ) CHARACTER SET utf8mb4`);
    // Для нескольких процессов: «живая» картинка мира от хозяина и очередь команд к нему
    await this.pool.query(`CREATE TABLE IF NOT EXISTS live (
      id TINYINT PRIMARY KEY,
      tick BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      data LONGTEXT NOT NULL
    ) CHARACTER SET utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS commands (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4`);
    return `MySQL ${this.cfg.user}@${this.cfg.host}/${this.cfg.database}`;
  }

  async load() {
    const [rows] = await this.pool.query("SELECT saved_at, data FROM world_state WHERE id = 1");
    if (!rows.length) return null;
    return { world: JSON.parse(rows[0].data), savedAt: Number(rows[0].saved_at) };
  }

  async save(world) {
    await this.pool.query(
      "INSERT INTO world_state (id, saved_at, data) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE saved_at = VALUES(saved_at), data = VALUES(data)",
      [Date.now(), JSON.stringify(world)],
    );
  }

  async recordLives(lives) {
    if (!lives.length) return;
    const rows = lives.map((l) => [l.species, l.name, l.gen, l.age, l.eaten, l.endedAt, JSON.stringify(l.brain)]);
    await this.pool.query("INSERT INTO lives (species, name, gen, age, eaten, ended_tick, brain) VALUES ?", [rows]);
  }

  async recentLives(limit) {
    const [rows] = await this.pool.query(
      "SELECT species, name, gen, age, eaten, ended_tick AS endedAt, created_at AS at FROM lives ORDER BY id DESC LIMIT ?",
      [limit],
    );
    return rows;
  }

  // Полный сброс опыта: вся летопись жизней и очередь команд (перед этим — резервная копия)
  async allLives() {
    const [rows] = await this.pool.query("SELECT * FROM lives ORDER BY id");
    return rows;
  }

  async wipeHistory() {
    await this.pool.query("DELETE FROM lives");
    await this.pool.query("DELETE FROM commands");
  }

  // ---------- хозяин мира ----------
  // Хостинг может запустить несколько копий приложения. Хозяином становится та,
  // что взяла блокировку MySQL. Блокировка держится, пока живо соединение этой копии с базой.
  async tryLead() {
    if (this.leaderConn) return true;
    const conn = await this.pool.getConnection();
    const [[row]] = await conn.query("SELECT GET_LOCK(?, 0) AS ok", [this.lockName()]);
    if (row.ok === 1) {
      this.leaderConn = conn;
      return true;
    }
    conn.release();
    return false;
  }

  // Проверка: повторно берём ту же блокировку на своём соединении. Если она наша — MySQL
  // просто подтвердит (1), если чужая — откажет (0). Сравнивать номера соединений нельзя:
  // на хостинге между приложением и базой стоит посредник, и номера не совпадают.
  async stillLeader() {
    if (!this.leaderConn) return false;
    try {
      const [[row]] = await this.leaderConn.query("SELECT GET_LOCK(?, 0) AS ok", [this.lockName()]);
      if (row.ok === 1) await this.leaderConn.query("SELECT RELEASE_LOCK(?)", [this.lockName()]); // снять лишний уровень
      return row.ok === 1;
    } catch {
      return false;
    }
  }

  lockName() {
    return "zhivchik_leader_" + this.cfg.database;
  }

  async writeLive(tick, data) {
    await this.pool.query(
      "INSERT INTO live (id, tick, updated_at, data) VALUES (1, ?, ?, ?) ON DUPLICATE KEY UPDATE tick = VALUES(tick), updated_at = VALUES(updated_at), data = VALUES(data)",
      [tick, Date.now(), JSON.stringify(data)],
    );
  }

  async readLive() {
    const [rows] = await this.pool.query("SELECT data FROM live WHERE id = 1");
    return rows.length ? JSON.parse(rows[0].data) : null;
  }

  async pushCommand(cmd) {
    await this.pool.query("INSERT INTO commands (data) VALUES (?)", [JSON.stringify(cmd)]);
  }

  async takeCommands() {
    const [rows] = await this.pool.query("SELECT id, data FROM commands ORDER BY id LIMIT 50");
    if (!rows.length) return [];
    await this.pool.query("DELETE FROM commands WHERE id <= ?", [rows[rows.length - 1].id]);
    return rows.map((r) => JSON.parse(r.data));
  }

  async close() {
    this.leaderConn?.release();
    await this.pool?.end();
  }
}
