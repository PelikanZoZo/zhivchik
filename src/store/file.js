// Хранилище в файлах: для запуска у себя на компьютере, без базы данных.
import fs from "node:fs/promises";
import path from "node:path";

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.worldFile = path.join(dir, "world.json");
    this.livesFile = path.join(dir, "lives.jsonl");
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return "файлы в папке " + this.dir;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.worldFile, "utf8"));
      return { world: raw.world, savedAt: raw.savedAt };
    } catch {
      return null;
    }
  }

  async save(world) {
    const tmp = this.worldFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), world }));
    await fs.rename(tmp, this.worldFile);
  }

  async recordLives(lives) {
    if (!lives.length) return;
    await fs.appendFile(this.livesFile, lives.map((l) => JSON.stringify({ ...l, at: Date.now() })).join("\n") + "\n");
  }

  async recentLives(limit) {
    try {
      const lines = (await fs.readFile(this.livesFile, "utf8")).trim().split("\n");
      return lines.slice(-limit).reverse().map((l) => {
        const { brain, ...rest } = JSON.parse(l);
        return rest;
      });
    } catch {
      return [];
    }
  }

  async allLives() {
    try { return (await fs.readFile(this.livesFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  async wipeHistory() {
    await fs.rm(this.livesFile, { force: true });
  }

  // Локально приложение всегда одно, поэтому оно всегда хозяин мира
  async tryLead() { return true; }
  async stillLeader() { return true; }
  async writeLive() {}
  async readLive() { return null; }
  async pushCommand() {}
  async takeCommands() { return []; }

  async close() {}
}
