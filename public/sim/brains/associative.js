// Ассоциативный мозг (Зелёный). Для каждого сигнала — плесени, хищника, сородича —
// хранит одно число: насколько встреча с этим хороша или плоха. Учится по правилу Рескорлы–Вагнера:
//   ожидание += скорость × (реальность − ожидание)
// Быстро учится, но мыслит только готовыми понятиями.

import { SIGNALS, SENSOR } from "../sensors.js";

const LR = 0.25;

export class AssociativeBrain {
  static type = "associative";

  constructor(data) {
    this.v = {};
    for (const s of SIGNALS) this.v[s.id] = data?.v?.[s.id] ?? 0;
    this.curiosity = data?.curiosity ?? 0.6;
  }

  // Возвращает поворот в диапазоне [-1, 1]
  act(s) {
    let turn = 0;
    for (const sig of SIGNALS) {
      const v = this.v[sig.id];
      const want = v + this.curiosity * 6 * Math.exp(-Math.abs(v) / 6); // к незнакомому немного тянет
      turn += (want / 10) * s[SENSOR.diff(sig.id)];
    }
    turn += (Math.random() - 0.5) * 0.5; // блуждание
    return Math.max(-1, Math.min(1, turn));
  }

  // exp.touch — что агент сейчас испытал от каждого сигнала: { mold: +прибавка, predator: −урон, partner: +эмоции }
  learn(exp) {
    const events = [];
    for (const [id, outcome] of Object.entries(exp.touch || {})) {
      const before = this.v[id];
      const target = Math.max(-30, Math.min(30, outcome));
      this.v[id] += LR * (target - before);
      if (Math.sign(before) !== Math.sign(this.v[id]) && Math.abs(this.v[id]) > 3) events.push({ signal: id, good: this.v[id] > 0 });
    }
    return events;
  }

  onDeath() {}

  // Потомок: если второй родитель тоже ассоциативный — среднее двух памятей, иначе память одного
  child(other) {
    const v = {};
    const mate = other instanceof AssociativeBrain ? other : this;
    for (const s of SIGNALS) v[s.id] = ((this.v[s.id] + mate.v[s.id]) / 2) * 0.8 + (Math.random() - 0.5) * 2;
    return new AssociativeBrain({ v, curiosity: this.curiosity });
  }

  summary() {
    return { type: AssociativeBrain.type, values: { ...this.v } };
  }

  toJSON() {
    return { type: AssociativeBrain.type, v: this.v, curiosity: this.curiosity };
  }
}
