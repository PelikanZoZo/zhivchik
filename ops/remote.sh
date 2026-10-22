# После выкладки: хозяин загрузил прежний мир? ошибки?
sleep 45
grep -a "\[живчик" ~/log/devalby.ru.error.log | grep -a "загрузил мир\|НОВЫЙ МИР\|я хозяин" | tail -2
echo "=== ошибки за 3 минуты"; awk -v d="$(date -d '-3 min' '+%Y/%m/%d %H:%M')" 'BEGIN{p=0} /^20[0-9][0-9]\//{p=($0>=d)} p && /Error/' ~/log/devalby.ru.error.log | tail -5
