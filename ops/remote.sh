# Напоминание о продлении сертификата HTTPS (за 5 дней до окончания 23.01.2027)
cd ~/devalby.ru/www && cat > /tmp/kira-job.mjs <<'JS'
const { loadDotEnv, readConfig } = await import(process.cwd() + "/src/config.js");
const { openDb } = await import(process.cwd() + "/src/db.js");
const { JobsModel } = await import(process.cwd() + "/src/jobs/model.js");
loadDotEnv();
const cfg = readConfig();
const db = await openDb(cfg.db);
const jobs = new JobsModel(db, cfg.tz);
const same = (await jobs.list({ status: "active" })).find((j) => /сертификат/i.test(j.title));
if (same) console.log(`уже есть: #${same.id} ${same.title} — ${same.next_run}`);
else {
  const j = await jobs.create({
    title: "Проверить продление сертификата HTTPS",
    message: "Через 5 дней, 23 января, истекает сертификат HTTPS для devalby.ru. Проверь в панели хостинга, что Let's Encrypt его продлил.",
    action: "remind", run_at: "2027-01-18 10:00", created_by: "owner",
  }, "system");
  console.log(`поставлено: #${j.id} «${j.title}» — ${j.next_run} (${j.schedule_text})`);
}
await db.close();
JS
/usr/nvm/versions/node/v21.5.0/bin/node /tmp/kira-job.mjs 2>&1 | grep -v -i "pass"; rm -f /tmp/kira-job.mjs
