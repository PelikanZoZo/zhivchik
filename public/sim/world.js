// Мир: чашка Петри с веществами, холодными зонами и населением.
// Один и тот же код работает и в браузере, и на сервере.

import { KINDS, sense } from "./sensors.js";
import { createBrain } from "./brains/index.js";

export const W = 800, H = 600;
const SPEED = 1.6;
const TURN = 0.3;
const MAX_ENERGY = 150;
const EAT_RADIUS = 9;
const BASE_EFFECTS = { green: 25, violet: -30, amber: 8 };

export const SPECIES = {
  associative: { name: "Ассоциативные", short: "А", color: "#4cc48a" },
  neural: { name: "Нейро", short: "Н", color: "#e08a4c" },
};
export const DEFAULT_POPULATION = { associative: 3, neural: 3 };

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class World {
  constructor(data) {
    data = data || {};
    this.tick = data.tick ?? 0;
    this.effects = { ...BASE_EFFECTS, ...data.effects };
    this.winter = !!data.winter;
    this.famine = !!data.famine;
    this.inherit = data.inherit ?? true;
    this.population = { ...DEFAULT_POPULATION, ...data.population };
    this.items = data.items ?? [];
    this.cold = data.cold ?? [];
    this.serial = data.serial ?? 0;
    this.stats = data.stats ?? {};
    this.log = data.log ?? [];
    this.hof = data.hof ?? {}; // «зал славы»: лучшие мозги каждого вида за историю
    this.lives = []; // закончившиеся жизни, ждут записи в базу
    this.creatures = (data.creatures ?? []).map((c) => ({ ...c, brain: createBrain(c.brain.type, c.brain), trail: [] }));
    for (const sp of Object.keys(this.population)) { this.stats[sp] ??= { deaths: 0, recent: [], best: 0 }; this.hof[sp] ??= []; }
    if (!data.tick) this.genesis();
  }

  genesis() {
    this.items = [];
    this.makeCold();
    for (let i = 0; i < 30; i++) this.spawnItem();
    this.creatures = [];
    for (const [sp, n] of Object.entries(this.population)) for (let i = 0; i < n; i++) this.birth(sp, null);
    this.note("Мир создан. Существа ещё ничего о нём не знают.");
  }

  // ---------- среда ----------
  makeCold() {
    this.cold = [];
    const n = this.winter ? 4 : 2;
    for (let i = 0; i < n; i++)
      this.cold.push({ x: rnd(80, W - 80), y: rnd(80, H - 80), r: this.winter ? rnd(110, 160) : rnd(60, 90) });
  }

  coldAt(x, y) {
    let c = 0;
    for (const z of this.cold) {
      const d = Math.hypot(x - z.x, y - z.y);
      if (d < z.r) c = Math.max(c, 1 - d / z.r);
    }
    return c;
  }

  spawnItem(kind, x, y) {
    const k = kind || KINDS[Math.floor(Math.random() * KINDS.length)].id;
    // Вещество испаряется со временем, иначе то, что все обходят, забило бы мир
    this.items.push({ k, x: clamp(x ?? rnd(20, W - 20), 5, W - 5), y: clamp(y ?? rnd(20, H - 20), 5, H - 5), ttl: Math.round(rnd(1200, 2400)) });
  }

  // ---------- жизнь ----------
  birth(species, parent) {
    this.serial++;
    const brain = parent && this.inherit ? parent.brain.child() : createBrain(species);
    const c = {
      id: this.serial,
      name: SPECIES[species].short + "-" + this.serial,
      species, brain,
      gen: parent && this.inherit ? parent.gen + 1 : 1,
      x: rnd(60, W - 60), y: rnd(60, H - 60), a: rnd(0, Math.PI * 2),
      energy: 100, age: 0, eaten: 0, knewCold: false, trail: [],
    };
    this.creatures.push(c);
    return c;
  }

  die(c) {
    c.brain.onDeath();
    const st = this.stats[c.species];
    st.deaths++;
    st.recent.push(c.age);
    if (st.recent.length > 20) st.recent.shift();
    st.best = Math.max(st.best, c.age);
    this.lives.push({ species: c.species, name: c.name, gen: c.gen, age: c.age, eaten: c.eaten, endedAt: this.tick, brain: c.brain.toJSON() });
    this.creatures.splice(this.creatures.indexOf(c), 1);
    // Естественный отбор. Заслуги прошлых чемпионов понемногу тускнеют, чтобы вид мог
    // перестроиться, когда мир меняется. Родитель — победитель «турнира» из двух случайных
    // кандидатов: живые сородичи и зал славы вида.
    const hof = this.hof[c.species];
    for (const h of hof) h.fitness *= 0.97;
    hof.push({ fitness: c.age, name: c.name, gen: c.gen, brain: c.brain.toJSON() });
    hof.sort((a, b) => b.fitness - a.fitness);
    if (hof.length > 6) hof.length = 6;
    const pool = [
      ...this.creatures.filter((o) => o.species === c.species).map((o) => ({ fitness: o.age, name: o.name, gen: o.gen, brain: o.brain })),
      ...hof.map((h) => ({ ...h, brain: { child: () => createBrain(h.brain.type, h.brain).child() } })),
    ];
    const pick = () => pool[Math.floor(Math.random() * pool.length)];
    const a = pick(), b = pick();
    const parent = a.fitness >= b.fitness ? a : b;
    const child = this.birth(c.species, parent);
    this.note(`${c.name} умер в возрасте ${c.age}. Родился ${child.name}` + (this.inherit ? ` (поколение ${child.gen}, потомок ${parent.name}).` : "."));
  }

  step() {
    this.tick++;
    for (const c of [...this.creatures]) {
      const s = sense(this, c);
      const turn = c.brain.act(s);
      c.a += turn * TURN;
      let nx = c.x + Math.cos(c.a) * SPEED, ny = c.y + Math.sin(c.a) * SPEED;
      if (nx < 4 || nx > W - 4) { c.a = Math.PI - c.a; nx = clamp(nx, 4, W - 4); }
      if (ny < 4 || ny > H - 4) { c.a = -c.a; ny = clamp(ny, 4, H - 4); }
      c.x = nx; c.y = ny; c.age++;

      const before = c.energy;
      const coldLoss = this.coldAt(c.x, c.y) * 0.35;
      c.energy -= 0.05 + coldLoss;
      let ate = null, effect = 0;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (Math.hypot(it.x - c.x, it.y - c.y) < EAT_RADIUS) {
          this.items.splice(i, 1);
          ate = it.k; effect = this.effects[it.k]; c.energy += effect; c.eaten++;
          break;
        }
      }
      c.energy = clamp(c.energy, 0, MAX_ENERGY);
      const events = c.brain.learn({ reward: (c.energy - before) / 10, ate, effect, coldLoss });
      for (const e of events) {
        if (e.learnedCold && !c.knewCold) { c.knewCold = true; this.note(`${c.name} понял, что холод отнимает силы.`); }
        else if (e.kind) {
          const kn = KINDS.find((k) => k.id === e.kind).name;
          this.note(e.effect >= 0 ? `${c.name} съел ${kn}: неожиданно хорошо (+${e.effect}).` : `${c.name} съел ${kn}: стало плохо (${e.effect}).`);
        }
      }
      if (this.tick % 3 === 0) { c.trail.push([Math.round(c.x), Math.round(c.y)]); if (c.trail.length > 40) c.trail.shift(); }
      if (c.energy <= 0) this.die(c);
    }
    for (let i = this.items.length - 1; i >= 0; i--) if (--this.items[i].ttl <= 0) this.items.splice(i, 1);
    const target = this.famine ? 6 : 30;
    if (this.items.length < target && Math.random() < (this.famine ? 0.02 : 0.08)) this.spawnItem();
  }

  // ---------- управление ----------
  action(type, p = {}) {
    switch (type) {
      case "flip": {
        const ids = KINDS.map((k) => k.id), vals = ids.map((i) => this.effects[i]);
        vals.unshift(vals.pop());
        ids.forEach((id, n) => (this.effects[id] = vals[n]));
        this.note("Мир перевернулся: вещества поменяли свойства. Старый опыт теперь врёт.");
        break;
      }
      case "winter":
        this.winter = !this.winter; this.makeCold();
        this.note(this.winter ? "Пришла зима: холодных зон больше." : "Зима кончилась.");
        break;
      case "famine":
        this.famine = !this.famine;
        this.note(this.famine ? "Голод: еды почти нет." : "Голод закончился.");
        break;
      case "inherit":
        this.inherit = !!p.on;
        this.note(this.inherit ? "Потомки снова наследуют память." : "Потомки рождаются с чистой памятью.");
        break;
      case "food":
        for (let i = 0; i < 5; i++) this.spawnItem(null, +p.x + rnd(-15, 15), +p.y + rnd(-15, 15));
        break;
      case "reset":
        this.tick = 0; this.serial = 0; this.log = []; this.stats = {};
        this.effects = { ...BASE_EFFECTS }; this.winter = false; this.famine = false;
        this.hof = {};
        for (const sp of Object.keys(this.population)) { this.stats[sp] = { deaths: 0, recent: [], best: 0 }; this.hof[sp] = []; }
        this.genesis();
        break;
      default:
        throw new Error("Неизвестное действие: " + type);
    }
  }

  note(text) {
    this.log.unshift({ t: this.tick, text });
    if (this.log.length > 80) this.log.length = 80;
  }

  // ---------- для интерфейса и базы ----------
  view() {
    return {
      tick: this.tick, W, H,
      effects: this.effects, winter: this.winter, famine: this.famine, inherit: this.inherit,
      items: this.items.map((i) => [i.k, Math.round(i.x), Math.round(i.y)]),
      cold: this.cold,
      creatures: this.creatures.map((c) => ({
        id: c.id, name: c.name, species: c.species, gen: c.gen,
        x: +c.x.toFixed(1), y: +c.y.toFixed(1), a: +c.a.toFixed(3),
        energy: Math.round(c.energy), age: c.age, trail: c.trail,
      })),
    };
  }

  details() {
    const species = {};
    for (const [sp, st] of Object.entries(this.stats)) {
      const r = st.recent;
      const living = this.creatures.filter((c) => c.species === sp);
      species[sp] = {
        deaths: st.deaths, best: Math.max(st.best, ...living.map((c) => c.age), 0),
        avgLife: r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null,
        topGen: Math.max(0, ...living.map((c) => c.gen)),
      };
    }
    return {
      log: this.log.slice(0, 40), species,
      brains: Object.fromEntries(this.creatures.map((c) => [c.id, c.brain.summary()])),
    };
  }

  toJSON() {
    return {
      tick: this.tick, effects: this.effects, winter: this.winter, famine: this.famine, inherit: this.inherit,
      population: this.population, items: this.items, cold: this.cold, serial: this.serial,
      stats: this.stats, log: this.log, hof: this.hof,
      creatures: this.creatures.map(({ trail, brain, ...c }) => ({ ...c, brain: brain.toJSON() })),
    };
  }
}
