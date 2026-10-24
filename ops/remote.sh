# Разведка 2: что из зарубежного доступно с хостинга (для связи с Telegram)
for u in https://api.telegram.org/ https://149.154.167.220/ https://core.telegram.org https://github.com https://workers.cloudflare.com https://example.workers.dev https://www.google.com https://api.openai.com https://vercel.com https://deno.com; do
  printf '%s -> ' "$u"; curl -sS -k --max-time 15 -o /dev/null -w "HTTP %{http_code} за %{time_total}с\n" "$u" 2>&1 | tail -1
done
echo "=== прокси в окружении"; env | grep -i _proxy | cut -d= -f1
