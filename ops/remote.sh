# Версия Node, под которой работает сайт (NGINX Unit)
grep -a "кира" ~/log/devalby.ru.error.log | tail -2 | cut -c1-120
ls -d /usr/local/bin/node* /usr/bin/node* /opt/*/bin/node 2>/dev/null
for n in /usr/bin/node /usr/local/bin/node /opt/node*/bin/node; do [ -x "$n" ] && echo "$n: $($n -v)"; done
ps -eo pid,args | grep -i "unit\|node" | grep -v grep | head -5
cat ~/devalby.ru/.nvmrc 2>/dev/null; ls ~/.nvm/versions/node 2>/dev/null
