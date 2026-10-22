// Мир Живчика, версия 3.
//
//   Агенты Зелёный (ассоциативный мозг) и Красный (нейросеть). У каждого четыре шкалы:
//   энергия, эмоции, сила, здоровье. Едят плесень. Убегают от хищников или отбиваются силой.
//   Размножаются, когда у обоих энергия в зелёной зоне, — не чаще раза в 15 минут.
//   Хищники появляются сами, не больше 2 за 10 минут, и охотятся на агентов.
//   Каждые 5 минут поднимается влажность — на ней вырастают синие колонии плесени,
//   которые потом медленно отмирают.
//
// Время — реальное: 20 тиков в секунду. Один и тот же код работает в браузере и на сервере.

import { SIGNALS, sense } from "./sensors.js";
import { createBrain } from "./brains/index.js";

export const W = 800, H = 600;
export const VERSION = 3;
export const TPS = 20;
const MIN = 60 * TPS; // тиков в реальной минуте

export const RULES = {
  birthCooldown: 15 * MIN,      // размножение — не чаще раза в 15 минут
  predatorWindow: 10 * MIN,     // хищников — не больше 2 за 10 минут
  predatorMax: 2,
  humidityEvery: 5 * MIN,       // влажность поднимается каждые 5 минут
  greenEnergy: 70,              // «зелёный уровень» энергии для размножения
  maxAgents: 14,
};

