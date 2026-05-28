# Ошибка «Нет связи с API» — что проверить

## Главная причина

Адрес `https://voluntis-api.onrender.com` **сейчас не ведёт на ваш сервер** (на Render нет запущенного Web Service с этим именем).

Проверка в браузере: откройте  
`https://voluntis-api.onrender.com/api/health`

- Если видите **Not Found** — бэкенд **не задеплоен** или URL **другой**.
- Должно быть: `{"ok":true,"service":"voluntis-api"}`

## Что сделать

1. Зайдите на [dashboard.render.com](https://dashboard.render.com).
2. Должен быть **Web Service** (не Static Site) со статусом **Live**.
3. Скопируйте **его** URL (например `https://voluntis-xxxx.onrender.com`).
4. На сайте Netlify: **Вход / Регистрация** → блок **«Связь с API»** → вставьте URL → **Сохранить URL** → **Проверить**.
5. Если проверка зелёная — войдите: `admin@example.com` / `admin`.

## Создать сервис на Render (если нет)

- **+ New** → **Web Service**
- Репозиторий с проектом → **Root Directory:** `backend`
- **Build:** `npm install` → **Start:** `node server.js`
- **Free** → **Create Web Service** → дождаться **Live**

Подробно: `DEPLOY-NETLIFY.md`
