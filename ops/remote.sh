# Повторная проверка через несколько минут: сколько раз сменился хозяин
sleep 120
echo "=== время"; date -u +%T
echo "=== записи сервера с 18:08:21"
grep -a "\[живчик" ~/log/devalby.ru.error.log | awk '{ if ($2 >= "18:08:21") print }' | tail -30
echo "=== смен хозяина с 18:08:21:"; grep -a "\[живчик" ~/log/devalby.ru.error.log | awk '{ if ($2 >= "18:08:22") print }' | grep -c "я хозяин мира"
