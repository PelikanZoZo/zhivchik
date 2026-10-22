// Выбор хранилища: если в настройках есть база MySQL — она, иначе файлы.
import path from "node:path";
import { FileStore } from "./file.js";
import { MysqlStore } from "./mysql.js";

// Понимает и наши имена переменных (DB_HOST), и те, что задаёт панель хостинга (DBHOST).
export function createStore(env, rootDir) {
  const pick = (...names) => names.map((n) => env[n]).find((v) => v);
  const host = pick("DB_HOST", "DBHOST"), database = pick("DB_NAME", "DBNAME");
  if (host && database) {
    return new MysqlStore({
      host, database, port: +(pick("DB_PORT", "DBPORT") || 3306),
      user: pick("DB_USER", "DBUSER"), password: pick("DB_PASSWORD", "DBPASS", "DBPASSWORD"),
    });
  }
  return new FileStore(path.join(rootDir, "data"));
}
