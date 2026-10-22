// Ассоциативный мозг: для каждого вещества и для холода хранит одно число —
// ожидаемую ценность. Учится по правилу Рескорлы–Вагнера:
//   ожидание += скорость × (реальность − ожидание)
// Это «мозг» уровня улитки: быстро учится, но знает только то, что ему дали в виде понятий.

import { KINDS, SENSOR } from "../sensors.js";

const LR = 0.35;
const COLD_LR = 0.02;

export class AssociativeBrain {
  static type = "associative";

  constructor(data) {
    this.v = {};
    for (const k of KINDS) this.v[k.id] = data?.v?.[k.id] ?? 0;
    this.cold = data?.cold ?? 0;
    this.curiosity = data?.curiosity ?? 0.6;
  }

  // sensors — массив чисел, см. sensors.js. Возвращает поворот в диапазоне [-1, 1].
  act(s) {
    let turn = 0;
    for (const k of KINDS) {
      const v = this.v[k.id];
      // любопытство: к незнакомому (ценность около нуля) немного тянет
      const want = v + this.curiosity * 6 * Math.exp(-Math.abs(v) / 6);
      turn += (want / 10) * s[SENSOR.diff(k.id)];
    }
    turn += (this.cold / 3) * s[SENSOR.COLD_DIFF];
    turn += (Math.random() - 0.5) * 0.5; // блуждание
    return Math.max(-1, Math.min(1, turn));
  }

  // exp: { reward, ate: kindId | null, effect, coldLoss }
  learn(exp) {
    const events = [];
    if (exp.ate) {
      const before = this.v[exp.ate];
      this.v[exp.ate] += LR * (exp.effect - before);
      const surprise = exp.effect - before;
      if (Math.abs(surprise) > 12) events.push({ kind: exp.ate, effect: exp.effect, surprise });
    }
    if (exp.coldLoss > 0) {
      const wasNaive = this.cold > -4;
      this.cold += COLD_LR * (-exp.coldLoss * 40 - this.cold);
      if (wasNaive && this.cold <= -4) events.push({ learnedCold: true });
    }
    return events;
  }

  onDeath() {}

  // Потомок получает ослабленную память родителя и немного случайности
  child() {
    const v = {};
    for (const k of KINDS) v[k.id] = this.v[k.id] * 0.8 + (Math.random() - 0.5) * 2;
    return new AssociativeBrain({ v, cold: this.cold * 0.8, curiosity: this.curiosity });
  }

  summary() {
    return { type: AssociativeBrain.type, values: { ...this.v, cold: this.cold } };
  }

  toJSON() {
    return { type: AssociativeBrain.type, v: this.v, cold: this.cold, curiosity: this.curiosity };
  }
}
