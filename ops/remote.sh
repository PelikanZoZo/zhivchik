# Разведка хостинга под новый проект: сеть наружу, HTTPS, cron, Node, MySQL
echo "=== время"; date -u +%T
echo "=== доступные версии Node"; ls /usr/nvm/versions/node/ 2>&1
echo "=== выход наружу с хостинга"
for u in https://api.telegram.org https://api.deepseek.com https://news.google.com/rss https://lenta.ru/rss; do
  printf '%s -> ' "$u"; curl -sS --max-time 20 -o /dev/null -w "HTTP %{http_code} за %{time_total}с\n" "$u" 2>&1 | tail -1
done
echo "=== HTTPS у devalby.ru (изнутри)"
curl -sS --max-time 20 -o /dev/null -w "HTTP %{http_code}, сертификат проверен: %{ssl_verify_result}\n" https://devalby.ru/ 2>&1 | tail -1
echo "=== cron"; command -v crontab >/dev/null && { crontab -l >/dev/null 2>&1 && echo "crontab: есть, задания уже заданы" || echo "crontab: есть, заданий нет"; } || echo "crontab: команды нет"
echo "=== MySQL-клиент"; command -v mysql >/dev/null && echo "mysql: есть" || echo "mysql: нет"
echo "=== переменные базы, которые даёт панель (только имена)"
for p in $(pgrep -f "unit-http/loader app.js" | head -1); do tr "\0" "\n" < /proc/$p/environ 2>/dev/null | cut -d= -f1 | grep -iE "db|mysql" | sort | tr "\n" " "; echo; done
echo "=== место на диске"; du -sh ~ 2>/dev/null | cut -f1; quota -s 2>/dev/null | tail -2
