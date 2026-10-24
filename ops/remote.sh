# Какой размер тела запроса пропускает хостинг (nginx/Unit) — для загрузки файлов кусками
for mb in 0.5 1 2 4 8 12; do
  head -c $(python3 -c "print(int($mb*1024*1024))") /dev/urandom > /tmp/body.bin
  printf '%s МБ -> ' "$mb"
  curl -s -o /tmp/r.txt --max-time 60 -X POST -H "Content-Type: application/octet-stream" --data-binary @/tmp/body.bin -w "HTTP %{http_code} за %{time_total}s | " http://devalby.ru/api/bridge/probe-size
  head -c 120 /tmp/r.txt | tr -s '\n' ' '; echo
done
rm -f /tmp/body.bin
df -h ~ | tail -1
du -sh ~/devalby.ru/files 2>/dev/null || echo "папки files ещё нет"
