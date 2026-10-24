# После создания базы: что запущено, есть ли параметры базы, стартует ли Кира
export PATH=/usr/nvm/versions/node/v21.5.0/bin:$PATH
echo "=== процессы"; ps -eo pid,lstart,args 2>/dev/null | grep -a "app.js\|node" | grep -av grep | cut -c1-200
echo "=== папки"; ls -la ~ ~/devalby.ru ~/devalby.ru/www 2>&1 | grep -v "^total"
echo "=== имена переменных у процесса сайта"
for p in $(pgrep -f "loader" | head -2); do echo "pid $p:"; tr "\0" "\n" < /proc/$p/environ 2>/dev/null | cut -d= -f1 | sort | tr "\n" " "; echo; done
echo "=== журнал сайта"; tail -30 ~/log/devalby.ru.error.log 2>&1 | grep -aiv "pass" | cut -c1-250
echo "=== пробный запуск"
cd ~/devalby.ru/www && KIRA_NO_LISTEN=1 timeout 25 node --input-type=module -e '
  const { loadDotEnv, readConfig } = await import("./src/config.js");
  loadDotEnv(); const c = readConfig();
  console.log("база:", c.db.database ? "имя задано" : "имя НЕ задано", c.db.user ? "пользователь задан" : "пользователь НЕ задан", "хост:", c.db.host === "localhost" ? "localhost" : "задан");
  const { createApp } = await import("./src/server.js");
  try { const app = createApp(c); await app.services(); console.log("сервисы: ОК"); } catch (e) { console.log("сервисы: ОШИБКА", e.message); }
  process.exit(0);
' 2>&1 | grep -av "assword"
echo "=== локально"; curl -s --max-time 15 http://127.0.0.1/ -H "Host: devalby.ru" | head -c 200; echo
