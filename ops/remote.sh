# Проверка после выкладки: мир продолжился (не сбросился), ошибок нет
sleep 60
grep -a "\[живчик" ~/log/devalby.ru.error.log | tail -8
echo "=== ошибки за 3 минуты"; awk -v d="$(date -d '-3 min' '+%Y/%m/%d %H:%M')" 'BEGIN{p=0} /^20[0-9][0-9]\//{p=($0>=d)} p && /Error/' ~/log/devalby.ru.error.log | tail -5
