# Полный сброс мира и опыта (по просьбе 23.10 09:28). Ждём, пока новый код поднимется, потом сигнал.
sleep 40
grep -a "\[живчик" ~/log/devalby.ru.error.log | grep -a "я хозяин" | tail -1
mkdir -p ~/devalby.ru/www/tmp && touch ~/devalby.ru/www/tmp/wipe-request && echo "сигнал сброса отправлен"
for i in $(seq 1 20); do sleep 3; [ -f ~/devalby.ru/www/tmp/wipe-request ] || break; done
echo "=== журнал"
grep -a "\[живчик" ~/log/devalby.ru.error.log | grep -a "сброс\|загрузил мир\|я хозяин" | tail -4
echo "=== резервные копии"; ls -la ~/devalby.ru/backup 2>&1 | tail -3
echo "=== файл сигнала"; ls ~/devalby.ru/www/tmp/
