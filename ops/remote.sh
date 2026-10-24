# Перезапуск после перехода на unit-http: останавливаем копии со старым кодом
echo "=== до"; ps -eo pid,lstart,args | grep -a "loader app.js" | grep -av grep
for p in $(pgrep -f "loader app.js"); do kill "$p" 2>/dev/null && echo "остановлен $p"; done
sleep 6
for i in 1 2 3 4; do printf 'health: '; curl -s --max-time 25 http://devalby.ru/api/health; echo; sleep 2; done
echo "=== после"; ps -eo pid,lstart,args | grep -a "loader app.js" | grep -av grep
echo "=== журнал"; tail -12 ~/log/devalby.ru.error.log | grep -aiv pass | cut -c1-200
