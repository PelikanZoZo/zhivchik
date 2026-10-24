// Планировщик заданий Киры. Своего «будильника» у сайта нет (хостинг может усыплять приложение),
// поэтому раз в минуту его будит Cloudflare Worker, и в этот момент выполняется всё, чему подошло время.

const LATE_GRACE_MIN = 6 * 60; // регулярное задание, опоздавшее больше чем на 6 часов, пропускаем до следующего раза

export const MORNING_INSTRUCTION =
  "Составь план владельца на сегодня: что просрочено, что на сегодня, что в работе, с чего начать. " +
  "Коротко, 3–7 пунктов. Отправь его владельцу через send_message.";

export function createRunner({ jobs, agent, outbox, log = () => {} }) {
  async function runDue({ budgetMs = 50000, max = 10 } = {}) {
    const started = Date.now();
    const done = [];
    while (done.length < max && Date.now() - started < budgetMs) {
      const due = await jobs.due(5);
      if (!due.length) break;
      let progressed = false;
      for (const job of due) {
        if (Date.now() - started >= budgetMs) break;
        if (!(await jobs.claim(job.id))) continue;
        progressed = true;
        done.push(await execute(job));
      }
      if (!progressed) break;
    }
    return done;
  }

  async function execute(job, { manual = false } = {}) {
    const planned = job.next_run_at ? new Date(job.next_run_at) : new Date();
    const lateMin = Math.max(0, Math.round((Date.now() - planned.getTime()) / 60000));
    const runId = await jobs.startRun(job);
    if (!manual && job.schedule !== "once" && lateMin > LATE_GRACE_MIN) {
      const r = await jobs.finish(job, runId, { status: "skipped", result: `Пропущено: опоздание ${Math.round(lateMin / 60)} ч, выполню в следующий раз по расписанию` });
      log(`задание #${job.id} пропущено (опоздание ${lateMin} мин)`);
      return { id: job.id, status: "skipped", next: r.next };
    }
    log(`задание #${job.id} «${job.title}»: выполняю`);
    try {
      let result;
      let meta = null;
      let status = "succeeded";
      if (job.action === "remind") {
        const text = `⏰ ${job.title}${job.instruction ? `\n\n${job.instruction}` : ""}`;
        const r = await outbox.notifyOwner(text, `job:${job.id}`);
        result = r.sent ? "Напоминание отправлено" : `Не отправлено: ${r.reason}`;
        if (!r.sent) status = "skipped";
      } else {
        const api = await jobs.get(job.id);
        const r = await agent.runJob(api, { lateMin, manual });
        result = r.text;
        meta = { tools: r.tools, usage: r.usage };
      }
      const f = await jobs.finish(job, runId, { status, result, meta });
      log(`задание #${job.id}: ${status}`);
      return { id: job.id, status, result, next: f.next };
    } catch (e) {
      log(`задание #${job.id}: ошибка — ${e.message}`);
      const f = await jobs.finish(job, runId, { status: "failed", result: e.message });
      if (f.finalFailure) {
        await outbox.notifyOwner(`Не смогла выполнить задание #${job.id} «${job.title}»: ${e.message}`, `job-fail:${job.id}`).catch(() => {});
      }
      return { id: job.id, status: "failed", error: e.message };
    }
  }

  // Выполнить прямо сейчас (кнопка на сайте или просьба в чате)
  async function runNow(id) {
    const row = await jobs.row(id);
    if (!row) throw new Error(`Нет задания #${id}`);
    if (row.status !== "active") throw new Error("Задание не активно");
    const r = await jobs.db.query(
      "UPDATE jobs SET lock_until = NOW(3) + INTERVAL 10 MINUTE, exec_status = 'running' WHERE id = ? AND (lock_until IS NULL OR lock_until < NOW(3))", [id],
    );
    if (r.affectedRows !== 1) throw new Error("Задание уже выполняется");
    // разовое после ручного запуска считается выполненным; у регулярного расписание идёт дальше
    return execute(await jobs.row(id), { manual: true });
  }

  return { runDue, execute, runNow };
}

// Системные задания, которые есть всегда (сейчас — утренний план). Создаются один раз.
export async function ensureSystemJobs({ jobs, db, cfg }) {
  if (await jobs.getBySystemKey("morning")) return;
  // время могло быть задано раньше командой /morning
  const t = await db.get("morning_time", cfg.morningTime);
  const off = !t || t === "off";
  const [h, m] = (off ? cfg.morningTime : t).split(":").map(Number);
  try {
    const job = await jobs.create({
      title: "Утренний план на день",
      instruction: MORNING_INSTRUCTION,
      action: "do",
      cron: `${m} ${h} * * *`,
      created_by: "system",
      system_key: "morning",
    }, "system");
    if (off) await jobs.update(job.id, { status: "cancelled" }, "system");
  } catch (e) {
    if (!/Duplicate/.test(e.message)) throw e; // другая копия приложения успела создать
  }
}

// Время утреннего плана хранится в системном задании: "08:30" или "off"
export async function getMorningTime({ jobs }) {
  const j = await jobs.getBySystemKey("morning");
  if (!j || j.status !== "active" || !j.cron) return "off";
  const [m, h] = j.cron.split(" ");
  return /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : j.cron;
}

export async function setMorningTime({ jobs }, t, source = "web") {
  const j = await jobs.getBySystemKey("morning");
  if (!j) throw new Error("Нет задания утреннего плана");
  if (t === "off") return jobs.update(j.id, { status: "cancelled" }, source);
  const [h, m] = t.split(":").map(Number);
  return jobs.update(j.id, { cron: `${m} ${h} * * *`, status: "active" }, source);
}
