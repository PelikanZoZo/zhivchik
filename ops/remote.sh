# Что случилось с миром около 21:45–21:50 UTC
grep -a "\[живчик" ~/log/devalby.ru.error.log | awk '{ if ($2 >= "21:38:00" && $2 <= "21:59:59") print }' | grep -av "я зритель\|запуск, хранилище" | tail -30
echo "=== любые строки не от сервера в это время"
awk 'BEGIN{p=0} /^2026\/10\/23 00:3[89]|^2026\/10\/23 00:[45]/{p=1} p' ~/log/devalby.ru.error.log | grep -av "\[живчик\|application started" | tail -15
