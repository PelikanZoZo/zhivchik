# Проверка нового приложения на хостинге: процессы и журнал
echo "=== процессы"; ps -eo pid,lstart,args 2>/dev/null | grep -a "app.js" | grep -av grep
echo "=== журнал (последние 30 строк про Киру и ошибки)"; tail -200 ~/log/devalby.ru.error.log 2>/dev/null | grep -aiE "кира|error|ошибка|cannot|fail" | tail -30
echo "=== переменные базы у процесса (только имена)"; for p in $(pgrep -f "loader app.js" | head -1); do tr "\0" "\n" < /proc/$p/environ 2>/dev/null | cut -d= -f1 | grep -iE "^db|mysql" | sort | tr "\n" " "; echo; done
