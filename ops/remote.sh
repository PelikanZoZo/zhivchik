# Разбор ошибок в журнале после выкладки 0.3
echo "=== ошибки за последний час (заголовки)"
grep -a -n -E "Error|error:|Cannot|ER_|Живчик|хозяин|зритель|Потерял|Выложена" ~/log/devalby.ru.error.log | tail -40
echo "=== контекст последней ошибки"
n=$(grep -a -n -E "^[A-Za-z]*Error|Error:" ~/log/devalby.ru.error.log | tail -1 | cut -d: -f1)
[ -n "$n" ] && sed -n "$((n-5)),$((n+8))p" ~/log/devalby.ru.error.log
echo "=== процессы"
ps -eo pid,lstart,args | grep -a "^ *[0-9].*node --loader" | grep -av grep
