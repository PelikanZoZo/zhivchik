# Перезапуск приложения с новым кодом: старые процессы держат в памяти прошлую версию.
export PATH=/usr/nvm/versions/node/v21.5.0/bin:$PATH
cd ~/devalby.ru/www || exit 1
echo "=== убираю старый server.js (код теперь в src/server.js)"
rm -f server.js && echo "удалён"
echo "=== останавливаю старые процессы"
for p in $(pgrep -u "$(id -u)" -f "^node --loader unit-http"); do echo "стоп $p ($(ps -o lstart= -p $p))"; kill "$p"; done
sleep 3
echo "=== бужу приложение"
curl -sS -o /dev/null -w "devalby.ru: HTTP %{http_code}\n" --max-time 30 http://devalby.ru/ || true
sleep 8
echo "=== процессы сейчас"
ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
echo "=== журнал (хвост)"
tail -25 ~/log/devalby.ru.error.log
# Thu Oct 22 16:56:42 UTC 2026
