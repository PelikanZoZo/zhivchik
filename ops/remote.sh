# Запуск Киры вручную на хостинге: что мешает стартовать
export PATH=/usr/nvm/versions/node/v21.5.0/bin:$PATH
echo "=== имена переменных окружения у процесса сайта"
for p in $(pgrep -f "unit-http/loader app.js" | head -1); do tr "\0" "\n" < /proc/$p/environ 2>/dev/null | cut -d= -f1 | sort | tr "\n" " "; echo; done
echo "=== пробный запуск"
cd ~/devalby.ru/www && KIRA_NO_LISTEN=1 timeout 20 node -e '
  const { loadDotEnv, readConfig } = await import("./src/config.js");
  loadDotEnv(); const c = readConfig();
  console.log("секреты в .env:", ["adminPassword","bridgeSecret"].map(k => k + "=" + (c[k] ? "есть" : "НЕТ")).join(" "), "deepseek=" + (c.deepseek.key ? "есть" : "НЕТ"));
  console.log("база:", c.db.database ? "имя задано" : "имя НЕ задано", c.db.user ? "пользователь задан" : "пользователь НЕ задан", "хост", c.db.host);
  const { createApp } = await import("./src/server.js");
  try { const app = createApp(c); await app.services(); console.log("сервисы: ОК"); } catch (e) { console.log("сервисы: ОШИБКА", e.message); }
  process.exit(0);
' --input-type=module 2>&1 | grep -av "pass"
