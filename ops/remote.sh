# Мост после перехода на https: Worker ходит в очередь раз в минуту
sleep 100
grep -a "bridge/" ~/log/devalby.ru.error.log | tail -4 | cut -c1-100
