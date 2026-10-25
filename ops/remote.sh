# Напоминание о продлении сертификата HTTPS — через API сайта (вход паролем из .env, пароль не выводится)
cd ~/devalby.ru/www && cat > /tmp/kira-job.mjs <<'JS'
const { loadDotEnv } = await import(process.cwd() + "/src/config.js");
loadDotEnv();
const base = "https://devalby.ru";
const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
if (!login.ok) { console.log("вход не удался:", login.status); process.exit(1); }
const cookie = login.headers.get("set-cookie").split(";")[0];
const h = { "Content-Type": "application/json", Cookie: cookie, Origin: base };
const list = await (await fetch(base + "/api/jobs?status=active", { headers: h })).json();
const same = (list.jobs || []).find((j) => /сертификат/i.test(j.title));
if (same) { console.log(`уже есть: #${same.id} ${same.title} — ${same.next_run}`); process.exit(0); }
const r = await fetch(base + "/api/jobs", { method: "POST", headers: h, body: JSON.stringify({
  title: "Проверить продление сертификата HTTPS",
  message: "Через 5 дней, 23 января, истекает сертификат HTTPS для devalby.ru. Проверь в панели хостинга, что Let's Encrypt его продлил.",
  action: "remind", run_at: "2027-01-18 10:00",
}) });
const d = await r.json();
console.log(r.ok ? `поставлено: #${d.job.id} «${d.job.title}» — ${d.job.next_run} (${d.job.schedule_text}); придёт: «${d.job.message}»` : `ошибка: ${r.status} ${d.error}`);
JS
/usr/nvm/versions/node/v21.5.0/bin/node /tmp/kira-job.mjs 2>&1 | grep -v -i "password"; rm -f /tmp/kira-job.mjs
