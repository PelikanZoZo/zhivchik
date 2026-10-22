// Органы чувств. Два «усика» слева и справа от головы, как у насекомого.
// Каждый усик чувствует запах каждого вещества и холод. Разница между левым и правым
// усиком говорит, куда повернуть, сумма — насколько это близко.
//
// Это единственное, что мозг знает о мире. Никаких координат и названий.

export const KINDS = [
  { id: "green", name: "зелёное", color: "#52c46e" },
  { id: "violet", name: "фиолетовое", color: "#a173e0" },
  { id: "amber", name: "янтарное", color: "#e6a93a" },
];

const ANTENNA_ANGLE = 0.6; // радианы от направления взгляда
const ANTENNA_LEN = 12;
const SMELL_RANGE = 260;

// Порядок входов. Мозг получает массив из SENSOR.SIZE чисел.
let i = 0;
const idx = {};
for (const k of KINDS) { idx["diff_" + k.id] = i++; idx["sum_" + k.id] = i++; }
export const SENSOR = {
  diff: (kind) => idx["diff_" + kind],
  sum: (kind) => idx["sum_" + kind],
  COLD_DIFF: i++,
  COLD_HERE: i++,
  ENERGY: i++,
  BIAS: i++,
};
SENSOR.SIZE = i;

export const SENSOR_LABELS = [
  ...KINDS.flatMap((k) => [`${k.name}: где`, `${k.name}: сколько`]),
  "холод: где", "холод: здесь", "энергия", "смещение",
];

function smellAt(world, x, y) {
  const out = {};
  for (const k of KINDS) out[k.id] = 0;
  for (const it of world.items) {
    const d = Math.hypot(it.x - x, it.y - y);
    if (d > SMELL_RANGE) continue;
    out[it.k] += 1 / (1 + (d / 40) ** 2);
  }
  return out;
}

export function sense(world, c) {
  const lx = c.x + Math.cos(c.a - ANTENNA_ANGLE) * ANTENNA_LEN;
  const ly = c.y + Math.sin(c.a - ANTENNA_ANGLE) * ANTENNA_LEN;
  const rx = c.x + Math.cos(c.a + ANTENNA_ANGLE) * ANTENNA_LEN;
  const ry = c.y + Math.sin(c.a + ANTENNA_ANGLE) * ANTENNA_LEN;
  const L = smellAt(world, lx, ly), R = smellAt(world, rx, ry);
  const s = new Array(SENSOR.SIZE).fill(0);
  for (const k of KINDS) {
    s[SENSOR.diff(k.id)] = Math.tanh((R[k.id] - L[k.id]) * 6);
    s[SENSOR.sum(k.id)] = Math.tanh((R[k.id] + L[k.id]) * 0.8);
  }
  const cl = world.coldAt(lx, ly), cr = world.coldAt(rx, ry);
  s[SENSOR.COLD_DIFF] = Math.tanh((cr - cl) * 10);
  s[SENSOR.COLD_HERE] = world.coldAt(c.x, c.y);
  s[SENSOR.ENERGY] = c.energy / 150;
  s[SENSOR.BIAS] = 1;
  return s;
}
