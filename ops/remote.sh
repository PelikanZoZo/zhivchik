# Проверка HTTPS у devalby.ru изнутри хостинга
curl -sS --max-time 20 -o /dev/null -w "изнутри: HTTP %{http_code}, сертификат: %{ssl_verify_result} (0 = в порядке)\n" https://devalby.ru/ 2>&1 | tail -1
