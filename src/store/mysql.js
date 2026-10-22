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

  async close() {
    await this.pool?.end();
  }
}
