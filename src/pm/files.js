// Файлы вложений. Лежат на хостинге рядом с сайтом (~/devalby.ru/files), вне папки сайта —
// выкладка их не трогает, а напрямую по ссылке они недоступны: только через API после входа.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_FILE = 25 * 1024 * 1024;

export function createFiles(dir) {
  async function save(stream, originalName) {
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(originalName || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    const key = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(12).toString("hex")}${ext}`;
    const file = path.join(dir, key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let size = 0;
    const out = fs.createWriteStream(file);
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_FILE) throw Object.assign(new Error(`Файл больше ${MAX_FILE / 1024 / 1024} МБ`), { status: 413, expose: true });
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy();
      await fsp.rm(file, { force: true });
      throw e;
    }
    if (!size) { await fsp.rm(file, { force: true }); throw Object.assign(new Error("Пустой файл"), { status: 400, expose: true }); }
    return { key, size };
  }

  function resolve(key) {
    const file = path.normalize(path.join(dir, key || ""));
    if (!file.startsWith(path.normalize(dir) + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  }

  return { save, resolve, dir };
}
