// Нейромозг: маленькая нейросеть, которая не знает никаких понятий.
// Ей не говорят «это вещество, его надо запомнить». Она получает только сигналы с усиков
// и одно число награды (энергия прибавилась или убавилась), и сама находит, что важно.
//
// Учится двумя способами сразу:
//  1. При жизни — обучение с подкреплением (actor-critic): «критик» учится предсказывать,
//     насколько хорошо текущее положение, «актёр» — поворачивать туда, где лучше, чем ожидалось.
//  2. Между поколениями — нейроэволюция: потомок получает веса родителя с мутациями.

import { SENSOR } from "../sensors.js";

const HIDDEN = 12;
const GAMMA = 0.99;     // насколько важно будущее
const LAMBDA = 0.9;     // как долго помнится след решения
const LR_ACTOR = +(globalThis.process?.env?.NN_LRA ?? 0.003);
const LR_CRITIC = +(globalThis.process?.env?.NN_LRC ?? 0.01);
const SIGMA = 0.35;     // сила исследования: шум в действиях
const MUTATION = 0.08;

const randn = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export class NeuralBrain {
  static type = "neural";

  constructor(data) {
    const n = SENSOR.SIZE;
    this.n = n;
    this.h = HIDDEN;
    this.W1 = data?.W1 ? Float64Array.from(data.W1) : Float64Array.from({ length: HIDDEN * n }, () => randn() * 0.3);
    this.wa = data?.wa ? Float64Array.from(data.wa) : Float64Array.from({ length: HIDDEN }, () => randn() * 0.1);
    // прямые связи «вход → поворот»: на них легко вырастает простой рефлекс
    this.wd = data?.wd ? Float64Array.from(data.wd) : Float64Array.from({ length: n }, () => randn() * 0.3);
    this.wv = data?.wv ? Float64Array.from(data.wv) : new Float64Array(HIDDEN);
    this.prev = null;   // прошлый шаг: вход, скрытый слой, ценность, действие
    this.resetTraces();
    this.reward = 0;
    this.lastDelta = 0;
  }

  forward(x) {
    const hid = new Float64Array(this.h);
    for (let j = 0; j < this.h; j++) {
      let z = 0;
      const o = j * this.n;
      for (let i = 0; i < this.n; i++) z += this.W1[o + i] * x[i];
      hid[j] = Math.tanh(z);
    }
    let m = 0, v = 0;
    for (let i = 0; i < this.n; i++) m += this.wd[i] * x[i];
    for (let j = 0; j < this.h; j++) { m += this.wa[j] * hid[j]; v += this.wv[j] * hid[j]; }
    return { hid, mu: Math.tanh(m), value: v };
  }

  resetTraces() {
    this.eW1a = new Float64Array(this.h * this.n); this.eW1c = new Float64Array(this.h * this.n);
    this.ea = new Float64Array(this.h); this.ev = new Float64Array(this.h); this.ed = new Float64Array(this.n);
  }

  update(p, target) {
    const delta = Math.max(-5, Math.min(5, target - p.value)); // ошибка ожидания: «лучше или хуже, чем думал»
    this.lastDelta = delta;
    const g = ((p.action - p.mu) / (SIGMA * SIGMA)) * (1 - p.mu * p.mu) * 0.1;
    const d = GAMMA * LAMBDA;
    // «Следы»: каждое недавнее решение получает долю заслуги за награду, и чем оно свежее, тем больше
    for (let j = 0; j < this.h; j++) {
      const hj = p.hid[j], dh = 1 - hj * hj;
      this.ea[j] = d * this.ea[j] + g * hj;
      this.ev[j] = d * this.ev[j] + hj;
      const o = j * this.n, ba = g * this.wa[j] * dh, bc = this.wv[j] * dh;
      for (let i = 0; i < this.n; i++) {
        this.eW1a[o + i] = d * this.eW1a[o + i] + ba * p.x[i];
        this.eW1c[o + i] = d * this.eW1c[o + i] + bc * p.x[i];
      }
    }
    for (let i = 0; i < this.n; i++) {
      this.ed[i] = d * this.ed[i] + g * p.x[i];
      this.wd[i] += LR_ACTOR * delta * this.ed[i];
    }
    for (let j = 0; j < this.h; j++) {
      this.wa[j] += LR_ACTOR * delta * this.ea[j];
      this.wv[j] += LR_CRITIC * delta * this.ev[j];
      const o = j * this.n;
      for (let i = 0; i < this.n; i++)
        this.W1[o + i] += delta * (LR_ACTOR * this.eW1a[o + i] + LR_CRITIC * 0.3 * this.eW1c[o + i]);
    }
  }

  act(x) {
    const f = this.forward(x);
    if (this.prev) this.update(this.prev, this.reward + GAMMA * f.value);
    const action = Math.max(-1, Math.min(1, f.mu + randn() * SIGMA));
    this.prev = { x, hid: f.hid, mu: f.mu, value: f.value, action };
    return action;
  }

  learn(exp) {
    this.reward = exp.reward;
    return [];
  }

  onDeath() {
    if (this.prev) this.update(this.prev, this.reward - 3); // смерть — это плохо, и будущего нет
    this.prev = null;
    this.resetTraces();
  }

  child() {
    const mut = (a) => Float64Array.from(a, (w) => w + randn() * MUTATION);
    return new NeuralBrain({ W1: mut(this.W1), wa: mut(this.wa), wd: mut(this.wd), wv: Float64Array.from(this.wv) });
  }

  summary() {
    // Насколько сильно каждый вход влияет на поворот: грубая «карта внимания»
    const influence = Array.from(this.wd);
    for (let j = 0; j < this.h; j++)
      for (let i = 0; i < this.n; i++) influence[i] += this.W1[j * this.n + i] * this.wa[j];
    return { type: NeuralBrain.type, influence, surprise: this.lastDelta };
  }

  toJSON() {
    return { type: NeuralBrain.type, W1: Array.from(this.W1), wa: Array.from(this.wa), wd: Array.from(this.wd), wv: Array.from(this.wv) };
  }
}
