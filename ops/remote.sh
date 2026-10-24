# Разведка 3: в чём блок Telegram — DNS или имя в TLS
echo "=== DNS api.telegram.org"; getent hosts api.telegram.org || echo "не резолвится"
for ip in 149.154.167.220 149.154.166.110; do
  printf 'api.telegram.org через %s -> ' "$ip"
  curl -sS --max-time 15 --resolve api.telegram.org:443:$ip -o /dev/null -w "HTTP %{http_code} за %{time_total}с\n" https://api.telegram.org/ 2>&1 | tail -1
done
printf 'IP без имени, getMe-подобный путь -> '; curl -sS -k --max-time 15 -o /dev/null -w "HTTP %{http_code}\n" https://149.154.167.220/bot123:abc/getMe 2>&1 | tail -1
