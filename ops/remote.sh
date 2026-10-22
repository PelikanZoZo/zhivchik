# Проверка после выкладки 0.4
sleep 20
echo "=== процессы"; ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
echo "=== новые ошибки"; awk -v d="$(date -d '-3 min' '+%Y/%m/%d %H:%M')" '$0 >= d' ~/log/devalby.ru.error.log | tail -20
grep -m1 "VERSION =" ~/devalby.ru/www/public/sim/world.js
