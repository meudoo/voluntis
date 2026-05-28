# Публикация VOLUNTIS на Netlify

Сайт состоит из **двух частей**:

| Часть | Где размещается | Что делает |
|--------|-----------------|------------|
| Фронтенд (`public/`) | **Netlify** | Страница, кнопки, интерфейс |
| Бэкенд (`backend/`) | **Render** (бесплатно) | API, база SQLite, вход |

Netlify **не запускает** Node.js-сервер и SQLite. Если загрузить только `index.html`, ссылка откроется, но **вход и заявки не работают** — поэтому нужны оба шага.

---

## Шаг 1. Бэкенд на Render

1. Зарегистрируйтесь на [render.com](https://render.com).
2. **New → Web Service** → подключите репозиторий с проектом (или загрузите папку `backend` через GitHub).
3. Настройки:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. После деплоя скопируйте URL, например:  
   `https://voluntis-api.onrender.com`
5. Проверка в браузере:  
   `https://ВАШ-URL.onrender.com/api/health`  
   Должно быть: `{"ok":true,"service":"voluntis-api"}`

**Админ для демо:** `admin@example.com` / `admin`

---

## Шаг 2. Фронтенд на Netlify

### Вариант A — через Git (рекомендуется)

1. Залейте проект на **GitHub** (папка `дипломм` целиком).
2. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from Git**.
3. Выберите репозиторий.
4. Netlify подхватит `netlify.toml` автоматически:
   - **Build command:** `npm run build:netlify`
   - **Publish directory:** `netlify-publish`
5. **Site settings → Environment variables** → добавьте:

   | Key | Value |
   |-----|--------|
   | `BACKEND_URL` | `https://voluntis-api.onrender.com` (ваш URL с Render, **без** `/` в конце) |

6. **Deploy site** (или **Trigger deploy**).

### Вариант B — перетащить папку (без Git)

В PowerShell в папке проекта:

```powershell
cd C:\Users\user\Desktop\дипломм
$env:BACKEND_URL="https://voluntis-api.onrender.com"
npm run build:netlify
```

Откройте [app.netlify.com/drop](https://app.netlify.com/drop) и перетащите папку **`netlify-publish`** (не `public` и не весь проект).

---

## Структура для деплоя

```
дипломм/
├── netlify.toml          ← настройки Netlify
├── package.json          ← команда build:netlify
├── scripts/
│   └── build-netlify.js  ← собирает netlify-publish/
├── netlify-publish/      ← готовая папка (создаётся сборкой, в .gitignore)
├── public/               ← исходник фронтенда
├── backend/              ← API для Render
├── render.yaml           ← шаблон для Render
└── DEPLOY-NETLIFY.md     ← эта инструкция
```

---

## Локальная разработка (как раньше)

```powershell
cd C:\Users\user\Desktop\дипломм\backend
npm install
npm start
```

Браузер: `http://localhost:3000`

---

## Если ссылка Netlify не работает

1. **Белая страница / 404** — не задана сборка: нужен `npm run build:netlify` и папка `netlify-publish`, не сырой `public`.
2. **Страница есть, но «Ошибка API»** — не задан `BACKEND_URL` на Netlify или неверный URL Render.
3. **Render «спит»** — на бесплатном тарифе первый запрос после простоя 30–60 с; подождите и обновите страницу.
4. **CORS** — фронт на Netlify обращается к Render напрямую; на Render CORS по умолчанию разрешён. При необходимости: `CORS_ORIGIN=https://ваш-сайт.netlify.app`.
5. **«Ошибка API» при входе** — почти всегда неверный или пустой `BACKEND_URL`. Пересоберите сайт на Netlify после добавления переменной.

После смены `BACKEND_URL` на Netlify: **Deploys → Trigger deploy → Clear cache and deploy site**.
