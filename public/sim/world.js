// Мир Живчика, версия 5.
//
//   Зелёные — самцы (ассоциативный мозг), Красные — самки (нейросеть).
//   Параметры агента: Сила, Здоровье, Эмоции, Скука и текущая Агрессия.
//     Сила — главный ресурс: даёт еда и сон, тратят движение, рывки, драки и соперничество.
//     Мало силы — агент замедляется и отдыхает, почти ноль — засыпает. Много — может ускориться,
//     обороняться и отталкивать хищника.
//     Скука растёт, когда вокруг нет ни еды, ни партнёров, ни хищников: агент реагирует вяло.
//     Самцы отталкивают друг друга от самки, тратя силу, — агрессия у обоих растёт.
//   Гены развития (наследуются, мутируют): взаимопомощь, скорость, агрессия, наблюдательность,
//   реакция, сочувствие, хитрость.
//   Хищники тоже эволюционируют: каждый новый — потомок самых удачливых охотников прошлого.
//
// Время мира — в тиках (см. RULES). Один и тот же код работает в браузере и на сервере.

import { SIGNALS, sense } from "./sensors.js";
import { createBrain } from "./brains/index.js";

export const W = 800, H = 600;
export const VERSION = 5;
export const TPS = 20; // скорость мира по умолчанию: тиков в секунду (на сервере — настройка TPS)

// Все периоды мира — в тиках. При TPS=20 тысяча тиков ≈ 50 секунд.
export const RULES = {
  birthCooldown: 6000,       // пауза между рождениями во всём мире
  minBreedAge: 1200,         // размножаться можно с этого возраста
  breedStrength: 60,         // сила обоих для размножения
  predatorWindow: 12000,     // в этом окне — не больше predatorMax хищников
  predatorMax: 2,
  predatorChance: 1 / 6000,  // шанс появления хищника в каждом тике
  predatorHunt: 4800,        // столько хищник охотится, потом уходит
  humidityEvery: 6000,       // волна влажности
  rainEvery: [15000, 30000], // дождь — случайно, раз в 15–30 тысяч тиков
  rainLength: 1200,          // и идёт столько тиков, держа влажность почти на 100%
  moldGrow: 600,             // колония плесени растёт
  moldLife: [3600, 6000],    // и живёт (вторую половину — отмирает)
  newcomerAfter: 12000,      // пришелец, если столько тиков нет самки или самца
  hungryAfter: 8000,         // столько тиков без еды — и здоровье начинает таять
  weakFromHunger: 3000,      // с этого момента без еды агент слабеет и замедляется (сильнее всего к hungryAfter)
  predatorStarve: 3000,      // столько тиков погони без укуса — и хищник начинает слабеть
  survivalHealth: 35,        // здоровье ниже — включается инстинкт выживания
  restBelow: 20,             // сила ниже — отдыхает
  sleepBelow: 3,             // сила ниже — засыпает
  sleepLength: [600, 1200],  // сон длится
  boredAbove: 60,            // скука выше — реагирует вяло
  rivalryCooldown: 200,      // самец не толкается чаще
  maxAgents: 14,
};

export const SPECIES = {
  green: { name: "Зелёный", plural: "Зелёные", sex: "♂", sexName: "самцы", color: "#46c27a", brain: "associative", caution: 0 },
  // Красные (самки) — врождённо осторожнее: раньше замечают и осознают опасность, реже дерутся,
  // раньше включают инстинкт выживания и при угрозе бегут к своим
  red: { name: "Красный", plural: "Красные", sex: "♀", sexName: "самки", color: "#e2554f", brain: "neural", caution: 1 },
};
export const FEMALE_SHARE = 0.65; // самок рождается чаще

// Гены развития агентов: 0…1, наследуются (среднее родителей + мутация). Каждый чем-то полезен
// и чего-то стоит — отбор сам решает, что выгоднее в этом мире.
export const GENES = [
  { id: "help", name: "Взаимопомощь", hint: "идёт на помощь, когда хищник напал на сородича; вместе отбиваются легче" },
  { id: "speed", name: "Скорость", hint: "быстрее бегает и делает рывки, но рывок дороже по силе" },
  { id: "aggro", name: "Агрессия", hint: "чаще дерётся, чем бежит; сильнее бьёт хищника и соперников" },
  { id: "obs", name: "Наблюдательность", hint: "замечает хищника, еду и сородичей издалека" },
  { id: "react", name: "Реакция", hint: "быстрее поворачивает и мгновенно пугается; может проснуться при нападении" },
  { id: "emp", name: "Сочувствие", hint: "делится силой со слабым сородичем; близость радует сильнее" },
  { id: "cunning", name: "Хитрость", hint: "хищник реже выбирает целью; в погоне может сбить его со следа" },
  { id: "breed", name: "Инстинкт размножения", hint: "у самцов: полный сил ищет самку и готов к спариванию при меньшей силе; увлёкшись, позже замечает хищника. Самки передают ген сыновьям" },
];

// Гены хищников — эволюция свободная: потомки самых удачливых охотников с мутациями
export const PREDATOR_GENES = [
  { id: "speed", name: "Скорость" },
  { id: "endurance", name: "Выносливость" },
  { id: "sense", name: "Чутьё" },
  { id: "bite", name: "Укус" },
  { id: "guile", name: "Коварство" },
];

