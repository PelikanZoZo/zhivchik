# Проверка личного чата на хостинге: ответ идёт потоком (не одним куском), в журнал текст не попадает
cd ~/devalby.ru/www && cat > /tmp/kira-pc.mjs <<'JS'
const { loadDotEnv } = await import(process.cwd() + "/src/config.js");
loadDotEnv();
const base = "https://devalby.ru";
const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
const cookie = login.headers.get("set-cookie").split(";")[0];
const t0 = Date.now();
const res = await fetch(base + "/api/private-chat", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base },
  body: JSON.stringify({ messages: [{ role: "user", content: "Перечисли пять самых больших городов России, по одному на строку, без пояснений" }] }) });
console.log("HTTP", res.status, res.headers.get("content-type"));
let chunks = 0, first = null, text = "", meta = null;
const dec = new TextDecoder();
for await (const c of res.body) {
  chunks++; if (first === null) first = Date.now() - t0;
  for (const l of dec.decode(c, { stream: true }).split("\n\n")) {
    if (!l.startsWith("data:")) continue;
    const e = JSON.parse(l.slice(5));
    if (e.done) meta = e; else if (e.error) console.log("ошибка:", e.error); else text += e.content || "";
  }
}
console.log(`кусков по сети: ${chunks}, первый через ${first} мс, всего ${Date.now() - t0} мс`);
console.log("ответ:", JSON.stringify(text));
console.log("модель:", meta?.model, "токены:", JSON.stringify(meta?.usage));
JS
/usr/nvm/versions/node/v21.5.0/bin/node /tmp/kira-pc.mjs 2>&1 | grep -v -i password; rm -f /tmp/kira-pc.mjs
echo "в журнале сайта упоминаний вопроса: $(grep -a -c "больших городов" ~/log/devalby.ru.error.log)"
