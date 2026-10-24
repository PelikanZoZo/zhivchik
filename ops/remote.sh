# Структура выдачи Bing (для разбора без ключа) и чтение страниц из Node
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
curl -s --max-time 20 -A "$UA" -H "Accept-Language: ru,en;q=0.8" "https://www.bing.com/search?q=%D0%93%D0%BB%D0%BE%D1%83%D0%B1%D0%B0%D0%B9%D1%82+%D0%A2%D0%91%D0%B0%D0%BD%D0%BA&setlang=ru&cc=RU" -o /tmp/bing.html
echo "размер: $(wc -c < /tmp/bing.html), b_algo: $(grep -o 'class="b_algo' /tmp/bing.html | wc -l)"
python3 - <<'PY' 2>/dev/null || echo "нет python3"
import re
s=open('/tmp/bing.html',encoding='utf-8',errors='replace').read()
blocks=re.findall(r'<li class="b_algo".*?</li>',s,re.S)
for b in blocks[:3]:
    b=re.sub(r'<svg.*?</svg>','',b,flags=re.S)
    b=re.sub(r'(data-[\w-]+|style|aria-[\w-]+|tabindex|h)="[^"]*"','',b)
    print(b[:1400]); print('-----')
PY
echo "--- node:"; ~/.nodejs/bin/node -v 2>/dev/null || node -v || ls ~/bin /usr/local/bin | grep -i node
for u in https://www.tbank.ru/ https://vc.ru/ https://www.rbc.ru/; do curl -s -o /dev/null --max-time 15 -A "$UA" -w "$u -> HTTP %{http_code} ssl=%{ssl_verify_result} %{errormsg}\n" "$u"; done
