# Проверка HTTPS после подключения сертификата
for u in https://devalby.ru/api/health https://www.devalby.ru/api/health http://devalby.ru/api/health; do printf "%s -> " "$u"; curl -s -o /dev/null --max-time 20 -w "HTTP %{http_code} ssl=%{ssl_verify_result} redirect=%{redirect_url}\n" "$u"; done
echo | openssl s_client -connect devalby.ru:443 -servername devalby.ru 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null
