// Выбор хранилища: если в настройках есть база MySQL — она, иначе файлы.
import path from "node:path";
import { FileStore } from "./file.js";
import { MysqlStore } from "./mysql.js";

export function createStore(env, rootDir) {
  if (env.DB_HOST && env.DB_NAME) {
    return new MysqlStore({
      host: env.DB_HOST, port: +(env.DB_PORT || 3306),
      user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    });
  }
  return new FileStore(path.join(rootDir, "data"));
}
