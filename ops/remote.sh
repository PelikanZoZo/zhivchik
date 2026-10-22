# Стабильность после выкладки 0.4: есть ли новые перезапуски
echo "=== время"; date
echo "=== процессы"; ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
echo "=== последние запуски и ошибки"; tail -8 ~/log/devalby.ru.error.log
