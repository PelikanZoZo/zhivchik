# Наблюдение за сменой хозяина мира: 4 минуты, затем записи «[живчик …]» из журнала
sleep 240
echo "=== записи сервера за последние 6 минут"
grep -a "\[живчик" ~/log/devalby.ru.error.log | tail -60
echo "=== запусков процессов за 6 минут"
awk -v d="$(date -d '-6 min' '+%Y/%m/%d %H:%M')" '$0 >= d && /application started/' ~/log/devalby.ru.error.log | wc -l