export const SPECIES = {
  green: { name: "Зелёный", plural: "Зелёные", color: "#46c27a", brain: "associative" },
  red: { name: "Красный", plural: "Красные", color: "#e2554f", brain: "neural" },
};

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class World {
  constructor(data) {
    data = data && data.version === VERSION ? data : null;
    this.version = VERSION;
    this.tick = data?.tick ?? 0;
    this.serial = data?.serial ?? 0;
    this.humidity = data?.humidity ?? 0;
    this.lastHumidity = data?.lastHumidity ?? 0;
    this.lastBirth = data?.lastBirth ?? -RULES.birthCooldown;
    this.predatorSpawns = data?.predatorSpawns ?? [];
    this.molds = data?.molds ?? [];
    this.predators = data?.predators ?? [];
    this.stats = data?.stats ?? {};
    this.hof = data?.hof ?? {};
    this.log = data?.log ?? [];
    this.lives = []; // закончившиеся жизни, ждут записи в базу
    this.agents = (data?.agents ?? []).map((a) => ({ ...a, brain: createBrain(a.brain.type, a.brain), trail: [] }));
    for (const sp of Object.keys(SPECIES)) {
      this.stats[sp] ??= { births: 0, deaths: 0, eaten: 0, recent: [], best: 0 };
      this.hof[sp] ??= [];
    }
    if (!data) this.genesis();
  }

  genesis() {
    this.humidity = 0.7;
    this.lastHumidity = this.tick;
    this.molds = [];
    for (let i = 0; i < 6; i++) this.spawnMold(null, null, true);
    this.agents = [];
    this.predators = [];
    this.spawnAgent("green", null, null, W * 0.4, H / 2);
    this.spawnAgent("red", null, null, W * 0.6, H / 2);
    this.note("Мир создан: Зелёный и Красный. Они ещё ничего о нём не знают.");
  }

  // ---------- плесень и влажность ----------
  spawnMold(x, y, grown) {
    if (this.molds.length >= 30) return;
    const peak = rnd(35, 60);
    this.molds.push({
      x: clamp(x ?? rnd(30, W - 30), 10, W - 10), y: clamp(y ?? rnd(30, H - 30), 10, H - 10),
      biomass: grown ? peak : 3, peak, age: grown ? 600 : 0,
      life: Math.round(rnd(3, 5) * MIN), // потом медленно отмирает
    });
  }

  stepEnvironment() {
    // Каждые 5 минут — волна влажности, потом она медленно спадает
    if (this.tick - this.lastHumidity >= RULES.humidityEvery) this.raiseHumidity();
    this.humidity *= 0.9997; // спадает примерно вдвое за 2 минуты
    if (this.humidity > 0.2 && Math.random() < (this.humidity - 0.2) * 0.01) this.spawnMold();

    for (let i = this.molds.length - 1; i >= 0; i--) {
      const m = this.molds[i];
      m.age++;
      if (m.age < 600) m.biomass = Math.min(m.peak, m.biomass + m.peak / 600 * (0.5 + this.humidity));
      else if (m.age > m.life * 0.5) m.biomass -= m.peak / (m.life * 0.5); // медленное отмирание
      if (m.biomass <= 0.5) this.molds.splice(i, 1);
    }

    // Хищники: случайно, но не больше 2 за 10 минут
    this.predatorSpawns = this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow);
    if (this.agents.length && this.predatorSpawns.length < RULES.predatorMax && Math.random() < 1 / (5 * MIN)) this.spawnPredator();
  }

  raiseHumidity() {
    this.humidity = Math.min(1, this.humidity + 0.55);
    this.lastHumidity = this.tick;
    this.note(`Влажность поднялась до ${Math.round(this.humidity * 100)}%. Скоро вырастет плесень.`);
  }

  // ---------- хищники ----------
  spawnPredator() {
    this.predatorSpawns.push(this.tick);
    const side = Math.floor(Math.random() * 4);
    const x = side === 0 ? 5 : side === 1 ? W - 5 : rnd(20, W - 20);
    const y = side === 2 ? 5 : side === 3 ? H - 5 : rnd(20, H - 20);
    this.serial++;
    this.predators.push({ id: this.serial, x, y, a: Math.atan2(H / 2 - y, W / 2 - x), hp: 100, age: 0, stunned: 0, leaving: false, target: null });
    this.note("Появился хищник.");
  }

  stepPredators() {
    for (let i = this.predators.length - 1; i >= 0; i--) {
      const p = this.predators[i];
      p.age++;
      if (p.age > 3 * MIN && !p.leaving) { p.leaving = true; this.note("Хищник так и не поймал добычу и уходит."); }
      let speed = 1.5;
      if (p.stunned > 0) { p.stunned--; speed = -1.2; } // отбили — отступает
      else if (p.leaving) {
        speed = 1.8;
        const ex = p.x < W / 2 ? -20 : W + 20;
        p.a = Math.atan2(0, ex - p.x);
      } else {
        // охотится на ближайшего агента
        let prey = null, best = 320;
        for (const a of this.agents) { const d = dist(a, p); if (d < best) { best = d; prey = a; } }
        p.target = prey?.id ?? null;
        if (prey) {
          if (best < 50) speed = 2.0; // рывок на короткой дистанции
          const t = Math.atan2(prey.y - p.y, prey.x - p.x);
          p.a += clamp(Math.atan2(Math.sin(t - p.a), Math.cos(t - p.a)), -0.12, 0.12);
        } else p.a += rnd(-0.15, 0.15);
      }
      p.x += Math.cos(p.a) * speed; p.y += Math.sin(p.a) * speed;
      if (!p.leaving) {
        if (p.x < 5 || p.x > W - 5) p.a = Math.PI - p.a;
        if (p.y < 5 || p.y > H - 5) p.a = -p.a;
        p.x = clamp(p.x, 5, W - 5); p.y = clamp(p.y, 5, H - 5);
      }
      if (p.hp <= 0) { this.predators.splice(i, 1); this.note("Агенты отбились: хищник погиб."); continue; }
      if (p.leaving && (p.x < -15 || p.x > W + 15)) this.predators.splice(i, 1);
    }
  }

  // ---------- агенты ----------
  spawnAgent(species, parentA, parentB, x, y) {
    this.serial++;
    const sp = SPECIES[species];
    let brain;
    if (parentA) {
      const own = parentA.species === species ? parentA : parentB;
      const other = own === parentA ? parentB : parentA;
      brain = own.brain.child(other?.brain);
    } else {
      // с нуля, или от лучшего из «зала славы» вида, если мир уже жил
      const best = this.hof[species]?.[0];
      brain = best ? createBrain(best.brain.type, best.brain).child() : createBrain(sp.brain);
    }
    const a = {
      id: this.serial, name: `${sp.name}-${this.serial}`, species,
      gen: parentA ? Math.max(parentA.gen, parentB?.gen ?? 0) + 1 : (this.hof[species]?.[0]?.gen ?? 0) + 1,
      parents: parentA ? [parentA.name, parentB?.name].filter(Boolean) : [],
      x: x ?? rnd(60, W - 60), y: y ?? rnd(60, H - 60), a: rnd(0, Math.PI * 2),
      energy: parentA ? 60 : 85, emotions: 70, strength: parentA ? 20 : 30, health: 100,
      age: 0, ate: 0, fleeing: false, brain, trail: [],
    };
    this.agents.push(a);
    return a;
  }

  stepAgent(a) {
    const before = { energy: a.energy, emotions: a.emotions, health: a.health };
    const touch = {};

    // Чувства и решение мозга
    const turn = a.brain.act(sense(this, a));
    a.a += turn * 0.3;

    // Страх: хищник рядом — бежит быстрее, тратит больше
    let nearestPred = Infinity;
    for (const p of this.predators) if (!p.leaving) nearestPred = Math.min(nearestPred, dist(a, p));
    a.fleeing = nearestPred < 130 && a.emotions < 60;
    // Бегство быстрее, но сильно зависит от сил: голодный бегает плохо
    const speed = a.fleeing ? 1.5 + 0.8 * (a.energy / 100) : a.energy < 10 ? 0.8 : 1.3;
    let nx = a.x + Math.cos(a.a) * speed, ny = a.y + Math.sin(a.a) * speed;
    if (nx < 4 || nx > W - 4) { a.a = Math.PI - a.a; nx = clamp(nx, 4, W - 4); }
    if (ny < 4 || ny > H - 4) { a.a = -a.a; ny = clamp(ny, 4, H - 4); }
    a.x = nx; a.y = ny; a.age++;

    // Энергия: тратится на жизнь и движение (около 12 минут без еды)
    a.energy -= 0.007 * (a.fleeing ? 2 : 1);

    // Еда: откусывает от колонии плесени
    for (const m of this.molds) {
      if (m.biomass > 1 && dist(a, m) < 6 + m.biomass / 6 && a.energy < 100) {
        const bite = Math.min(0.6, m.biomass);
        m.biomass -= bite; a.energy += bite;
        touch.mold = (touch.mold || 0) + bite * 15;
        if (!a.ate++) this.note(`${a.name} впервые нашёл плесень и поел.`);
        break;
      }
    }

    // Энергия плавно восполняет здоровье — если есть воля к жизни (эмоции не в красной зоне)
    if (a.health < 100 && a.energy > 35 && a.emotions >= 15) { a.health += 0.02; a.energy -= 0.02; }
    // Тоска: в красной зоне эмоций здоровье медленно тает
    if (a.emotions < 15) a.health -= 0.01;
    // Голод: без энергии тает здоровье
    if (a.energy <= 0) a.health -= 0.02;

    // Сила: копится от сытости, тает от голода
    if (a.energy > 60) a.strength += 0.0004; // примерно +0.5 в минуту
    if (a.energy < 25) a.strength -= 0.002;

    // Эмоции: стремятся к спокойствию; падают от страха, голода и ран; растут от еды и близости
    if (nearestPred < 150) a.emotions -= 0.12;
    if (a.energy < 30) a.emotions -= 0.02;
    if (touch.mold) a.emotions += 0.03;
    let nearKin = Infinity;
    for (const o of this.agents) if (o !== a) nearKin = Math.min(nearKin, dist(a, o));
    if (nearKin < 45) { a.emotions += 0.06; touch.partner = 8; }
    // Рядом есть свои — эмоции тянутся к спокойствию. Никого рядом — к нулю (одиночество, ~10 мин до красной зоны)
    if (nearKin < 200) a.emotions += (65 - a.emotions) * 0.0005;
    else a.emotions -= a.emotions * 0.00012;

    // Нападение хищника: здоровье уходит постепенно; сила даёт шанс отбиться
    for (const p of this.predators) {
      if (p.stunned || p.leaving || dist(a, p) > 13) continue;
      a.health -= 0.15;
      a.emotions -= 0.3;
      touch.predator = -25;
      if (a.age % 20 === 0 && Math.random() < a.strength / 260) {
        p.stunned = 80; p.hp -= 15 + a.strength / 4;
        a.strength -= 3;
        this.note(`${a.name} отбился от хищника.`);
      }
    }

    a.energy = clamp(a.energy); a.health = clamp(a.health); a.strength = clamp(a.strength); a.emotions = clamp(a.emotions);

    // Учёба: награда — это то, как изменилась жизнь за шаг
    const reward = (a.energy - before.energy) / 10 + (a.health - before.health) / 4 + (a.emotions - before.emotions) / 20;
    for (const e of a.brain.learn({ reward, touch })) {
      const sig = SIGNALS.find((s) => s.id === e.signal).name;
      this.note(e.good ? `${a.name} понял: ${sig} — это хорошо.` : `${a.name} понял: ${sig} — опасно.`);
    }

    if (this.tick % 3 === 0) { a.trail.push([Math.round(a.x), Math.round(a.y)]); if (a.trail.length > 40) a.trail.shift(); }
  }

  tryBreed() {
    if (this.tick - this.lastBirth < RULES.birthCooldown || this.agents.length >= RULES.maxAgents) return;
    const ready = this.agents.filter((a) => a.energy >= RULES.greenEnergy && a.emotions >= 40 && a.age > MIN);
    for (let i = 0; i < ready.length; i++)
      for (let j = i + 1; j < ready.length; j++) {
        const a = ready[i], b = ready[j];
        if (dist(a, b) > 30) continue;
        const species = Math.random() < 0.5 ? a.species : b.species;
        const child = this.spawnAgent(species, a, b, (a.x + b.x) / 2, (a.y + b.y) / 2);
        a.energy -= 30; b.energy -= 30; a.emotions = clamp(a.emotions + 20); b.emotions = clamp(b.emotions + 20);
        this.lastBirth = this.tick;
        this.stats[species].births++;
        this.note(`У ${a.name} и ${b.name} родился ${child.name} (поколение ${child.gen}).`);
        return;
      }
  }

  die(a, cause) {
    a.brain.onDeath();
    const st = this.stats[a.species];
    st.deaths++;
    st.recent.push(a.age); if (st.recent.length > 20) st.recent.shift();
    st.best = Math.max(st.best, a.age);
    if (cause === "predator") st.eaten++;
    const hof = this.hof[a.species];
    for (const h of hof) h.fitness *= 0.97;
    hof.push({ fitness: a.age, name: a.name, gen: a.gen, brain: a.brain.toJSON() });
    hof.sort((x, y) => y.fitness - x.fitness); if (hof.length > 5) hof.length = 5;
    this.lives.push({ species: a.species, name: a.name, gen: a.gen, age: a.age, eaten: a.ate, endedAt: this.tick, brain: a.brain.toJSON() });
    this.agents.splice(this.agents.indexOf(a), 1);
    const mins = (a.age / MIN).toFixed(1);
    this.note(cause === "predator" ? `${a.name} погиб от хищника, прожив ${mins} мин.` : `${a.name} умер от голода, прожив ${mins} мин.`);
    if (cause === "predator") {
      const p = this.predators.find((p) => dist(p, a) < 20 && !p.leaving);
      if (p) { p.leaving = true; } // сытый хищник уходит
    }
  }

  step() {
    this.tick++;
    this.stepEnvironment();
    this.stepPredators();
    for (const a of [...this.agents]) {
      this.stepAgent(a);
      if (a.health <= 0) {
        const byPredator = this.predators.some((p) => !p.leaving && dist(p, a) < 20);
        this.die(a, byPredator ? "predator" : "hunger");
      }
    }
    this.tryBreed();
    if (!this.agents.length) {
      this.note("Все агенты погибли. Жизнь начинается заново: новая пара от лучших предков.");
      this.predators = [];
      this.spawnAgent("green", null, null, W * 0.4, H / 2);
      this.spawnAgent("red", null, null, W * 0.6, H / 2);
    }
  }

  // ---------- управление ----------
  action(type, p = {}) {
    switch (type) {
      case "humidity": this.raiseHumidity(); break;
      case "predator":
        if (this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow).length >= RULES.predatorMax)
          throw new Error("Лимит: не больше 2 хищников за 10 минут.");
        this.spawnPredator();
        break;
      case "mold": this.spawnMold(+p.x, +p.y); break;
      case "reset":
        this.tick = 0; this.serial = 0; this.log = []; this.stats = {}; this.hof = {};
        this.lastBirth = -RULES.birthCooldown; this.predatorSpawns = [];
        for (const sp of Object.keys(SPECIES)) { this.stats[sp] = { births: 0, deaths: 0, eaten: 0, recent: [], best: 0 }; this.hof[sp] = []; }
        this.genesis();
        break;
      default: throw new Error("Неизвестное действие: " + type);
    }
  }

  note(text) {
    this.log.unshift({ t: this.tick, text });
    if (this.log.length > 80) this.log.length = 80;
  }

  // ---------- для интерфейса и базы ----------
  view() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      version: VERSION, tick: this.tick, W, H, tpsBase: TPS,
      humidity: r1(this.humidity * 100),
      nextHumidity: Math.max(0, RULES.humidityEvery - (this.tick - this.lastHumidity)),
      nextBirth: Math.max(0, RULES.birthCooldown - (this.tick - this.lastBirth)),
      predatorsInWindow: this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow).length,
      molds: this.molds.map((m) => [Math.round(m.x), Math.round(m.y), r1(m.biomass), m.age > m.life * 0.5 ? 1 : 0]),
      predators: this.predators.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), a: +p.a.toFixed(2), hp: Math.round(p.hp), stunned: p.stunned > 0, leaving: p.leaving })),
      agents: this.agents.map((a) => ({
        id: a.id, name: a.name, species: a.species, gen: a.gen, parents: a.parents,
        x: r1(a.x), y: r1(a.y), a: +a.a.toFixed(3), age: a.age, fleeing: a.fleeing,
        energy: Math.round(a.energy), emotions: Math.round(a.emotions), strength: Math.round(a.strength), health: Math.round(a.health),
        trail: a.trail,
      })),
    };
  }

  details() {
    const species = {};
    for (const [sp, st] of Object.entries(this.stats)) {
      const r = st.recent;
      species[sp] = {
        alive: this.agents.filter((a) => a.species === sp).length,
        births: st.births, deaths: st.deaths, eaten: st.eaten,
        best: Math.max(st.best, ...this.agents.filter((a) => a.species === sp).map((a) => a.age), 0),
        avgLife: r.length ? Math.round(r.reduce((x, y) => x + y, 0) / r.length) : null,
      };
    }
    return { log: this.log.slice(0, 40), species, brains: Object.fromEntries(this.agents.map((a) => [a.id, a.brain.summary()])) };
  }

  toJSON() {
    return {
      version: VERSION, tick: this.tick, serial: this.serial, humidity: this.humidity, lastHumidity: this.lastHumidity,
      lastBirth: this.lastBirth, predatorSpawns: this.predatorSpawns, molds: this.molds, predators: this.predators,
      stats: this.stats, hof: this.hof, log: this.log,
      agents: this.agents.map(({ trail, brain, ...a }) => ({ ...a, brain: brain.toJSON() })),
    };
  }
}
