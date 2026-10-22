# Почему мир сбрасывается: ищем второй мир в файлах и смену хозяина
cd ~/devalby.ru/www
echo "=== папка data (мир в файлах, если процесс не видит базу)"; ls -la --time-style=+%T data 2>&1
[ -f data/world.json ] && head -c 300 data/world.json && echo
echo "=== процессы"; ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
echo "=== запуски за последние 30 минут"; awk -v d="$(date -d '-30 min' '+%Y/%m/%d %H:%M')" '$0 >= d && /application started/' ~/log/devalby.ru.error.log | wc -l
echo "=== не-info строки за 30 минут"; awk -v d="$(date -d '-30 min' '+%Y/%m/%d %H:%M')" 'BEGIN{p=0} /^20[0-9][0-9]\//{p=($0>=d)} p && !/application started/' ~/log/devalby.ru.error.log | tail -30
