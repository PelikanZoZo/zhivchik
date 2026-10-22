// Арена: прогоняет мир без интерфейса, чтобы посмотреть баланс.
// Запуск: node tools/arena.js [реальных_часов]
import { World, TPS } from "../public/sim/world.js";

const HOURS = +(process.argv[2] || 3);
const TICKS = HOURS * 3600 * TPS;
const w = new World();
const t0 = Date.now();
let extinct = 0, maxPop = 0;
const origNote = w.note.bind(w);
w.note = (text) => { if (text.startsWith("Все агенты")) extinct++; origNote(text); };
for (let t = 1; t <= TICKS; t++) {
  w.step();
  maxPop = Math.max(maxPop, w.agents.length);
  if (t % (30 * 60 * TPS) === 0) {
    const d = w.details().species;
    const pop = w.agents.map((a) => `${a.name[0]}(э${Math.round(a.energy)} з${Math.round(a.health)} с${Math.round(a.strength)})`).join(" ");
    console.log(`${(t / 3600 / TPS).toFixed(1)}ч | живых ${w.agents.length} | плесени ${w.molds.length} | влажн ${Math.round(w.humidity * 100)}% | ` +
      Object.entries(d).map(([s, v]) => `${s}: рожд ${v.births} смерт ${v.deaths} съед ${v.eaten}`).join(" | ") + ` | ${pop}`);
  }
}
console.log(`вымираний: ${extinct}, макс. население: ${maxPop}, ${HOURS} ч за ${Date.now() - t0} мс`);
