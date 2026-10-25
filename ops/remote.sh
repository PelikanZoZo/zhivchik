# Цепочка сертификата: сколько сертификатов отдаёт сервер
echo | openssl s_client -connect devalby.ru:443 -servername devalby.ru -showcerts 2>/dev/null | grep -c "BEGIN CERTIFICATE"
echo | openssl s_client -connect devalby.ru:443 -servername devalby.ru 2>&1 | grep -E "Verify return code|depth" | head -5
curl -s -o /dev/null -w "POST http bridge -> %{http_code} %{redirect_url}\n" -X POST http://devalby.ru/api/bridge/update
grep -a "bridge/update\|bridge/outbox" ~/log/devalby.ru.error.log | tail -3 | cut -c1-100
