# Самый простой способ выпустить VOLUNTIS

## Один сервис вместо двух

Сейчас у вас схема **Netlify + Render** — это сложно (два сайта, URL API, CORS).

**Проще:** только **Render** (или Railway). Один адрес — и сайт, и вход, и API.

Почему это работает: `backend/server.js` уже отдаёт папку `public/` (ваш `index.html`).

```
https://ваш-сервис.onrender.com/          → сайт
https://ваш-сервис.onrender.com/api/login → API
```

Netlify и папка `deploy-site` **не нужны**.

---

## Пошагово (только Render)

### 1. Код на GitHub

Залейте папку **дипломм** в репозиторий GitHub (если ещё нет).

### 2. Render

1. [dashboard.render.com](https://dashboard.render.com) → **+ New** → **Web Service**
2. Выберите репозиторий
3. Настройки:

| Поле | Значение |
|------|----------|
| **Root Directory** | `backend` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | Free |

4. **Create Web Service** → дождитесь **Live**

### 3. Готово

Откройте URL Render в браузере — это **ваш сайт**.

- Вход: `admin@example.com` / `admin`
- Первый запуск после простоя: подождите до 1 минуты

---

## Сравнение

| Способ | Сложность | Что нужно |
|--------|-----------|-----------|
| **Только Render** | ★ проще | 1 аккаунт, 1 сервис |
| Netlify + Render | ★★★ | 2 сервиса, BACKEND_URL, deploy-site |
| Только на компьютере | ★ | `npm start` в backend, только вы видите |

---

## Локально (для защиты / теста)

```powershell
cd C:\Users\user\Desktop\дипломм\backend
npm install
npm start
```

Браузер: http://localhost:3000

---

## Минусы бесплатного Render

- Сервер «засыпает» — первый заход после паузы медленный
- База SQLite на диске Render может **сброситься** при пересборке (для диплома обычно ок)

Для диплома «показать работающий сайт по ссылке» — **одного Render достаточно**.
