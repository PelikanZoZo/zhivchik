// Органы чувств агента. Два «усика» слева и справа от головы.
// Каждый усик чувствует три сигнала: плесень (еда), хищника и сородича.
// Разница между левым и правым усиком говорит, куда повернуть, сумма — насколько это близко.
// Плюс внутренние ощущения: сила, эмоции, здоровье.
//
// Это всё, что мозг знает о мире. Никаких координат и названий.

export const SIGNALS = [
  { id: "mold", name: "плесень", color: "#4f8fe0" },
  { id: "predator", name: "хищник", color: "#b9a2ff" },
  { id: "partner", name: "сородич", color: "#e3ece5" },
];

const ANTENNA_ANGLE = 0.6;
const ANTENNA_LEN = 12;
const RANGE = { mold: 280, predator: 240, partner: 300 };

let i = 0;
const idx = {};
for (const s of SIGNALS) { idx["diff_" + s.id] = i++; idx["sum_" + s.id] = i++; }
export const SENSOR = {
  diff: (id) => idx["diff_" + id],
  sum: (id) => idx["sum_" + id],
  STRENGTH: i++,
  EMOTIONS: i++,
  HEALTH: i++,
  BIAS: i++,
};
SENSOR.SIZE = i;

function field(world, self, x, y) {
  const f = { mold: 0, predator: 0, partner: 0 };
  const k = 1 + 0.8 * (self.genes?.obs ?? 0); // наблюдательность расширяет дальность чувств
  for (const m of world.molds) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < RANGE.mold * k) f.mold += (m.biomass / 40) / (1 + (d / 40) ** 2);
  }
  for (const p of world.predators) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < RANGE.predator * k) f.predator += 1 / (1 + (d / 50) ** 2);
  }
  for (const a of world.agents) {
    if (a === self) continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < RANGE.partner * k) f.partner += 1 / (1 + (d / 50) ** 2);
  }
  return f;
}

export function sense(world, c) {
  const lx = c.x + Math.cos(c.a - ANTENNA_ANGLE) * ANTENNA_LEN;
  const ly = c.y + Math.sin(c.a - ANTENNA_ANGLE) * ANTENNA_LEN;
  const rx = c.x + Math.cos(c.a + ANTENNA_ANGLE) * ANTENNA_LEN;
  const ry = c.y + Math.sin(c.a + ANTENNA_ANGLE) * ANTENNA_LEN;
  const L = field(world, c, lx, ly), R = field(world, c, rx, ry);
  const s = new Array(SENSOR.SIZE).fill(0);
  for (const sig of SIGNALS) {
    s[SENSOR.diff(sig.id)] = Math.tanh((R[sig.id] - L[sig.id]) * 6);
    s[SENSOR.sum(sig.id)] = Math.tanh((R[sig.id] + L[sig.id]) * 0.8);
  }
  s[SENSOR.STRENGTH] = c.strength / 100;
  s[SENSOR.EMOTIONS] = c.emotions / 100;
  s[SENSOR.HEALTH] = c.health / 100;
  s[SENSOR.BIAS] = 1;
  return s;
}
