# Проверка: хозяин мира должен оставаться одним и тем же
sleep 240
echo "=== записи сервера за последние 4 минуты"
grep -a "\[живчик" ~/log/devalby.ru.error.log | awk -v d="$(date -u -d '-4 min' '+%H:%M:%S')" '{ if ($2 >= d) print }' | tail -40