const randn = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const steer = (obj, tx, ty, max) => {
  const t = Math.atan2(ty - obj.y, tx - obj.x);
  obj.a += clamp(Math.atan2(Math.sin(t - obj.a), Math.cos(t - obj.a)), -max, max);
};
const mutate = (v, sigma = 0.05, jumpChance = 0.25, jump = 0.22) =>
  clamp(v + randn() * sigma + (Math.random() < jumpChance ? randn() * jump : 0), 0, 1);

export class World {
  constructor(data) {
    data = data && data.version === VERSION ? data : null;
    this.version = VERSION;
    this.tick = data?.tick ?? 0;
    this.serial = data?.serial ?? 0;
    this.humidity = data?.humidity ?? 0;
    this.lastHumidity = data?.lastHumidity ?? 0;
    this.rainLeft = data?.rainLeft ?? 0;
    this.nextRain = data?.nextRain ?? Math.round(rnd(...RULES.rainEvery));
    this.lastRain = data?.lastRain ?? null;
    this.lastBirth = data?.lastBirth ?? -RULES.birthCooldown;
    this.missingSince = data?.missingSince ?? {};
    this.predatorSpawns = data?.predatorSpawns ?? [];
    this.molds = data?.molds ?? [];
    this.predators = data?.predators ?? [];
    this.predatorHof = data?.predatorHof ?? []; // лучшие охотники — родители будущих хищников
    this.predatorGen = data?.predatorGen ?? 0;
    this.predatorStats = data?.predatorStats ?? { spawned: 0, kills: 0, died: 0 };
    this.stats = data?.stats ?? {};
    this.hof = data?.hof ?? {};
    this.log = data?.log ?? [];
    this.geneHistory = data?.geneHistory ?? [];
    this.lives = [];
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
    for (let i = 0; i < 7; i++) this.spawnMold(null, null, true);
    this.agents = [];
    this.predators = [];
    this.spawnAgent("green", null, null, W * 0.4, H / 2);
    this.spawnAgent("red", null, null, W * 0.6, H / 2);
    this.note("Мир создан: Зелёный и Красная. Они ещё ничего о нём не знают.");
  }

  // ---------- плесень, влажность, дождь ----------
  spawnMold(x, y, grown) {
    if (this.molds.length >= 30) return;
    const peak = rnd(35, 60);
    this.molds.push({
      x: clamp(x ?? rnd(30, W - 30), 10, W - 10), y: clamp(y ?? rnd(30, H - 30), 10, H - 10),
      biomass: grown ? peak : 3, peak, age: grown ? RULES.moldGrow : 0,
      life: Math.round(rnd(...RULES.moldLife)),
    });
  }

