# Кира

Личная система управления проектами и задачами со встроенным ИИ-ассистентом (DeepSeek) в Telegram.
Сайт: https://devalby.ru, бот: @Kira_unic_bot.

## Как устроено

```
Telegram ⇄ Cloudflare Worker (worker/) ⇄ сайт на Masterhost (app.js, src/) ⇄ MySQL
                                                  ⇣
                                              DeepSeek
```

- **Сайт** — Node.js без фреймворков. Веб-интерфейс (`public/`), API, ассистент, логика бота. Всё состояние — в MySQL.
- **Worker** — мост: с хостинга Telegram недоступен, поэтому вебхук Telegram принимает Cloudflare
  и пересылает сообщения на сайт, а сайт возвращает готовые ответы. Раз в минуту Worker забирает с сайта
  то, что бот должен отправить сам (утренний план).
- **Всё хранится во времени**: любое изменение записи сохраняет снимок в `node_history`. Удаление мягкое.

Записи (`nodes`) — проекты, задачи, цели, заметки; дерево через `parent_id`.

## Выкладка

Всё через GitHub Actions, вручную ничего заливать не нужно:

| Что | Когда | Журнал |
|---|---|---|
| Сайт (`deploy-site.yml`) | изменения в `src/`, `public/`, `app.js` | `docs/deploy-log.txt` |
| Бот на Cloudflare (`deploy-worker.yml`) | изменения в `worker/` | `docs/worker-log.txt` |
| Проверка ассистента на живом DeepSeek (`ai-check.yml`) | изменения в `src/ai/`, `src/bot.js` | `docs/ai-check.txt` |
| Проверка секретов (`secrets-check.yml`) | вручную | `docs/secrets-check.txt` |
| Команды на хостинге по SSH (`ssh-ops.yml`) | изменение `ops/remote.sh` | `docs/ops-log.txt` |

Секреты репозитория: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`,
`DEEPSEEK_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `ADMIN_PASSWORD`, `BRIDGE_SECRET`.

Репозиторий публичный: в коде и журналах нет ни паролей, ни данных.

## Бот

Привязка владельца — один раз: `/start <пароль от сайта>`. Остальным бот не отвечает.
Команды: `/plan`, `/today`, `/new`, `/morning 08:30`, `/help`. Остальное — обычным текстом.

## Локально

```
npm install
DB_NAME=kira DB_USER=… DB_PASSWORD=… ADMIN_PASSWORD=… BRIDGE_SECRET=… DEEPSEEK_API_KEY=… node app.js
TEST_DB_NAME=kira_test TEST_DB_USER=… TEST_DB_PASSWORD=… npm test
```

## Дальше по плану

1. ~~Ядро: задачи, проекты, история, вход, бот с DeepSeek, утренний план~~
2. Цели и сценарное древовидное планирование
3. Документы: хранение и ответы по ним
4. Внешние источники: новостные ленты и сбор данных по расписанию
