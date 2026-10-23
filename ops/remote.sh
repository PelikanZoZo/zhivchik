# Почему сайт не отвечал в 14:45 UTC: процессы, журнал, нагрузка
echo "=== время"; date -u +%T
echo "=== процессы"; ps -eo pid,lstart,pcpu,rss,args | grep -a "node --loader" | grep -av grep
echo "=== записи сервера за 30 минут"
grep -a "\[живчик" ~/log/devalby.ru.error.log | awk -v d="$(date -u -d '-30 min' '+%H:%M:%S')" '{ if ($2 >= d) print }' | grep -av "я зритель\|запуск, хранилище" | tail -15
echo "=== прочие строки журнала за 30 минут"
awk -v d="$(date -d '-30 min' '+%Y/%m/%d %H:%M')" 'BEGIN{p=0} /^20[0-9][0-9]\//{p=($0>=d)} p' ~/log/devalby.ru.error.log | grep -av "\[живчик\|application started" | tail -15
echo "=== запусков за 30 минут"; awk -v d="$(date -d '-30 min' '+%Y/%m/%d %H:%M')" '$0 >= d && /application started/' ~/log/devalby.ru.error.log | wc -l
