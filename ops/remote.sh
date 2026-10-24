# Перезапуск: старые копии приложения (со старым кодом) останавливаются, хостинг поднимает новые
date -u > ~/devalby.ru/tmp/restart.txt; date -u > ~/devalby.ru/www/tmp/restart.txt
echo "=== до"; ps -eo pid,lstart,args | grep -a "loader app.js" | grep -av grep
for p in $(pgrep -f "loader app.js"); do kill "$p" 2>/dev/null && echo "остановлен $p"; done
sleep 8
for i in 1 2 3; do curl -s -o /dev/null --max-time 20 -H "Host: devalby.ru" http://127.0.0.1/api/health; done
sleep 3
echo "=== после"; ps -eo pid,lstart,args | grep -a "loader app.js" | grep -av grep
echo "=== ответы"; for i in 1 2 3 4; do curl -s --max-time 20 http://devalby.ru/api/health; echo; done
echo "=== журнал"; tail -8 ~/log/devalby.ru.error.log | grep -aiv pass | cut -c1-200
