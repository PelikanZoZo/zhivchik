# Какие поисковые сервисы доступны с хостинга
for u in "https://html.duckduckgo.com/html/?q=%D0%93%D0%BB%D0%BE%D1%83%D0%B1%D0%B0%D0%B9%D1%82+%D0%A2%D0%91%D0%B0%D0%BD%D0%BA" \
         "https://lite.duckduckgo.com/lite/?q=globyte" \
         "https://www.bing.com/search?q=globyte&setlang=ru" \
         "https://yandex.ru/search/?text=globyte" \
         "https://searchapi.api.cloud.yandex.net/v2/web/search" \
         "https://api.tavily.com/search" \
         "https://api.search.brave.com/res/v1/web/search?q=test" \
         "https://google.serper.dev/search" \
         "https://ru.wikipedia.org/w/api.php?action=opensearch&search=test" \
         "https://www.tbank.ru/"; do
  printf '%s\n   -> ' "$u"
  curl -s --max-time 20 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" -o /tmp/b.txt -w "HTTP %{http_code}, %{size_download} байт, %{time_total}s" "$u" 2>&1
  echo; head -c 200 /tmp/b.txt | tr -s ' \n\r\t' ' ' | cut -c1-200; echo
done
grep -c 'result__a' /tmp/b.txt 2>/dev/null
curl -s --max-time 20 -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=globyte" | grep -o 'class="result__a"[^>]*>[^<]*' | head -5
