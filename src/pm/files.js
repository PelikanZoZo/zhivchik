// Файлы хранилища и вложений. Лежат на хостинге рядом с сайтом (~/devalby.ru/files), вне папки сайта —
// выкладка их не трогает, а напрямую по ссылке они недоступны: только через API после входа.
//
// Хостинг принимает запросы не больше ~8 МБ, поэтому большие файлы приходят кусками
// (Worker из Telegram, сайт из браузера): appendChunk(...) складывает их во временный файл,
// на последнем куске файл переезжает на место.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_FILE = 50 * 1024 * 1024;
export const CHUNK = 4 * 1024 * 1024;

export function createFiles(dir) {
  const tmpDir = path.join(dir, ".upload");

  function newKey(originalName) {
    const ext = path.extname(originalName || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    return `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(12).toString("hex")}${ext}`;
  }

  async function writeStream(stream, file, { append = false, limit = MAX_FILE, already = 0, hash } = {}) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let size = already;
    const out = fs.createWriteStream(file, { flags: append ? "a" : "w" });
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error(`Файл больше ${limit / 1024 / 1024} МБ`), { status: 413, expose: true });
        hash?.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy();
      throw e;
    }
    return size;
  }

  // Файл целиком одним запросом
  async function save(stream, originalName) {
    const key = newKey(originalName);
    const file = path.join(dir, key);
    const hash = crypto.createHash("sha256");
    let size;
    try {
      size = await writeStream(stream, file, { hash });
    } catch (e) {
      await fsp.rm(file, { force: true });
      throw e;
    }
    if (!size) { await fsp.rm(file, { force: true }); throw Object.assign(new Error("Пустой файл"), { status: 400, expose: true }); }
    return { key, size, sha256: hash.digest("hex") };
  }

  // Кусок файла: index от 0, total — сколько всего. На последнем куске — { done: true, key, size, sha256 }
  async function appendChunk(stream, { uploadId, index, total, name }) {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(String(uploadId))) throw Object.assign(new Error("Неверный номер загрузки"), { status: 400, expose: true });
    index = +index; total = +total;
    if (!(index >= 0 && total >= 1 && index < total && total <= Math.ceil(MAX_FILE / (512 * 1024)))) {
      throw Object.assign(new Error("Неверный номер куска"), { status: 400, expose: true });
    }
    const part = path.join(tmpDir, `${uploadId}.part`);
    const meta = path.join(tmpDir, `${uploadId}.json`);
    await fsp.mkdir(tmpDir, { recursive: true });
    let state = { next: 0, size: 0 };
    if (index === 0) {
      await fsp.rm(part, { force: true });
    } else {
      try { state = JSON.parse(await fsp.readFile(meta, "utf8")); } catch { throw Object.assign(new Error("Загрузка не найдена — начни сначала"), { status: 409, expose: true }); }
      if (index === state.next - 1) return { done: false, next: state.next }; // повтор того же куска
      if (index !== state.next) throw Object.assign(new Error(`Ждала кусок ${state.next}, пришёл ${index}`), { status: 409, expose: true });
    }
    const size = await writeStream(stream, part, { append: index > 0, already: state.size });
    state = { next: index + 1, size, total };
    if (index < total - 1) {
      await fsp.writeFile(meta, JSON.stringify(state));
      return { done: false, next: state.next };
    }
    await fsp.rm(meta, { force: true });
    if (!size) { await fsp.rm(part, { force: true }); throw Object.assign(new Error("Пустой файл"), { status: 400, expose: true }); }
    const key = newKey(name);
    const file = path.join(dir, key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.rename(part, file);
    return { done: true, key, size, sha256: await hashFile(file) };
  }

  async function hashFile(file) {
    const h = crypto.createHash("sha256");
    for await (const c of fs.createReadStream(file)) h.update(c);
    return h.digest("hex");
  }

  // Старые недокачанные куски (больше суток) — убрать
  async function cleanup() {
    const names = await fsp.readdir(tmpDir).catch(() => []);
    for (const n of names) {
      const f = path.join(tmpDir, n);
      const st = await fsp.stat(f).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600e3) await fsp.rm(f, { force: true });
    }
  }

  function resolve(key) {
    const file = path.normalize(path.join(dir, key || ""));
    if (!file.startsWith(path.normalize(dir) + path.sep) || file.startsWith(tmpDir)) return null;
    return fs.existsSync(file) ? file : null;
  }

  async function read(key) {
    const f = resolve(key);
    return f ? fsp.readFile(f) : null;
  }

  async function remove(key) {
    const f = resolve(key);
    if (f) await fsp.rm(f, { force: true });
  }

  return { save, appendChunk, resolve, read, remove, cleanup, dir };
}
