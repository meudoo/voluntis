# VOLUNTIS — выпуск сайта одним способом (только Render)

Один сервис = один адрес в интернете. Сайт и вход работают без Netlify.

**Итог:** вы откроете ссылку вида `https://voluntis-xxxx.onrender.com` — это полноценный сайт.

---

# ЧАСТЬ 1. Загрузить проект на GitHub

Без GitHub Render не подключит код. Делайте один раз.

## 1.1. Регистрация на GitHub

1. Откройте [github.com](https://github.com)
2. **Sign up** — email, пароль, имя пользователя
3. Подтвердите почту, если попросят

## 1.2. Новый репозиторий

1. Войдите в GitHub
2. Справа вверху **«+»** → **«New repository»**
3. Заполните:
   - **Repository name:** `voluntis` (или `diplom`)
   - **Public**
   - **НЕ** ставьте галочки «Add a README», «Add .gitignore», «Choose a license»
4. **«Create repository»**

## 1.3. Загрузить папку «дипломм» с компьютера

На странице пустого репозитория GitHub покажет подсказки. Проще всего — **Git** в PowerShell:

```powershell
cd C:\Users\user\Desktop\дипломм
git init
git add .
git commit -m "VOLUNTIS"
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/voluntis.git
git push -u origin main
```

Замените:
- `ВАШ_ЛОГИН` — ваш логин GitHub
- `voluntis` — имя репозитория, если другое

**Если Git не установлен:** [git-scm.com/download/win](https://git-scm.com/download/win) → установить → снова команды выше.

При `git push` GitHub попросит войти (логин + пароль или токен).

**Проверка:** на GitHub в репозитории видны папки `backend`, `public`, файл `render.yaml`.

---

# ЧАСТЬ 2. Регистрация на Render

1. Откройте [render.com](https://render.com)
2. **Get Started** / **Sign Up**
3. **Sign up with GitHub** (рекомендуется)
4. **Authorize Render** — разрешить доступ
5. Откроется **Dashboard** (главная панель)

---

# ЧАСТЬ 3. Создать Web Service (ваш сайт в интернете)

## 3.1. Начать

1. На Dashboard нажмите **«+ New»** (справа вверху, синяя кнопка)
2. Выберите **«Web Service»**  
   (не Static Site, не PostgreSQL, не Background Worker)

## 3.2. Подключить репозиторий

1. Блок **«Connect a repository»**
2. Если GitHub не подключён:
   - **«Connect GitHub»** / **«Configure account»**
   - **Install** → выберите **Only select repositories**
   - Отметьте репозиторий `voluntis` (или как назвали)
   - **Install** / **Save**
3. В списке найдите свой репозиторий
4. Справа от него нажмите **«Connect»**

## 3.3. Настройки (скопируйте точно)

Откроется форма **«Create a Web Service»**.

| Поле | Что выбрать / вписать |
|------|------------------------|
| **Name** | `voluntis` (латиница, без пробелов) |
| **Region** | Frankfurt (EU Central) или ближайший |
| **Branch** | `main` |
| **Root Directory** | `backend` ← **обязательно** |
| **Runtime** | **Node** |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |

**Instance Type:**

- Выберите **Free** ($0/month)

**Advanced** (можно раскрыть):

- **Health Check Path:** `/api/health` (если есть поле)

**Environment Variables** — можно не добавлять.

## 3.4. Запуск

1. Внизу страницы **«Create Web Service»**
2. Откроется страница сервиса, вкладка **«Logs»**
3. Статусы сверху:
   - **Building** — устанавливаются пакеты (3–10 мин)
   - **Deploying** — запуск сервера
   - **Live** — зелёный, сайт работает

**Успех в логах:** строка вроде `Server: http://localhost:10000`

## 3.5. Скопировать адрес сайта

1. Вверху страницы сервиса блок **URL**
2. Ссылка вида: `https://voluntis.onrender.com` или `https://voluntis-xxxx.onrender.com`
3. Нажмите **иконку копирования** или выделите ссылку

**Это и есть ваш опубликованный сайт.** Сохраните в закладки.

---

# ЧАСТЬ 4. Проверка

## 4.1. API

В браузере откройте (подставьте свой URL):

```
https://ВАШ-URL.onrender.com/api/health
```

Должно быть:

```json
{"ok":true,"service":"voluntis-api"}
```

- **Not Found** — подождите Live или проверьте **Root Directory = backend**
- Долго грузится — бесплатный Render «просыпается», подождите до 1 минуты

## 4.2. Сайт

Откройте:

```
https://ВАШ-URL.onrender.com/
```

Должна открыться главная VOLUNTIS.

## 4.3. Вход

1. **Вход / Регистрация**
2. Email: `admin@example.com`
3. Пароль: `admin`
4. **Войти**

Должно войти без ошибок про API (всё на одном домене).

---

# ЧАСТЬ 5. Что сказать на защите диплома

«Сайт развёрнут на облачном хостинге Render как Node.js Web Service. Фронтенд и REST API работают на одном сервере, база — SQLite.»

Ссылка: ваш URL с Render.

---

# Частые проблемы

## Build failed

- **Root Directory** должен быть **`backend`**, не пусто и не корень репозитория
- В репозитории на GitHub есть `backend/package.json` и `backend/server.js`

## Live, но страница Not Found

- Открывайте корень: `https://...onrender.com/` (со слэшем в конце можно)
- В репозитории есть папка **`public`** с `index.html` (рядом с `backend`, не внутри)

## Вход не работает / ошибка API

- Вы открываете **URL Render**, а не старый `voluntis.netlify.app`
- Netlify для этого способа **не нужен**

## Сайт очень долго открывается

- На Free-тарифе Render засыпает после ~15 мин без посетителей
- Первый заход после сна: 30–60 сек — нормально, обновите страницу

## Забыли пароль админа / пустая база

После пересборки на Render база может обнулиться. Снова: `admin@example.com` / `admin` (создаётся при первом запуске).

---

# Локально (без интернета)

```powershell
cd C:\Users\user\Desktop\дипломм\backend
npm install
npm start
```

Браузер: **http://localhost:3000**

---

# Схема (одна кнопка в голове)

```
GitHub (код)
    ↓
Render Web Service (backend + public)
    ↓
https://ваш-сайт.onrender.com  ← одна ссылка для всего
```

**Netlify, deploy-site, BACKEND_URL — не используйте** при этом способе.
