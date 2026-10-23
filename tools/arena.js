// Арена: прогоняет мир без интерфейса, чтобы посмотреть баланс и эволюцию.
// Запуск: node tools/arena.js [реальных_часов] [отчёт_каждые_часов]
import { World, TPS, GENES, PREDATOR_GENES } from "../public/sim/world.js";

const HOURS = +(process.argv[2] || 3);
const EVERY = +(process.argv[3] || 1);
const TICKS = HOURS * 3600 * TPS;
const w = new World();
const t0 = Date.now();
let extinct = 0, maxPop = 0, predKilled = 0;
const origNote = w.note.bind(w);
w.note = (text) => { if (text.startsWith("Погибли все")) extinct++; if (text.includes("хищник погиб")) predKilled++; origNote(text); };
for (let t = 1; t <= TICKS; t++) {
  w.step();
  maxPop = Math.max(maxPop, w.agents.length);
  if (t % (EVERY * 3600 * TPS) === 0) {
    const d = w.details().species;
    const n = w.agents.length || 1;
    const genes = GENES.map((g) => `${g.id} ${(w.agents.reduce((s, a) => s + a.genes[g.id], 0) / n).toFixed(2)}`).join(" ");
    const pg = w.predatorGeneAvg();
    const pgs = pg ? PREDATOR_GENES.map((g) => `${g.id[0]}${pg[g.id].toFixed(2)}`).join(" ") : "-";
    const gen = Math.max(0, ...w.agents.map((a) => a.gen));
    console.log(`${String(t / 3600 / TPS).padStart(4)}ч | ♂${d.green.alive} ♀${d.red.alive} | пок.${String(gen).padStart(3)} | рожд ${d.green.births + d.red.births} | съед ${d.green.eaten + d.red.eaten} голод ${d.green.deaths + d.red.deaths - d.green.eaten - d.red.eaten} | хищн.убито ${predKilled} ловили ${w.predatorStats.kills} | ${genes} || хищн. пок.${w.predatorGen} ${pgs}`);
  }
}
console.log(`перезапусков мира: ${extinct}, макс. население: ${maxPop}, ${HOURS} ч за ${Date.now() - t0} мс`);
