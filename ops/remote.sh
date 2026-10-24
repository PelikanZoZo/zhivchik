# Почему сайт отвечает редиректом: файлы, конфиги, журналы
echo "=== ~/"; ls -la ~ 2>&1 | head -30
echo "=== ~/devalby.ru"; ls -la ~/devalby.ru 2>&1
echo "=== www"; ls -la ~/devalby.ru/www 2>&1
echo "=== .htaccess и конфиги"; find ~ -maxdepth 3 \( -name ".htaccess" -o -name "*.conf" -o -name "nginx*" \) 2>/dev/null | head; for f in $(find ~ -maxdepth 3 -name ".htaccess" 2>/dev/null); do echo "--- $f"; head -30 "$f"; done
echo "=== журналы"; ls -la ~/log 2>&1 | head
echo "--- error.log, конец"; tail -25 ~/log/devalby.ru.error.log 2>&1 | grep -av "pass"
echo "--- access.log, конец"; ls ~/log/ | grep -i access | head -3; tail -8 ~/log/*access* 2>/dev/null | cut -c1-220
echo "=== изнутри"; curl -s -o /dev/null -w "http://devalby.ru/api/health -> %{http_code} %{redirect_url}\n" --max-time 20 http://devalby.ru/api/health
