# Проверка после выкладки 0.3: перезапустились ли процессы, что в журнале
echo "=== время"; date
echo "=== процессы приложения (время старта)"
ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
echo "=== журнал (хвост)"
tail -15 ~/log/devalby.ru.error.log
echo "=== версия мира в коде"
grep -m1 "VERSION =" ~/devalby.ru/www/public/sim/world.js
