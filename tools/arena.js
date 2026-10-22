// Арена: прогоняет мир без интерфейса и сравнивает виды мозгов.
// Запуск: node tools/arena.js [тиков] [переворот_каждые]
import { World } from "../public/sim/world.js";

const TICKS = +(process.argv[2] || 200000);
const FLIP = +(process.argv[3] || 0);
const w = new World();
const t0 = Date.now();
for (let t = 1; t <= TICKS; t++) {
  w.step();
  if (FLIP && t % FLIP === 0) w.action("flip");
  if (t % (TICKS / 10) === 0) {
    const d = w.details().species;
    console.log(String(t).padStart(8), Object.entries(d).map(([s, v]) => `${s}: жизнь≈${v.avgLife ?? "-"} смертей=${v.deaths} рекорд=${v.best} пок.=${v.topGen}`).join(" | "));
    for (const s of Object.values(w.stats)) s.recent = [];
  }
}
console.log(`${TICKS} тиков за ${Date.now() - t0} мс`);