  stepEnvironment() {
    if (this.tick - this.lastHumidity >= RULES.humidityEvery) this.raiseHumidity();
    if (!this.rainLeft && this.tick >= this.nextRain) this.startRain();
    if (this.rainLeft > 0) {
      this.rainLeft--;
      this.humidity = Math.min(1, this.humidity + 0.002);
      if (!this.rainLeft) this.note("Дождь закончился.");
    } else this.humidity *= 0.9997;
    if (this.humidity > 0.2 && Math.random() < (this.humidity - 0.2) * 0.013) this.spawnMold();

    for (let i = this.molds.length - 1; i >= 0; i--) {
      const m = this.molds[i];
      m.age++;
      if (m.age < RULES.moldGrow) m.biomass = Math.min(m.peak, m.biomass + (m.peak / RULES.moldGrow) * (0.5 + this.humidity));
      else if (m.age > m.life * 0.5) m.biomass -= m.peak / (m.life * 0.5);
      if (m.biomass <= 0.5) this.molds.splice(i, 1);
    }

    this.predatorSpawns = this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow);
    if (this.agents.length && this.predatorSpawns.length < RULES.predatorMax && Math.random() < RULES.predatorChance) this.spawnPredator();
  }

  startRain() {
    this.rainLeft = RULES.rainLength;
    this.lastRain = this.tick;
    this.nextRain = this.tick + RULES.rainLength + Math.round(rnd(...RULES.rainEvery));
    this.humidity = Math.min(1, this.humidity + 0.6);
    this.note("Пошёл дождь: влажность резко поднялась.");
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
    // Родитель — победитель «турнира» двух случайных охотников из зала славы
    let genes, gen = 1;
    const hof = this.predatorHof;
    if (hof.length) {
      const a = hof[Math.floor(Math.random() * hof.length)], b = hof[Math.floor(Math.random() * hof.length)];
      const parent = a.fitness >= b.fitness ? a : b;
      genes = Object.fromEntries(PREDATOR_GENES.map((g) => [g.id, mutate(parent.genes[g.id], 0.06, 0.3, 0.2)]));
      gen = parent.gen + 1;
    } else genes = Object.fromEntries(PREDATOR_GENES.map((g) => [g.id, rnd(0.15, 0.4)]));
    this.predatorGen = Math.max(this.predatorGen, gen);
    this.serial++;
    this.predatorStats.spawned++;
    this.predators.push({
      id: this.serial, gen, genes, x, y, a: Math.atan2(H / 2 - y, W / 2 - x),
      hp: 130 + 90 * genes.bite, maxHp: 130 + 90 * genes.bite, stamina: 100, tired: false,
      age: 0, stunned: 0, confused: 0, leaving: false, target: null, kills: 0, dealt: 0,
      chase: 0, weak: 0, // слабость от долгой неудачной охоты, 0…1
    });
    const top = PREDATOR_GENES.reduce((m, g) => (genes[g.id] > genes[m.id] ? g : m));
    this.note(`Появился хищник поколения ${gen}` + (genes[top.id] > 0.55 ? ` — особенно силён в «${top.name.toLowerCase()}» (${genes[top.id].toFixed(2)}).` : "."));
  }

  retirePredator(p, why) {
    // Удачливость охотника: добыча и нанесённый урон. Лучшие становятся родителями следующих.
    const fitness = p.kills * 300 + p.dealt + Math.min(p.age, RULES.predatorHunt) / 100;
    this.predatorHof.push({ fitness, gen: p.gen, genes: p.genes, kills: p.kills });
    this.predatorHof.sort((a, b) => b.fitness - a.fitness);
    for (const h of this.predatorHof) h.fitness *= 0.96; // старые заслуги тускнеют
    if (this.predatorHof.length > 8) this.predatorHof.length = 8;
    if (why === "died") this.predatorStats.died++;
  }

  stepPredators() {
    for (let i = this.predators.length - 1; i >= 0; i--) {
      const p = this.predators[i], g = p.genes;
      p.age++;
      if (p.age > RULES.predatorHunt && !p.leaving) {
        p.leaving = true; this.note("Хищник так и не наелся и уходит.");
        // пережившие погоню становятся смелее
        for (const a of this.agents) if (dist(a, p) < 200) { const f0 = a.fear, c0 = a.courage; a.courage += 3; this.balanceFearCourage(a, f0, c0); }
      }
      if (p.stamina < 15 && !p.tired) { p.tired = true; this.note("Хищник выдохся и остановился передохнуть."); }
      if (p.tired && p.stamina > 60) p.tired = false;
      const drain = 1.4 - 0.8 * g.endurance; // выносливые устают медленнее
      // Слабость от неудачной охоты: долго гонится и не может укусить — слабеет и замедляется
      p.chase ??= 0; p.weak ??= 0;
      const wasWeak = p.weak >= 0.5;
      p.weak = clamp((p.chase - RULES.predatorStarve) / (RULES.predatorStarve * 1.5), 0, 1);
      if (!wasWeak && p.weak >= 0.5) this.note("Хищник ослаб от неудачной охоты и замедлился.");
      if (p.weak > 0.5) p.hp -= 0.01 * p.weak;
      const slow = 1 - 0.45 * p.weak;
      let speed = (1.3 + 0.6 * g.speed) * slow;
      if (p.stunned > 0) { p.stunned--; speed = -1.2; p.stamina += 0.05; }
      else if (p.tired) { speed = 0.5 * slow; p.stamina += 0.15 * (1 - 0.5 * p.weak); p.a += rnd(-0.1, 0.1); }
      else if (p.leaving) {
        speed = 1.8;
        p.a = Math.atan2(0, (p.x < W / 2 ? -20 : W + 20) - p.x);
      } else if (p.confused > 0) {
        p.confused--; p.target = null; p.a += rnd(-0.3, 0.3); p.stamina += 0.05; // сбит со следа
      } else {
        // Выбирает самую заметную добычу: хитрость и сон влияют на заметность, чутьё — на дальность
        let prey = null, bestScore = Infinity, best = Infinity;
        const range = 220 + 200 * g.sense;
        for (const a of this.agents) {
          const vis = (1 - 0.6 * a.genes.cunning) * (a.sleep > 0 ? 1.3 : 1) * (a.mode === "hide" ? 0.4 : 1), d = dist(a, p);
          if (d < range * vis && d / vis < bestScore) { bestScore = d / vis; best = d; prey = a; }
        }
        p.target = prey?.id ?? null;
        if (prey) {
          p.chase++;
          if (best < 50 && p.stamina > 25) { speed = (1.8 + 0.6 * g.speed) * slow; p.stamina -= 0.3 * drain; }
          else p.stamina -= 0.025 * drain;
          steer(p, prey.x, prey.y, 0.12);
        } else { p.a += rnd(-0.15, 0.15); p.stamina += 0.1; }
      }
      p.x += Math.cos(p.a) * speed; p.y += Math.sin(p.a) * speed;
      if (!p.leaving) {
        if (p.x < 5 || p.x > W - 5) p.a = Math.PI - p.a;
        if (p.y < 5 || p.y > H - 5) p.a = -p.a;
        p.x = clamp(p.x, 5, W - 5); p.y = clamp(p.y, 5, H - 5);
      }
      p.stamina = clamp(p.stamina);
      if (p.hp <= 0) {
        this.retirePredator(p, "died");
        this.predators.splice(i, 1);
        this.note("Агенты отбились: хищник погиб.");
        continue;
      }
      if (p.leaving && (p.x < -15 || p.x > W + 15)) { this.retirePredator(p, "left"); this.predators.splice(i, 1); }
    }
  }

  // ---------- агенты ----------
  spawnAgent(species, parentA, parentB, x, y) {
    this.serial++;
    const sp = SPECIES[species];
    let brain, genes;
    if (parentA && parentB) {
      const own = parentA.species === species ? parentA : parentB;
      const other = own === parentA ? parentB : parentA;
      brain = own.brain.child(other.brain);
      genes = Object.fromEntries(GENES.map((g) => [g.id, mutate((parentA.genes[g.id] + parentB.genes[g.id]) / 2)]));
    } else {
      const best = this.hof[species]?.[0];
      brain = best ? createBrain(best.brain.type, best.brain).child() : createBrain(sp.brain);
      genes = Object.fromEntries(GENES.map((g) => [g.id, best?.genes?.[g.id] != null ? mutate(best.genes[g.id], 0.08, 0) : rnd(0, 0.15)]));
    }
    const a = {
      id: this.serial, name: `${sp.name}-${this.serial}`, species, genes, brain,
      gen: parentA ? Math.max(parentA.gen, parentB?.gen ?? 0) + 1 : (this.hof[species]?.[0]?.gen ?? 0) + 1,
      parents: parentA ? [parentA.name, parentB?.name].filter(Boolean) : [],
      x: x ?? rnd(60, W - 60), y: y ?? rnd(60, H - 60), a: rnd(0, Math.PI * 2),
      strength: parentA ? 55 : 80, health: 100, emotions: 70, boredom: 0, rage: 0,
      // Страх и Смелость — опыт этой особи (не наследуются); вместе не больше 100
      fear: 20 + 20 * sp.caution, courage: 15,
      hunger: 0, sleep: 0, alert: 0, lastPush: -RULES.rivalryCooldown,
      mode: "active", age: 0, ate: 0, trail: [],
    };
    this.agents.push(a);
    return a;
  }

  // Страх и смелость вместе не больше 100: что выросло сильнее за шаг, то вытесняет другое
  balanceFearCourage(a, fear0, courage0) {
    a.fear = clamp(a.fear); a.courage = clamp(a.courage);
    if (a.fear + a.courage > 100) {
      if (a.fear - fear0 >= a.courage - courage0) a.courage = 100 - a.fear;
      else a.fear = 100 - a.courage;
    }
  }

  nearestFemale(a) {
    let best = null, bd = Infinity;
    for (const o of this.agents) if (o.species === "red") { const d = dist(a, o); if (d < bd) { bd = d; best = o; } }
    return best;
  }

  aggroLevel(a) {
    return clamp(a.genes.aggro * 60 + a.rage); // врождённая агрессия + текущая ярость
  }

  stepAgent(a) {
    const g = a.genes;
    const before = { strength: a.strength, emotions: a.emotions, health: a.health };
    a.fear ??= 20; a.courage ??= 15;
    const fear0 = a.fear, courage0 = a.courage;
    const isMale = a.species === "green";
    const touch = {};
    a.age++;
    a.hunger++;
    // Голод: чем дольше без еды, тем слабее и медленнее (0…1)
    const starving = clamp((a.hunger - RULES.weakFromHunger) / (RULES.hungryAfter - RULES.weakFromHunger), 0, 1);
    // Инстинкт выживания: ранен — спасает жизнь любой ценой; голоден — ищет еду, а не скучает
    const caution = SPECIES[a.species].caution;
    const wounded = a.health < RULES.survivalHealth + 15 * caution;
    const hungry = a.hunger > RULES.hungryAfter * 0.6;
    const bored = a.boredom > RULES.boredAbove && !hungry && !wounded;
    const perception = (130 + 120 * g.obs) * (bored ? 0.7 : 1) * (1 + 0.5 * caution);

    // Что вокруг
    let threat = null, nearestPred = Infinity;
    for (const p of this.predators) if (!p.leaving) { const d = dist(a, p); if (d < nearestPred) { nearestPred = d; threat = p; } }
    let nearKin = Infinity, nearMate = Infinity, kinUnderAttack = null, kinNearest = null;
    for (const o of this.agents) {
      if (o === a) continue;
      const d = dist(a, o);
      if (d < nearKin) { nearKin = d; kinNearest = o; }
      if (o.species !== a.species) nearMate = Math.min(nearMate, d);
      if (d < perception && !kinUnderAttack) for (const p of this.predators) if (!p.leaving && !p.stunned && dist(p, o) < 16) kinUnderAttack = p;
    }
    let foodNear = false, foodTarget = null, foodDist = Infinity;
    for (const m of this.molds) {
      if (m.biomass <= 3) continue;
      const d = dist(a, m);
      if (d < perception) { foodNear = true; if (d < foodDist) { foodDist = d; foodTarget = m; } }
    }

    // ---- сон ----
    if (a.sleep > 0) {
      a.mode = "sleep";
      a.sleep--;
      a.strength += 0.03 * (1 - 0.7 * starving);
      const attacked = threat && nearestPred < 16;
      if (attacked && Math.random() < 0.02 + 0.1 * g.react) { a.sleep = 0; a.rage += 20; this.note(`${a.name} проснулся от нападения хищника.`); }
      // инстинкт: раненый чутко спит — хищник рядом будит
      else if (threat && nearestPred < 70 && a.health < 60 && Math.random() < 0.05 + 0.1 * g.react) { a.sleep = 0; this.note(`${a.name} почуял хищника во сне и проснулся.`); }
      if (a.strength >= 50) a.sleep = 0;
    } else {
      // ---- бодрствование ----
      const turn = a.brain.act(sense(this, a));
      a.a += turn * 0.3 * (0.6 + 0.8 * g.react) * (bored ? 0.5 : 1);

      // Реакция: чем выше, тем быстрее агент осознаёт опасность
      a.alert = threat && nearestPred < perception ? a.alert + 1 : 0;
      // увлечённый самкой самец позже замечает опасность; пугливый — раньше
      const courting = isMale && g.breed > 0.2 && a.strength > 50 && nearMate < 250 && nearMate > 25 && !hungry;
      const aware = a.alert > (1 - g.react) * 30 * (1 - 0.6 * caution) * (1 - 0.5 * a.fear / 100) * (courting ? 1 + g.breed : 1);
      // осторожные и пугливые реже решаются драться, смелые — чаще
      const aggr = this.aggroLevel(a) * (1 - 0.5 * caution) * (1 - 0.5 * a.fear / 100) + 0.4 * a.courage;
      const panic = a.fear > 70 && threat && nearestPred < perception * 1.3;
      const canFight = a.strength > 30;
      a.mode = "active";
      // осторожная затаивается: хищник виден, но далеко и не идёт за ней — замирает
      const hide = caution && aware && nearestPred > 90 && threat.target !== a.id && !hungry;
      if (hide) a.mode = "hide";
      else if (aware && wounded) a.mode = "survive"; // инстинкт сильнее агрессии: раненый бежит
      else if ((aware || panic) && a.fear > 70) a.mode = "flee"; // паника: бежит, даже если угроза далеко
      else if (aware && canFight && aggr > 45) a.mode = "fight";
      else if (kinUnderAttack && canFight && (g.help > 0.3 || a.courage > 60) && a.strength > 30 + 30 * caution - 0.3 * a.courage && (!threat || nearestPred > 20 || aggr > 30)) a.mode = "help";
      else if (aware) a.mode = "flee";
      else if (a.strength < RULES.restBelow && !hungry) a.mode = "rest";
      else if (hungry && foodTarget) a.mode = "forage";
      else if (courting && kinNearest) a.mode = "court";
      else if (bored) a.mode = "bored";

      if (a.mode === "fight" && nearestPred < 80) steer(a, threat.x, threat.y, 0.2);
      if (a.mode === "survive") steer(a, 2 * a.x - threat.x, 2 * a.y - threat.y, 0.25); // прочь от хищника
      if (a.mode === "forage") steer(a, foodTarget.x, foodTarget.y, 0.15);
      if (a.mode === "court") { const f = this.nearestFemale(a); if (f) steer(a, f.x, f.y, 0.1 + 0.15 * g.breed); }
      if (a.mode === "help") steer(a, kinUnderAttack.x, kinUnderAttack.y, 0.25);

      // Скорость: рывок возможен только при достаточной силе; усталость замедляет
      const sprinting = (a.mode === "flee" || a.mode === "help" || (a.mode === "fight" && nearestPred < 80)) && a.strength > 25;
      const adrenaline = a.mode === "survive" && a.strength > 5; // выброс адреналина: последние силы — в бег
      let speed = adrenaline ? 2.1 + 1.0 * g.speed : sprinting ? 1.5 + 1.0 * g.speed : 1.2 + 0.2 * g.speed;
      speed *= adrenaline ? 0.85 : 0.6 + 0.4 * (a.strength / 100);
      speed *= 1 - 0.4 * starving; // голодный медленнее
      if (a.mode === "rest") speed = 0.5;
      if (a.mode === "hide") speed = 0.15;
      if (bored) speed *= 0.8;
      let nx = a.x + Math.cos(a.a) * speed, ny = a.y + Math.sin(a.a) * speed;
      if (nx < 4 || nx > W - 4) { a.a = Math.PI - a.a; nx = clamp(nx, 4, W - 4); }
      if (ny < 4 || ny > H - 4) { a.a = -a.a; ny = clamp(ny, 4, H - 4); }
      a.x = nx; a.y = ny;

      // Сила: тратится на жизнь, движение, рывки и драки; гены тоже чего-то стоят
      const upkeep = 0.0006 * GENES.reduce((s, x) => s + g[x.id], 0);
      if (a.mode === "rest" || a.mode === "hide") a.strength += 0.004 * (1 - starving); // голодному отдых почти не помогает
      else a.strength -= 0.005 + upkeep + (sprinting ? 0.02 * (1 + 0.5 * g.speed) : 0) + (adrenaline ? 0.04 : 0);
      if (a.mode === "fight" || a.mode === "help") a.strength -= 0.01;

      // Еда
      for (const m of this.molds) {
        if (m.biomass > 1 && dist(a, m) < 6 + m.biomass / 6 && a.strength < 100) {
          const bite = Math.min(0.6, m.biomass);
          m.biomass -= bite; a.strength += bite; a.hunger = 0;
          touch.mold = (touch.mold || 0) + bite * 15;
          a.boredom -= 0.5;
          if (!a.ate++) this.note(`${a.name} впервые нашёл плесень и поел.`);
          break;
        }
      }

      if (a.strength < RULES.sleepBelow && a.mode !== "fight") {
        a.sleep = Math.round(rnd(...RULES.sleepLength));
        this.note(`${a.name} выбился из сил и уснул.`);
      }

      // Сочувствие: делится силой со слабым сородичем рядом
      if (g.emp > 0.3 && a.strength > 50) {
        for (const o of this.agents) {
          if (o === a || dist(a, o) > 30 || !(o.health < 50 || o.strength < 15)) continue;
          const share = 0.05 * g.emp;
          a.strength -= share; o.strength += share; a.emotions += 0.02;
          if (a.age % 400 === 0) this.note(`${a.name} делится силой с ослабевшим ${o.name}.`);
          break;
        }
      }

      // Хитрость: в погоне может сбить хищника со следа
      if (threat && threat.target === a.id && nearestPred < 80 && a.age % 20 === 0 && Math.random() < g.cunning * 0.25 * (1 - threat.genes.guile)) {
        threat.confused = 100;
        this.note(`${a.name} сбил хищника со следа.`);
      }
    }

    // ---- здоровье ----
    if (a.health < 100 && a.strength > 40 && a.emotions >= 15) { a.health += 0.02; a.strength -= 0.02; }
    if (a.emotions < 15) a.health -= 0.01;               // тоска
    if (a.hunger > RULES.hungryAfter) a.health -= 0.015; // голод

    // ---- эмоции ----
    if (nearestPred < 150 * (1 + 0.3 * caution)) a.emotions -= 0.12 * (1 - this.aggroLevel(a) / 170);
    if (a.strength < 20) a.emotions -= 0.01;
    if (touch.mold) a.emotions += 0.03;
    if (nearKin < 45) { a.emotions += 0.06 * (1 + g.emp); touch.partner = 8; }
    if (nearKin < 200) a.emotions += (65 - a.emotions) * 0.0005;
    else a.emotions -= a.emotions * 0.00012; // одиночество

    // ---- страх и смелость ----
    if (threat && nearestPred < 150) a.fear += 0.006 * (1 - a.courage / 120); // хищник рядом пугает (смелого — меньше)
    if (a.mode === "help" || a.mode === "fight") a.courage += 0.015;          // встретить угрозу лицом — значит решаться
    if (!threat) { a.fear -= 0.012; a.courage -= 0.0005; }                    // в безопасности страх уходит быстро, смелость — медленно

    // ---- скука ----
    const interesting = foodNear || nearMate < 150 || (threat && nearestPred < perception * 1.5);
    a.boredom += interesting ? -0.15 : 0.02;

    // ---- ярость остывает ----
    a.rage -= 0.02;

    // ---- нападение хищника ----
    for (const p of this.predators) {
      if (p.stunned || p.leaving || dist(a, p) > 13) continue;
      const bite = (0.1 + 0.15 * p.genes.bite) * (p.tired ? 0.4 : 1) * (a.sleep > 0 ? 1.5 : 1);
      a.health -= bite; p.dealt += bite;
      p.chase = Math.max(0, (p.chase ?? 0) - 15); // укус возвращает хищнику силы
      a.emotions -= 0.3; a.rage += 0.2; a.fear += 0.12 * (1 - a.courage / 150);
      touch.predator = -25;
      if (a.age % 20 === 0 && a.sleep <= 0 && a.strength > 10) {
        // рядом сражающиеся сородичи помогают отбиться
        const helpers = this.agents.filter((o) => o !== a && (o.mode === "fight" || o.mode === "help") && dist(o, p) < 30);
        for (const h of helpers) p.hp -= 1.5 * (0.5 + h.strength / 50);
        const aggr = this.aggroLevel(a);
        p.hp -= 2 * (aggr / 100) * (0.5 + a.strength / 50);
        const chance = (a.strength / 300) * (1 + 1.5 * (aggr / 100)) * (1 + 0.4 * helpers.length) * (1 - 0.5 * starving) * (1 + 0.5 * a.courage / 100);
        if (Math.random() < chance) {
          p.stunned = 80; p.hp -= (8 + a.strength / 8) * (1 + aggr / 100);
          a.strength -= 3; a.courage += 10;
          for (const h of helpers) h.courage = clamp((h.courage ?? 15) + 4);
          if (a.strength > 60) { p.x += (p.x - a.x) * 2; p.y += (p.y - a.y) * 2; } // сильный отталкивает хищника
          this.note(helpers.length ? `${a.name} с помощью сородичей отбился от хищника.` : `${a.name} отбился от хищника.`);
        }
      }
    }

    a.strength = clamp(a.strength); a.health = clamp(a.health); a.emotions = clamp(a.emotions);
    a.boredom = clamp(a.boredom); a.rage = clamp(a.rage);
    this.balanceFearCourage(a, fear0, courage0);

    // ---- учёба ----
    const reward = (a.strength - before.strength) / 10 + (a.health - before.health) / 4 + (a.emotions - before.emotions) / 20;
    for (const e of a.brain.learn({ reward, touch })) {
      const sig = SIGNALS.find((s) => s.id === e.signal).name;
      this.note(e.good ? `${a.name} понял: ${sig} — это хорошо.` : `${a.name} понял: ${sig} — опасно.`);
    }

    if (this.tick % 3 === 0) { a.trail.push([Math.round(a.x), Math.round(a.y)]); if (a.trail.length > 40) a.trail.shift(); }
  }

  // Соперничество: самцы рядом с самкой толкаются. Побеждает тот, у кого больше силы с учётом агрессии.
  stepRivalry() {
    const males = this.agents.filter((a) => a.species === "green" && a.sleep <= 0 && a.strength > 15);
    if (males.length < 2) return;
    const females = this.agents.filter((a) => a.species === "red");
    for (const f of females)
      for (let i = 0; i < males.length; i++)
        for (let j = i + 1; j < males.length; j++) {
          const m1 = males[i], m2 = males[j];
          if (dist(m1, f) > 60 || dist(m2, f) > 60 || dist(m1, m2) > 40) continue;
          if (this.tick - m1.lastPush < RULES.rivalryCooldown || this.tick - m2.lastPush < RULES.rivalryCooldown) continue;
          const power = (m) => m.strength * (0.5 + this.aggroLevel(m) / 100) * rnd(0.8, 1.2);
          const [win, lose] = power(m1) >= power(m2) ? [m1, m2] : [m2, m1];
          const ang = Math.atan2(lose.y - f.y, lose.x - f.x);
          lose.x = clamp(lose.x + Math.cos(ang) * 30, 4, W - 4); lose.y = clamp(lose.y + Math.sin(ang) * 30, 4, H - 4);
          win.strength -= 3; lose.strength -= 2;
          const f0w = win.fear, c0w = win.courage, f0l = lose.fear, c0l = lose.courage;
          win.courage += 3; lose.fear += 3;
          this.balanceFearCourage(win, f0w, c0w); this.balanceFearCourage(lose, f0l, c0l);
          win.rage = clamp(win.rage + 15); lose.rage = clamp(lose.rage + 15);
          lose.emotions = clamp(lose.emotions - 10);
          win.lastPush = lose.lastPush = this.tick;
          if (Math.random() < 0.3) this.note(`${win.name} оттолкнул ${lose.name} от ${f.name}.`);
        }
  }

  tryBreed() {
    if (this.tick - this.lastBirth < RULES.birthCooldown || this.agents.length >= RULES.maxAgents) return;
    const need = (a) => RULES.breedStrength - (a.species === "green" ? 20 * a.genes.breed : 0); // инстинкт самца снижает порог
    const ready = this.agents.filter((a) => a.strength >= need(a) && a.emotions >= 40 && a.age > RULES.minBreedAge && a.sleep <= 0 && a.boredom < 80 && (a.fear ?? 0) < 85);
    for (const a of ready.filter((x) => x.species === "green"))
      for (const b of ready.filter((x) => x.species === "red")) {
        if (dist(a, b) > 30) continue;
        const species = Math.random() < FEMALE_SHARE ? "red" : "green";
        const child = this.spawnAgent(species, a, b, (a.x + b.x) / 2, (a.y + b.y) / 2);
        a.strength -= 30; b.strength -= 30;
        a.emotions = clamp(a.emotions + 20); b.emotions = clamp(b.emotions + 20);
        a.boredom = 0; b.boredom = 0;
        this.lastBirth = this.tick;
        this.stats[species].births++;
        this.note(`У ${a.name} и ${b.name} ${species === "red" ? "родилась" : "родился"} ${child.name} (поколение ${child.gen}).`);
        for (const gd of GENES) {
          const v = child.genes[gd.id], parentsAvg = (a.genes[gd.id] + b.genes[gd.id]) / 2;
          if (v >= 0.25 && v - parentsAvg >= 0.12) this.note(`У ${child.name} проявилась ${gd.name.toLowerCase()}: ${v.toFixed(2)} (у родителей ${parentsAvg.toFixed(2)}).`);
        }
        this.recordGenes();
        return;
      }
  }

  // Пришелец: если долго нет самки или самца, извне приходит особь недостающего пола
  checkLonelySex() {
    if (!this.agents.length) return;
    for (const sp of Object.keys(SPECIES)) {
      if (this.agents.some((a) => a.species === sp)) { this.missingSince[sp] = null; continue; }
      this.missingSince[sp] ??= this.tick;
      if (this.tick - this.missingSince[sp] >= RULES.newcomerAfter) {
        const a = this.spawnAgent(sp, null, null, Math.random() < 0.5 ? 10 : W - 10, rnd(60, H - 60));
        this.missingSince[sp] = null;
        this.note(`Извне пришёл${sp === "red" ? "а" : ""} ${a.name}: ${RULES.newcomerAfter} тиков в мире не было ${sp === "red" ? "самок" : "самцов"}.`);
      }
    }
  }

  recordGenes() {
    if (!this.agents.length) return;
    const avg = {};
    for (const g of GENES) avg[g.id] = +(this.agents.reduce((s, x) => s + x.genes[g.id], 0) / this.agents.length).toFixed(3);
    this.geneHistory.push({ t: this.tick, gen: Math.max(...this.agents.map((x) => x.gen)), ...avg });
    if (this.geneHistory.length > 300) this.geneHistory.shift();
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
    hof.push({ fitness: a.age, name: a.name, gen: a.gen, genes: a.genes, brain: a.brain.toJSON() });
    hof.sort((x, y) => y.fitness - x.fitness); if (hof.length > 5) hof.length = 5;
    this.lives.push({ species: a.species, name: a.name, gen: a.gen, age: a.age, eaten: a.ate, endedAt: this.tick, brain: { ...a.brain.toJSON(), genes: a.genes } });
    this.agents.splice(this.agents.indexOf(a), 1);
    // гибель сородича на глазах пугает тех, кто рядом
    if (cause === "predator") for (const o of this.agents) if (dist(o, a) < 150) { const f0 = o.fear, c0 = o.courage; o.fear += 12; this.balanceFearCourage(o, f0, c0); }
    const why = cause === "predator" ? "погиб от хищника" : cause === "hunger" ? "умер от голода" : "угас от тоски";
    this.note(`${a.name} ${why}, прожив ${a.age} тиков.`);
    if (cause === "predator") {
      const p = this.predators.find((p) => dist(p, a) < 20 && !p.leaving);
      if (p) { p.kills++; p.leaving = true; this.predatorStats.kills++; } // сытый хищник уходит
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
        this.die(a, byPredator ? "predator" : a.hunger > RULES.hungryAfter ? "hunger" : "sorrow");
      }
    }
    this.stepRivalry();
    this.tryBreed();
    this.checkLonelySex();
    if (!this.agents.length) {
      this.note("Все агенты погибли. Жизнь начинается заново: новая пара от лучших предков.");
      for (const p of this.predators) this.retirePredator(p, "left");
      this.predators = [];
      this.spawnAgent("green", null, null, W * 0.4, H / 2);
      this.spawnAgent("red", null, null, W * 0.6, H / 2);
    }
  }

  // ---------- управление ----------
  action(type, p = {}) {
    switch (type) {
      case "humidity": this.raiseHumidity(); break;
      case "rain":
        if (this.rainLeft) throw new Error("Дождь уже идёт.");
        this.startRain();
        break;
      case "predator":
        if (this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow).length >= RULES.predatorMax)
          throw new Error(`Лимит: не больше ${RULES.predatorMax} хищников за ${RULES.predatorWindow} тиков.`);
        this.spawnPredator();
        break;
      case "mold": this.spawnMold(+p.x, +p.y); break;
      case "reset": {
        const fresh = new World();
        Object.assign(this, fresh);
        break;
      }
      default: throw new Error("Неизвестное действие: " + type);
    }
  }

  note(text) {
    this.log.unshift({ t: this.tick, text });
    if (this.log.length > 80) this.log.length = 80;
  }

  // ---------- для интерфейса и базы ----------
  predatorGeneAvg() {
    const src = this.predators.length ? this.predators : this.predatorHof;
    if (!src.length) return null;
    return Object.fromEntries(PREDATOR_GENES.map((g) => [g.id, +(src.reduce((s, p) => s + p.genes[g.id], 0) / src.length).toFixed(2)]));
  }

  view() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      version: VERSION, tick: this.tick, W, H, tpsBase: TPS,
      humidity: r1(this.humidity * 100),
      nextHumidity: Math.max(0, RULES.humidityEvery - (this.tick - this.lastHumidity)),
      raining: this.rainLeft, sinceRain: this.lastRain == null ? null : this.tick - this.lastRain,
      nextBirth: Math.max(0, RULES.birthCooldown - (this.tick - this.lastBirth)),
      predatorsInWindow: this.predatorSpawns.filter((t) => this.tick - t < RULES.predatorWindow).length,
      molds: this.molds.map((m) => [Math.round(m.x), Math.round(m.y), r1(m.biomass), m.age > m.life * 0.5 ? 1 : 0]),
      predators: this.predators.map((p) => ({
        id: p.id, gen: p.gen, x: r1(p.x), y: r1(p.y), a: +p.a.toFixed(2),
        hp: Math.round((p.hp / p.maxHp) * 100), stamina: Math.round(p.stamina), tired: p.tired, weak: +(p.weak ?? 0).toFixed(2),
        stunned: p.stunned > 0, confused: p.confused > 0, leaving: p.leaving,
        genes: Object.fromEntries(PREDATOR_GENES.map((g) => [g.id, +p.genes[g.id].toFixed(2)])),
      })),
      agents: this.agents.map((a) => ({
        id: a.id, name: a.name, species: a.species, gen: a.gen, parents: a.parents,
        x: r1(a.x), y: r1(a.y), a: +a.a.toFixed(3), age: a.age, mode: a.mode,
        genes: Object.fromEntries(GENES.map((g) => [g.id, +a.genes[g.id].toFixed(2)])),
        strength: Math.round(a.strength), health: Math.round(a.health), emotions: Math.round(a.emotions),
        boredom: Math.round(a.boredom), aggression: Math.round(this.aggroLevel(a)), hunger: a.hunger,
        satiety: Math.round(clamp(100 - (a.hunger / RULES.hungryAfter) * 100)),
        fear: Math.round(a.fear ?? 0), courage: Math.round(a.courage ?? 0),
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
    return {
      log: this.log.slice(0, 40), species, geneHistory: this.geneHistory.slice(-120),
      predators: { gen: this.predatorGen, ...this.predatorStats, genes: this.predatorGeneAvg() },
      brains: Object.fromEntries(this.agents.map((a) => [a.id, a.brain.summary()])),
    };
  }

  toJSON() {
    return {
      version: VERSION, tick: this.tick, serial: this.serial, humidity: this.humidity, lastHumidity: this.lastHumidity,
      rainLeft: this.rainLeft, nextRain: this.nextRain, lastRain: this.lastRain,
      lastBirth: this.lastBirth, missingSince: this.missingSince, predatorSpawns: this.predatorSpawns,
      molds: this.molds, predators: this.predators, predatorHof: this.predatorHof, predatorGen: this.predatorGen,
      predatorStats: this.predatorStats, stats: this.stats, hof: this.hof, log: this.log, geneHistory: this.geneHistory,
      agents: this.agents.map(({ trail, brain, ...a }) => ({ ...a, brain: brain.toJSON() })),
    };
  }
}
