/*
 * VOLUNTIS — бэкенд на Node.js + Express.
 * База — один файл SQLite рядом со скриптом (удобно для диплома: не нужен отдельный сервер БД).
 * Сначала поднимаем приложение и вешаем middleware, потом открываем БД и создаём таблицы.
 */
// express — веб-фреймворк (маршруты, middleware, ответы).
const express = require('express');
// sqlite3 — драйвер файловой БД SQLite (асинхронные callback-и).
const sqlite3 = require('sqlite3').verbose();
// path — склеивание путей к public и database.sqlite кроссплатформенно.
const path = require('path');
// cors — заголовок Access-Control-Allow-Origin для fetch с другого порта.
const cors = require('cors');
// crypto — scrypt для пароля и randomBytes для соли/токена.
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

const app = express();
// Экземпляр Express: сюда подключаются middleware и маршруты (app.get, app.post).
// CORS: Netlify и localhost; CORS_ORIGIN — список через запятую (опционально).
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : true;
app.use(
  cors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
// Тело POST/PUT приходит JSON — парсим в объект.
app.use(express.json());
// На каждый запрос пытаемся прочитать Bearer-токен и подставить req.user (если сессия жива).
app.use(authMiddleware);

// Отдаём статику из ../public (index.html, стили и т.д.)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Загруженные фото/видео мероприятий (папка создаётся при старте).
const eventUploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'events');
fs.mkdirSync(eventUploadsDir, { recursive: true });
const EVENT_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
const eventUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, eventUploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov']);
      const safeExt = allowed.has(ext) ? ext : '';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: EVENT_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '');
    if (mime.startsWith('image/') || mime.startsWith('video/')) return cb(null, true);
    cb(new Error('Можно загружать только фото или видео.'));
  },
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]);

// Путь к SQLite: на Render с Persistent Disk укажите DATABASE_PATH=/var/data/database.sqlite
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'database.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);
db.configure('busyTimeout', 5000);

// ----------------------------
// Мини-миграции (чтобы не удалять базу руками)
// SQLite не умеет "ADD COLUMN IF NOT EXISTS", поэтому проверяем через PRAGMA.
// ----------------------------
// Добавляем колонку только если её ещё нет (старые копии базы без миграций не ломаются).
function addColumnIfMissing(table, colName, colDefSql) {
  // Читаем список колонок таблицы из метаданных SQLite.
  db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
    if (err) return; // при ошибке PRAGMA ничего не делаем (редко)
    const has = rows.some(r => r.name === colName); // true, если колонка уже есть
    if (has) return; // повторно не добавляем
    // ALTER ADD COLUMN — дописываем поле к существующей таблице.
    db.run(`ALTER TABLE ${table} ADD COLUMN ${colDefSql}`);
  });
}

// Все CREATE выполняем последовательно (serialize), чтобы не накладывались друг на друга.
db.serialize(() => {
  // Участники: логин, роль, баллы, рейтинг, блокировки.
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'volunteer',
      points INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      ratingSum INTEGER NOT NULL DEFAULT 0,
      ratingCount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      seekerVerified INTEGER NOT NULL DEFAULT 0,
      volunteerVerified INTEGER NOT NULL DEFAULT 0,
      seekerFormStatus TEXT NOT NULL DEFAULT 'not_submitted',
      volunteerFormStatus TEXT NOT NULL DEFAULT 'not_submitted'
    )
  `);

  // Заявки о помощи: кто создал, статус модерации, волонтёр, отмена, сроки.
  db.run(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      createdBy INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignedVolunteerId INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Один ряд = один диалог (связь с пользователями через chat_users).
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Кто в каком чате состоит (составной первичный ключ).
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_users (
      chatId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      PRIMARY KEY (chatId, userId)
    )
  `);

  // Сообщения внутри чата + время прочтения (readAt добавляется миграцией ниже).
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER NOT NULL,
      fromUserId INTEGER NOT NULL,
      text TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Отзывы после завершённых дел (requestId — миграцией).
  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      targetUserId INTEGER NOT NULL,
      fromUserId INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Сессии входа: токен в заголовке Authorization.
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastSeenAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Жалобы пользователей на пользователей; админ потом «разруливает».
  db.run(`
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      targetUserId INTEGER NOT NULL,
      fromUserId INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolvedBy INTEGER,
      resolvedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Мероприятия: публикации команды сайта, лайки и комментарии пользователей.
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      body TEXT,
      imageUrl TEXT,
      videoUrl TEXT,
      createdBy INTEGER NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS event_likes (
      eventId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (eventId, userId)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS event_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      text TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Журнал событий по заявкам (таймлайн на фронте строится отсюда).
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actorUserId INTEGER,
      action TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId INTEGER,
      details TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Ключ–значение: например флаг, что разовая очистка чатов уже выполнялась.
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
});

// Миграции колонок (если база старая — дописываем поля без пересоздания файла).
// Профиль: город, возраст, текст «о себе», соль/хеш пароля, сроки блокировок и лимитов.
addColumnIfMissing('users', 'city', `city TEXT`);
addColumnIfMissing('users', 'age', `age INTEGER`);
addColumnIfMissing('users', 'about', `about TEXT`);
addColumnIfMissing('users', 'passwordSalt', `passwordSalt TEXT`);
addColumnIfMissing('users', 'passwordHash', `passwordHash TEXT`);
addColumnIfMissing('users', 'banReason', `banReason TEXT`);
addColumnIfMissing('users', 'banUntil', `banUntil TEXT`);
addColumnIfMissing('users', 'chatLimitedUntil', `chatLimitedUntil TEXT`);
addColumnIfMissing('users', 'requestsLimitedUntil', `requestsLimitedUntil TEXT`);
addColumnIfMissing('users', 'seekerVerified', `seekerVerified INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('users', 'volunteerVerified', `volunteerVerified INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('users', 'seekerFormStatus', `seekerFormStatus TEXT NOT NULL DEFAULT 'not_submitted'`);
addColumnIfMissing('users', 'volunteerFormStatus', `volunteerFormStatus TEXT NOT NULL DEFAULT 'not_submitted'`);
addColumnIfMissing('users', 'seekerPhone', `seekerPhone TEXT`);
addColumnIfMissing('users', 'volunteerPhone', `volunteerPhone TEXT`);
addColumnIfMissing('users', 'seekerFormNote', `seekerFormNote TEXT`);
addColumnIfMissing('users', 'volunteerFormNote', `volunteerFormNote TEXT`);
addColumnIfMissing('complaints', 'resolveComment', `resolveComment TEXT`);

// Заявка: сложность → баллы, этапы «принял помощь / оба завершили», город, срочность, повторяемость.
addColumnIfMissing('requests', 'difficulty', `difficulty INTEGER NOT NULL DEFAULT 1`); // 1..5
addColumnIfMissing('requests', 'helpAccepted', `helpAccepted INTEGER NOT NULL DEFAULT 0`); // 0/1
addColumnIfMissing('requests', 'finishedVolunteer', `finishedVolunteer INTEGER NOT NULL DEFAULT 0`); // 0/1
addColumnIfMissing('requests', 'finishedSeeker', `finishedSeeker INTEGER NOT NULL DEFAULT 0`); // 0/1
addColumnIfMissing('requests', 'pointsToAdd', `pointsToAdd INTEGER NOT NULL DEFAULT 5`); // 5..30
addColumnIfMissing('requests', 'cancelled', `cancelled INTEGER NOT NULL DEFAULT 0`); // 0/1
addColumnIfMissing('requests', 'cancelReason', `cancelReason TEXT`);
addColumnIfMissing('requests', 'cancelledBy', `cancelledBy INTEGER`);
addColumnIfMissing('requests', 'cancelledAt', `cancelledAt TEXT`);
addColumnIfMissing('requests', 'helpAcceptedAt', `helpAcceptedAt TEXT`);
addColumnIfMissing('requests', 'finishedAt', `finishedAt TEXT`);
addColumnIfMissing('requests', 'requestCity', `requestCity TEXT`);
addColumnIfMissing('requests', 'urgency', `urgency TEXT NOT NULL DEFAULT 'flex'`);
addColumnIfMissing('requests', 'neededAt', `neededAt TEXT`);
addColumnIfMissing('requests', 'recurring', `recurring INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('requests', 'recurringNote', `recurringNote TEXT`);

addColumnIfMissing('messages', 'readAt', `readAt TEXT`); // когда собеседник «увидел» сообщение
addColumnIfMissing('reviews', 'requestId', `requestId INTEGER`); // к какому делу привязан отзыв
addColumnIfMissing('events', 'imageData', `imageData TEXT`);
addColumnIfMissing('events', 'videoData', `videoData TEXT`);

/*
 * ========== СПРАВОЧНИК ПО ДАННЫМ (файл database.sqlite) ==========
 * users: id — ключ; name, email; password оставлен пустым при хеше; passwordSalt+passwordHash — scrypt;
 *   role volunteer|seeker|admin; points, completed; ratingSum/ratingCount — для среднего; status active|blocked;
 *   city, age, about — анкета; banUntil/banReason — блокировка; chatLimitedUntil/requestsLimitedUntil — мягкие лимиты.
 * requests: заявка; createdBy — автор; status pending|approved|rejected; assignedVolunteerId — кто взял;
 *   completed 0/1; difficulty 1..5; pointsToAdd — баллы волонтёру; helpAccepted — нуждающийся подтвердил помощь;
 *   finishedVolunteer/finishedSeeker — флаги «готов завершить»; cancelled/cancelReason/... — отмена;
 *   requestCity, urgency, neededAt, recurring, recurringNote — условия помощи.
 * chats + chat_users: диалог и состав (два userId на один chatId).
 * messages: текст, fromUserId, readAt — прочтение собеседником.
 * reviews: отзыв; targetUserId, fromUserId, rating 1..5, comment, requestId.
 * sessions: userId + token для Bearer; lastSeenAt обновляется при каждом запросе с токеном.
 * complaints: жалоба; status pending/…; resolveComment — комментарий модератора.
 * audit_logs: журнал (action, entityType+entityId, details JSON) для таймлайна заявок и модерации.
 * meta: служебные флаги (например didCleanupRequestsAndChats).
 */

// Успешный JSON-ответ с кодом 200 (по умолчанию).
function ok(res, obj) {
  res.json(obj);
}

// Ошибка: задаём HTTP-код и поле error для фронта.
function fail(res, status, msg) {
  res.status(status).json({ error: msg });
}

// Безопасный разбор целого из строки (id из URL); если не число — null.
function toInt(x) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : null;
}

function eventIdNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function currentUserId(req) {
  const u = req && req.user;
  if (!u) return null;
  const id = u.id != null ? u.id : u.userId;
  const n = toInt(id);
  return n || null;
}

// Ограничиваем число отрезком [min, max] (сложность, рейтинг и т.д.).
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Таблица «сложность заявки → баллы волонтёру» (используется при take и в карточке).
function pointsByDifficulty(diff) {
  // 1..5 => 5..30 (простая шкала)
  const d = clamp(diff || 1, 1, 5);
  if (d === 1) return 5;
  if (d === 2) return 10;
  if (d === 3) return 15;
  if (d === 4) return 22;
  return 30;
}

// Не больше стольки «живых» заявок у нуждающегося / назначений у волонтёра (анти-спам).
const MAX_SEEKER_ACTIVE_REQUESTS = 5;
const MAX_VOLUNTEER_ASSIGNED_ACTIVE = 5;

// Экранирование для CSV: кавычки удваиваем, при необходимости оборачиваем в "".
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).replace(/"/g, '""');
  if (/[",\n\r]/.test(s)) return `"${s}"`;
  return s;
}

// Человекочитаемые подписи к кодам из audit_logs (показываем в модалке «история»).
function timelineLabelForAuditAction(action) {
  const map = {
    request_create: 'Заявка создана и отправлена на проверку',
    request_approve: 'Заявка одобрена командой сайта',
    request_reject: 'Заявка отклонена',
    request_take: 'Волонтёр начал помогать',
    request_accept_help: 'Нуждающийся принял помощь',
    request_finish_vote: 'Сторона подтвердила завершение',
    request_completed: 'Дело завершено, баллы начислены волонтёру',
    request_cancel: 'Дело отменено',
  };
  return map[action] || action;
}

// Для поля details в audit_logs: если объект циклический — вернётся null, INSERT не падает.
function jsonStringifySafe(obj) {
  try { return JSON.stringify(obj); } catch { return null; }
}

const INLINE_EVENT_IMAGE_MAX = 6 * 1024 * 1024;
const INLINE_EVENT_VIDEO_MAX = 12 * 1024 * 1024;

function fileToDataUrlOrNull(file, maxBytes) {
  if (!file || !file.path) return null;
  try {
    const st = fs.statSync(file.path);
    if (st.size > maxBytes) return null;
    const buf = fs.readFileSync(file.path);
    const mime = file.mimetype || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function eventRowWithMedia(row) {
  if (!row) return row;
  return {
    ...row,
    imageUrl: row.imageData || row.imageUrl || null,
    videoUrl: row.videoData || row.videoUrl || null,
  };
}

// Пароль + соль (hex) → ключ scrypt → храним как hex-строку (не храним пароль открытым текстом).
function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const key = crypto.scryptSync(String(password), salt, 32);
  return key.toString('hex');
}

// 16 байт случайных данных → 32 hex-символа для новой соли пользователя.
function newSaltHex() {
  return crypto.randomBytes(16).toString('hex');
}

// Непредсказуемый токен сессии (48 hex-символов), кладётся в таблицу sessions.
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Пишем строку в журнал (actor может быть null для системных событий).
function audit(actorUserId, action, entityType, entityId, detailsObj) {
  db.run(
    `INSERT INTO audit_logs (actorUserId, action, entityType, entityId, details)
     VALUES (?, ?, ?, ?, ?)`,
    [actorUserId || null, action, entityType, entityId || null, jsonStringifySafe(detailsObj) || null]
  );
}

// Доступ к чату: только участники диалога или администратор.
function assertChatAccess(chatId, req, res, cb) {
  if (!chatId) return cb(new Error('bad')); // некорректный id — сигнал вызывающему коду
  if (req.user.role === 'admin') return cb(null, true); // админ видит любой чат
  // Обычный пользователь: есть ли запись в chat_users для пары (chatId, userId).
  db.get(
    `SELECT 1 AS ok FROM chat_users WHERE chatId = ? AND userId = ?`,
    [chatId, req.user.id],
    (err, row) => {
      if (err) return cb(err);
      if (!row) {
        fail(res, 403, 'Нет доступа к этому чату'); // ответ клиенту уже отправлен
        return cb(null, false); // allowed = false
      }
      cb(null, true);
    }
  );
}

// Простейший лимит запросов в памяти процесса (после перезапуска счётчики обнуляются — для учебного проекта норм).
const rateState = new Map(); // ключ -> { count, resetAt }
function rateLimit(keyPrefix, max, windowMs) {
  // factory: отдаёт middleware с лимитом max запросов на окно windowMs (мс) на IP.
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip'; // за прокси иногда приходит список
    const key = keyPrefix + ':' + ip;
    const now = Date.now();
    const cur = rateState.get(key);
    if (!cur || cur.resetAt <= now) {
      // Новое окно: сбрасываем счётчик.
      rateState.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    cur.count += 1;
    if (cur.count > max) return fail(res, 429, 'Слишком много запросов. Подождите немного.');
    return next();
  };
}

// Если в заголовке есть Bearer — ищем сессию и цепляем пользователя к req.user.
function authMiddleware(req, res, next) {
  const hdr = req.headers['authorization'] || '';
  const m = String(hdr).match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return next(); // гость — дальше роут сам решит, нужна ли авторизация
  db.get(
    `SELECT s.userId as sessionUserId, u.id, u.name, u.email, u.role, u.points, u.completed, u.ratingSum, u.ratingCount, u.status, u.city, u.age, u.about, u.banUntil, u.banReason, u.chatLimitedUntil, u.requestsLimitedUntil, u.seekerVerified, u.volunteerVerified, u.seekerFormStatus, u.volunteerFormStatus, u.seekerPhone, u.volunteerPhone, u.seekerFormNote, u.volunteerFormNote
     FROM sessions s
     JOIN users u ON u.id = s.userId
     WHERE s.token = ?`,
    [token],
    (err, row) => {
      if (!err && row) {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        // Временная блокировка истекла — автоматом снимаем (чтобы не держать вечный ban в памяти).
        if (row.banUntil && row.banUntil <= now) {
          db.run(`UPDATE users SET status = 'active', banUntil = NULL, banReason = NULL WHERE id = ?`, [row.id]);
          row.status = 'active';
          row.banUntil = null;
          row.banReason = null;
        }
        req.user = row;
        db.run(`UPDATE sessions SET lastSeenAt = datetime('now') WHERE token = ?`, [token]);
      }
      next();
    }
  );
}

function requireAuth(req, res, next) {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // Заблокирован навсегда или ещё не вышел срок временного бана.
  if (req.user.status === 'blocked' || (req.user.banUntil && req.user.banUntil > now)) {
    const untilText = req.user.banUntil ? ` до ${req.user.banUntil}` : ' навсегда';
    const reasonText = req.user.banReason ? ` Причина: ${req.user.banReason}` : '';
    return fail(res, 403, `Ваш аккаунт заблокирован${untilText}.${reasonText}`);
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin') return fail(res, 403, 'Доступно только команде сайта.');
  return next();
}

// Если в users пусто — создаём админа и пару демо-аккаунтов (пароли простые, только для стенда).
// ID не захардкожены: берём this.lastID после каждого INSERT.
function seedIfEmpty() {
  db.get(`SELECT COUNT(*) as cnt FROM users`, [], (err, row) => {
    if (err) return;
    if ((row && row.cnt) > 0) return;

    // Сюда кладём lastID после каждого INSERT (если бы связали сид с заявками — пригодилось бы).
    const ids = {
      admin: null,
      v1: null,
      v2: null,
      v3: null,
      s1: null,
      s2: null,
      s3: null
    };

    // Цепочка вложенных INSERT: админ, три волонтёра, три нуждающихся (пароли учебные).
    db.run(
      `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Команда VOLUNTIS', 'admin@example.com', 'admin', 'admin', 0, 0, 0, 0, 'active'],
      function () {
        ids.admin = this.lastID;

        db.run(
          `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          // баллы/дела по нулям — теперь всё зарабатывается только через реальные завершения
          ['Анна Смирнова', 'anna@example.com', '123', 'volunteer', 0, 0, 0, 0, 'active'],
          function () {
            ids.v1 = this.lastID;

            db.run(
              `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ['Илья Петров', 'ilya@example.com', '123', 'volunteer', 0, 0, 0, 0, 'active'],
              function () {
                ids.v2 = this.lastID;

                db.run(
                  `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  ['Мария Кузнецова', 'maria@example.com', '123', 'volunteer', 0, 0, 0, 0, 'active'],
                  function () {
                    ids.v3 = this.lastID;

                    db.run(
                      `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      ['Олег Сидоров', 'oleg@example.com', '123', 'seeker', 0, 0, 0, 0, 'active'],
                      function () {
                        ids.s1 = this.lastID;

                        db.run(
                          `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                          ['Екатерина Иванова', 'katya@example.com', '123', 'seeker', 0, 0, 0, 0, 'active'],
                          function () {
                            ids.s2 = this.lastID;

                            db.run(
                              `INSERT INTO users (name, email, password, role, points, completed, ratingSum, ratingCount, status)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                              ['Сергей Никитин', 'sergey@example.com', '123', 'seeker', 0, 0, 0, 0, 'active'],
                              function () {
                                ids.s3 = this.lastID;
                                // Пользователь попросил убрать все заявки и переписки из базы,
                                // поэтому seed создаёт только аккаунты (без заявок/чатов/сообщений/отзывов).
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          }
        );
      }
    );
  });
}

seedIfEmpty();

function seedWelcomeEventIfEmpty() {
  const welcomeBody =
    'Здравствуйте!\n\n' +
    'VOLUNTIS — волонтёрская платформа, где люди, которым нужна помощь, могут оставить заявку, ' +
    'а волонтёры — откликнуться и поддержать в бытовых и социальных делах.\n\n' +
    'Сейчас идёт набор волонтёров. Зарегистрируйтесь, выберите роль «Волонтёр», отправьте анкету в профиле ' +
    'и дождитесь синей галочки от команды сайта.\n\n' +
    'Как пользоваться сайтом:\n' +
    '1) Регистрация и вход.\n' +
    '2) Профиль — анкета для верификации.\n' +
    '3) Заявки — нуждающийся создаёт заявку, волонтёр с галочкой откликается.\n' +
    '4) Чат — общение после отклика.\n' +
    '5) Завершение дела — по согласию обеих сторон.\n\n' +
    'В этом разделе «Мероприятия» команда сайта будет публиковать новости, акции и отчёты о делах.\n\n' +
    'С уважением, команда сайта VOLUNTIS.';

  db.get(`SELECT COUNT(*) as cnt FROM events`, [], (err, row) => {
    if (err || (row && row.cnt > 0)) return;
    db.get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`, [], (e2, admin) => {
      const adminId = admin && admin.id ? admin.id : 1;
      db.run(
        `INSERT INTO events (title, body, createdBy) VALUES (?, ?, ?)`,
        ['Добро пожаловать на VOLUNTIS — платформу взаимной помощи', welcomeBody, adminId]
      );
    });
  });
}

setTimeout(seedWelcomeEventIfEmpty, 2000);

// Учебный стенд: у демо-админа всегда role=admin (мог сброситься при смене роли в профиле).
function ensureDemoAdminRole() {
  db.run(
    `UPDATE users SET role = 'admin' WHERE email = ? AND role != 'admin'`,
    ['admin@example.com'],
    () => {}
  );
}
ensureDemoAdminRole();

// Обнуляем "вымышленные" баллы/дела у демо-аккаунтов, если база уже была создана раньше.
// Реальные аккаунты/баллы не трогаем.
db.run(
  `UPDATE users
   SET points = 0, completed = 0
   WHERE email IN ('anna@example.com','ilya@example.com','maria@example.com','oleg@example.com','katya@example.com','sergey@example.com')
     AND (points != 0 OR completed != 0)`,
  []
);

// Обнуляем "вымышленные" рейтинги у демо-аккаунтов (чтобы не было 4.9 "из ниоткуда")
db.run(
  `UPDATE users
   SET ratingSum = 0, ratingCount = 0
   WHERE email IN ('anna@example.com','ilya@example.com','maria@example.com','oleg@example.com','katya@example.com','sergey@example.com')
     AND (ratingSum != 0 OR ratingCount != 0)`,
  []
);

// Пользователь попросил убрать из базы все заявки и все переписки:
// делаем одноразовую очистку (чтобы новые данные потом не стирались при каждом запуске).
// Одноразовая очистка (см. ключ meta): стираем старые заявки и чаты один раз при первом запуске с этой логикой.
db.get(`SELECT value FROM meta WHERE key = 'didCleanupRequestsAndChats'`, [], (err, row) => {
  if (err) return;
  if (row && row.value === '1') return; // уже чистили — выходим
  db.serialize(() => {
    db.run(`DELETE FROM requests`); // все заявки
    db.run(`DELETE FROM messages`); // все сообщения
    db.run(`DELETE FROM chat_users`); // связи пользователь-чат
    db.run(`DELETE FROM chats`); // сами чаты
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('didCleanupRequestsAndChats', '1')`); // флаг «готово»
  });
});

// ========== HTTP API (всё с префиксом /api/) ==========
// Схема: auth → пользователи и профиль → заявки (модерация, взятие, завершение) → чаты → отзывы → жалобы → уведомления → админ (статистика, CSV).
/*
 * Каталог маршрутов (метод, путь, назначение):
 * POST /register, /login, /logout — регистрация, вход, выход (инвалидация токена).
 * POST /users/:id/role — смена роли volunteer↔seeker (свой id).
 * GET /users, /users/:id — список (опц. ?role= ?q=) и карточка пользователя.
 * POST /users/:id/update — правка анкеты (свой id).
 * GET /requests — одобренные заявки (фильтры completed, city); POST /requests — создать (нуждающийся).
 * GET /requests/by-user/:userId — все заявки автора; GET /completed-with — общие завершённые с ?userId=&otherId=.
 * GET /requests/:id/timeline — история по заявке (доступ автор, волонтёр, админ).
 * GET /admin/requests/pending; POST .../approve, .../reject — модерация.
 * POST /requests/:id/take|accept|finish|complete|cancel — жизненный цикл дела.
 * GET /requests/:id — одна заявка (админ).
 * GET /users/me/ban-info — кто и когда применил санкции к текущему пользователю.
 * GET/POST /chats, /chats/:id/participants, /messages, POST /chats/create — переписка.
 * POST /reviews; GET /reviews/:targetUserId — отзывы.
 * POST /complaints; GET /admin/complaints; POST /admin/complaints/:id/resolve — жалобы.
 * GET /notifications/summary — счётчики для колокольчика.
 * GET /admin/users/blocked; POST /admin/users/update — список санкций и ручные правки.
 * GET /top/volunteers — рейтинг; GET /admin/stats — сводка; GET /admin/export?kind= — CSV.
 */

// Регистрация: сразу выдаём токен и пишем сессию.
app.post('/api/register', rateLimit('register', 10, 60_000), (req, res) => {
  // Регистрация: создаём пользователя и сессию, возвращаем token и user.
  // Тело: name, email, password обязательны; role опционально (иначе volunteer).
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Не заполнены поля' });

  // Только две роли при регистрации; admin через сид, не через форму.
  const safeRole = (role === 'seeker') ? 'seeker' : 'volunteer';

  const salt = newSaltHex();
  const passHash = hashPassword(password, salt);

  // password в таблице оставляем пустым: актуальные данные в passwordSalt + passwordHash.
  db.run(
    `INSERT INTO users (name, email, password, passwordSalt, passwordHash, role)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, email, '', salt, passHash, safeRole],
    function (err) {
      if (err) {
        if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'Пользователь с таким email уже есть' });
        return res.status(500).json({ error: 'Ошибка базы данных' });
      }
      const newUserId = this.lastID; // здесь this — контекст INSERT в users; во вложенном callback уже другой this
      const token = newToken();
      db.run(`INSERT INTO sessions (userId, token) VALUES (?, ?)`, [newUserId, token], (e2) => {
        if (e2) return fail(res, 500, 'Ошибка базы данных');
        audit(newUserId, 'register', 'user', newUserId, { email, role: safeRole });
        db.get(
          `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone FROM users WHERE id = ?`,
          [newUserId],
          (e3, u) => {
            if (e3 || !u) return fail(res, 500, 'Ошибка базы данных');
            ok(res, { token, user: u });
          }
        );
      });
    }
  );
});

// Вход по email/паролю; поддерживаются старые записи только с полем password (без соли).
app.post('/api/login', rateLimit('login', 20, 60_000), (req, res) => {
  // Вход: проверка пароля (scrypt или устаревший открытый), выдача новой сессии.
  const { email, password } = req.body;

  db.get(
    `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone, password, passwordSalt, passwordHash, banUntil, banReason
     FROM users WHERE email = ?`,
    [email],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 401, 'Неверный логин или пароль');
      if (row.status === 'blocked') return fail(res, 403, 'Аккаунт заблокирован.');
      const nowLogin = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (row.banUntil && row.banUntil > nowLogin) {
        const reasonText = row.banReason ? ` Причина: ${row.banReason}` : '';
        return fail(res, 403, `Ваш аккаунт заблокирован до ${row.banUntil}.${reasonText}`);
      }

      // поддержка старых пользователей, у которых пароль был в открытом виде
      let okPass = false;
      if (row.passwordHash && row.passwordSalt) {
        const calc = hashPassword(password, row.passwordSalt);
        okPass = (calc === row.passwordHash);
      } else {
        okPass = (String(password) === String(row.password || ''));
      }
      if (!okPass) return fail(res, 401, 'Неверный логин или пароль');

      // миграция: если пароль был "плоский" — запишем хэш
      if (!row.passwordHash || !row.passwordSalt) {
        const salt = newSaltHex();
        const passHash = hashPassword(password, salt);
        db.run(`UPDATE users SET password = '', passwordSalt = ?, passwordHash = ? WHERE id = ?`, [salt, passHash, row.id]);
      }

      const token = newToken();
      db.run(`INSERT INTO sessions (userId, token) VALUES (?, ?)`, [row.id, token], (e2) => {
        if (e2) return fail(res, 500, 'Ошибка базы данных');
        audit(row.id, 'login', 'user', row.id, { email });
        const user = {
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          points: row.points,
          completed: row.completed,
          ratingSum: row.ratingSum,
          ratingCount: row.ratingCount,
          status: row.status,
          city: row.city,
          age: row.age,
          about: row.about,
          seekerVerified: row.seekerVerified || 0,
          volunteerVerified: row.volunteerVerified || 0,
          seekerFormStatus: row.seekerFormStatus || 'not_submitted',
          volunteerFormStatus: row.volunteerFormStatus || 'not_submitted',
          seekerPhone: row.seekerPhone || null,
          volunteerPhone: row.volunteerPhone || null
        };
        ok(res, { token, user });
      });
    }
  );
});

// выход (инвалидируем текущий токен)
app.post('/api/logout', requireAuth, (req, res) => {
  const hdr = req.headers['authorization'] || '';
  const m = String(hdr).match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return ok(res, { ok: true });
  db.run(`DELETE FROM sessions WHERE token = ?`, [token], () => ok(res, { ok: true }));
});

// смена роли (только volunteer <-> seeker, только для себя)
app.post('/api/users/:id/role', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const role = String(req.body.role || '');
  if (!id) return fail(res, 400, 'Некорректный id');
  if (req.user.id !== id) return fail(res, 403, 'Нельзя менять роль другого пользователя');
  if (role !== 'volunteer' && role !== 'seeker') return fail(res, 400, 'Некорректная роль');
  db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id], function (err) {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    audit(req.user.id, 'user_role_change', 'user', id, { role });
    ok(res, { ok: true });
  });
});

// Список пользователей (анкеты)
app.get('/api/users', (req, res) => {
  const role = req.query.role;
  const q = req.query.q;

  let sql = `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone, seekerFormNote, volunteerFormNote FROM users WHERE status != 'blocked'`;
  const params = [];
  const where = [];

  if (role) {
    where.push(`role = ?`);
    params.push(role);
  }
  if (q) {
    where.push(`(name LIKE ? OR email LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  if (where.length) sql += ` AND ` + where.join(' AND ');
  sql += ` ORDER BY points DESC, id DESC LIMIT 200`;

  db.all(sql, params, (err, rows) => {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    ok(res, rows);
  });
});

// Текущий пользователь по Bearer-токену (маршрут до /api/users/:id)
app.get('/api/users/me', requireAuth, (req, res) => {
  const u = req.user;
  ok(res, {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    points: u.points,
    completed: u.completed,
    ratingSum: u.ratingSum,
    ratingCount: u.ratingCount,
    status: u.status,
    city: u.city,
    age: u.age,
    about: u.about,
    seekerVerified: u.seekerVerified || 0,
    volunteerVerified: u.volunteerVerified || 0,
    seekerFormStatus: u.seekerFormStatus || 'not_submitted',
    volunteerFormStatus: u.volunteerFormStatus || 'not_submitted',
    seekerPhone: u.seekerPhone || null,
    volunteerPhone: u.volunteerPhone || null,
    seekerFormNote: u.seekerFormNote || null,
    volunteerFormNote: u.volunteerFormNote || null,
    banUntil: u.banUntil || null,
    banReason: u.banReason || null,
  });
});

// Просмотр профиля
app.get('/api/users/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Некорректный id');
  db.get(
    `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone, seekerFormNote, volunteerFormNote FROM users WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      ok(res, row);
    }
  );
});

function userPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    points: row.points,
    completed: row.completed,
    ratingSum: row.ratingSum,
    ratingCount: row.ratingCount,
    status: row.status,
    city: row.city,
    age: row.age,
    about: row.about,
    seekerVerified: row.seekerVerified || 0,
    volunteerVerified: row.volunteerVerified || 0,
    seekerFormStatus: row.seekerFormStatus || 'not_submitted',
    volunteerFormStatus: row.volunteerFormStatus || 'not_submitted',
    seekerPhone: row.seekerPhone || null,
    volunteerPhone: row.volunteerPhone || null,
    seekerFormNote: row.seekerFormNote || null,
    volunteerFormNote: row.volunteerFormNote || null,
  };
}

// Изменить анкету (без безопасности — это демо)
app.post('/api/users/:id/update', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const { name, password, city, age, about, seekerPhone, seekerFormNote, volunteerPhone, volunteerFormNote, submitSeekerForm, submitVolunteerForm } = req.body;
  const submitSeeker = !!(submitSeekerForm === true || submitSeekerForm === 'true' || submitSeekerForm === 1 || submitSeekerForm === '1');
  const submitVolunteer = !!(submitVolunteerForm === true || submitVolunteerForm === 'true' || submitVolunteerForm === 1 || submitVolunteerForm === '1');
  if (!id) return fail(res, 400, 'Некорректный id');
  if (!name && !password && city === undefined && age === undefined && about === undefined && seekerPhone === undefined && seekerFormNote === undefined && volunteerPhone === undefined && volunteerFormNote === undefined && !submitSeeker && !submitVolunteer) return fail(res, 400, 'Нечего обновлять');

  if (req.user.role !== 'admin' && req.user.id !== id) return fail(res, 403, 'Нельзя менять чужой профиль');

  // lenivii variant: prosto update
  const fields = [];
  const params = [];
  if (name) {
    fields.push('name = ?');
    params.push(name);
  }
  if (password) {
    const salt = newSaltHex();
    const passHash = hashPassword(password, salt);
    fields.push('password = ?');
    fields.push('passwordSalt = ?');
    fields.push('passwordHash = ?');
    params.push('', salt, passHash);
  }
  if (city !== undefined) {
    fields.push('city = ?');
    params.push(city ? String(city) : null);
  }
  if (age !== undefined) {
    const a = toInt(age);
    fields.push('age = ?');
    params.push(a ? a : null);
  }
  if (about !== undefined) {
    fields.push('about = ?');
    params.push(about ? String(about) : null);
  }
  if (seekerPhone !== undefined) {
    fields.push('seekerPhone = ?');
    params.push(seekerPhone ? String(seekerPhone) : null);
  }
  if (seekerFormNote !== undefined) {
    fields.push('seekerFormNote = ?');
    params.push(seekerFormNote ? String(seekerFormNote) : null);
  }
  if (volunteerPhone !== undefined) {
    fields.push('volunteerPhone = ?');
    params.push(volunteerPhone ? String(volunteerPhone) : null);
  }
  if (volunteerFormNote !== undefined) {
    fields.push('volunteerFormNote = ?');
    params.push(volunteerFormNote ? String(volunteerFormNote) : null);
  }
  if (submitSeeker) {
    fields.push(`seekerFormStatus = 'pending'`);
    fields.push(`seekerVerified = 0`);
    fields.push(`role = 'seeker'`);
  }
  if (submitVolunteer) {
    fields.push(`volunteerFormStatus = 'pending'`);
    fields.push(`volunteerVerified = 0`);
    fields.push(`role = 'volunteer'`);
  }
  params.push(id);

  db.run(
    `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
    params,
    function (err) {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      audit(req.user.id, 'user_update', 'user', id, { fields: fields.map(f => f.split('=')[0].trim()) });
      db.get(
        `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone, seekerFormNote, volunteerFormNote FROM users WHERE id = ?`,
        [id],
        (e2, row) => {
          if (e2 || !row) return ok(res, { updated: this.changes });
          ok(res, { updated: this.changes, user: userPublicRow(row) });
        }
      );
    }
  );
});

// получить одобренные заявки (п.1 город, п.2 сортировка по срочности и дате)
app.get('/api/requests', (req, res) => {
  const onlyCompleted = req.query.completed === '1';
  const cityQ = String(req.query.city || '')
    .trim()
    .toLowerCase();
  let sql;
  const params = [];
  if (onlyCompleted) {
    sql = `SELECT * FROM requests WHERE status = 'approved' AND IFNULL(cancelled,0)=0 AND completed = 1`;
    if (cityQ) {
      sql += ` AND LOWER(TRIM(IFNULL(requestCity,''))) = ?`;
      params.push(cityQ);
    }
    sql += ` ORDER BY id DESC`;
  } else {
    sql = `SELECT * FROM requests WHERE status = 'approved' AND IFNULL(cancelled,0)=0 AND IFNULL(completed,0)=0`;
    if (cityQ) {
      sql += ` AND LOWER(TRIM(IFNULL(requestCity,''))) = ?`;
      params.push(cityQ);
    }
    sql += ` ORDER BY
      CASE IFNULL(urgency,'flex') WHEN 'today' THEN 0 WHEN 'week' THEN 1 ELSE 2 END,
      CASE WHEN neededAt IS NULL OR TRIM(neededAt) = '' THEN 1 ELSE 0 END,
      neededAt ASC,
      id DESC`;
  }
  db.all(sql, params, (err, rows) => {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    ok(res, rows);
  });
});

// Все заявки конкретного нуждающегося (сам себе или админ).
app.get('/api/requests/by-user/:userId', (req, res) => {
  const userId = toInt(req.params.userId);
  if (!userId) return fail(res, 400, 'Некорректный userId');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin' && req.user.id !== userId) return fail(res, 403, 'Нельзя смотреть чужие заявки');
  db.all(
    `SELECT * FROM requests WHERE createdBy = ? ORDER BY id DESC`,
    [userId],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// завершённые дела между двумя пользователями (до /api/requests/:id, чтобы не перехватывалось как id)
app.get('/api/requests/completed-with', (req, res) => {
  const userId = toInt(req.query.userId);
  const otherId = toInt(req.query.otherId);
  if (!userId || !otherId) return fail(res, 400, 'Некорректные данные');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin' && req.user.id !== userId) return fail(res, 403, 'Нельзя смотреть чужие дела');

  db.all(
    `SELECT id, title, type, createdAt, pointsToAdd
     FROM requests
     WHERE completed = 1 AND IFNULL(cancelled,0)=0
       AND (
         (createdBy = ? AND assignedVolunteerId = ?)
         OR
         (createdBy = ? AND assignedVolunteerId = ?)
       )
     ORDER BY id DESC
     LIMIT 100`,
    [userId, otherId, otherId, userId],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// п.3 — лента событий по заявке (audit)
app.get('/api/requests/:id/timeline', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Некорректный id');
  db.get(
    `SELECT id, createdBy, assignedVolunteerId FROM requests WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      const allowed =
        req.user.role === 'admin' ||
        req.user.id === row.createdBy ||
        req.user.id === row.assignedVolunteerId;
      if (!allowed) return fail(res, 403, 'Нет доступа к истории этой заявки');

      db.all(
        `SELECT a.action, a.createdAt, a.actorUserId, a.details, u.name AS actorName
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actorUserId
         WHERE a.entityType = 'request' AND a.entityId = ?
         ORDER BY a.id ASC`,
        [id],
        (e2, rows) => {
          if (e2) return fail(res, 500, 'Ошибка базы данных');
          const items = (rows || []).map((a) => {
            let details = null;
            if (a.details) {
              try {
                details = JSON.parse(a.details);
              } catch {
                details = null;
              }
            }
            return {
              at: a.createdAt,
              action: a.action,
              label: timelineLabelForAuditAction(a.action),
              actorName: a.actorName || null,
              details,
            };
          });
          ok(res, { requestId: id, items });
        }
      );
    }
  );
});

// Админ: заявки со статусом «на проверке».
app.get('/api/admin/requests/pending', (req, res) => {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin') return fail(res, 403, 'Доступно только команде сайта.');
  db.all(
    `SELECT * FROM requests WHERE status = 'pending' ORDER BY id DESC`,
    [],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// Админ: одобрить заявку (становится видна волонтёрам).
app.post('/api/admin/requests/:id/approve', (req, res) => {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin') return fail(res, 403, 'Доступно только команде сайта.');
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Некорректный id');
  db.run(`UPDATE requests SET status = 'approved' WHERE id = ?`, [id], function (err) {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    audit(req.user.id, 'request_approve', 'request', id, {});
    ok(res, { updated: this.changes });
  });
});

// Админ: отклонить заявку (не пойдёт в общий список).
app.post('/api/admin/requests/:id/reject', (req, res) => {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.role !== 'admin') return fail(res, 403, 'Доступно только команде сайта.');
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Некорректный id');
  db.run(`UPDATE requests SET status = 'rejected' WHERE id = ?`, [id], function (err) {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    audit(req.user.id, 'request_reject', 'request', id, {});
    ok(res, { updated: this.changes });
  });
});

// Админ: анкеты верификации (нуждающиеся и волонтёры отдельными списками).
app.get('/api/admin/verification-forms', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending'); // pending | all | approved | rejected
  const cols = `id, name, email, role, city, age, seekerVerified, volunteerVerified,
    seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone, seekerFormNote, volunteerFormNote`;

  function whereFor(field) {
    if (status === 'pending') return `${field} = 'pending'`;
    if (status === 'approved') return `${field} = 'approved'`;
    if (status === 'rejected') return `${field} = 'rejected'`;
    return `${field} != 'not_submitted'`;
  }

  db.all(
    `SELECT ${cols} FROM users WHERE ${whereFor('seekerFormStatus')} ORDER BY id DESC`,
    [],
    (errSeekers, seekers) => {
      if (errSeekers) return fail(res, 500, 'Ошибка базы данных');
      db.all(
        `SELECT ${cols} FROM users WHERE ${whereFor('volunteerFormStatus')} ORDER BY id DESC`,
        [],
        (errVolunteers, volunteers) => {
          if (errVolunteers) return fail(res, 500, 'Ошибка базы данных');
          ok(res, { seekers: seekers || [], volunteers: volunteers || [] });
        }
      );
    }
  );
});

// Админ: одобрить или отклонить анкету (выдать/снять галочку).
app.post('/api/admin/users/:id/verification', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  const kind = String(req.body.kind || '');
  const action = String(req.body.action || '');
  if (!id) return fail(res, 400, 'Некорректный id');
  if (kind !== 'seeker' && kind !== 'volunteer') return fail(res, 400, 'Некорректный тип анкеты');
  if (action !== 'approve' && action !== 'reject') return fail(res, 400, 'Некорректное действие');

  const approved = action === 'approve';
  const sql =
    kind === 'seeker'
      ? (approved
        ? `UPDATE users SET seekerVerified = 1, seekerFormStatus = 'approved', role = 'seeker' WHERE id = ?`
        : `UPDATE users SET seekerVerified = 0, seekerFormStatus = 'rejected' WHERE id = ?`)
      : (approved
        ? `UPDATE users SET volunteerVerified = 1, volunteerFormStatus = 'approved', role = 'volunteer' WHERE id = ?`
        : `UPDATE users SET volunteerVerified = 0, volunteerFormStatus = 'rejected' WHERE id = ?`);
  const params = approved ? [id] : [id];

  db.run(sql, params, function (err) {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    if (!this.changes) return fail(res, 404, 'Пользователь не найден');
    audit(req.user.id, approved ? 'verification_approve' : 'verification_reject', 'user', id, { kind });
    ok(res, { ok: true });
  });
});

// Мероприятия: список публикаций + лайки/комментарии.
app.get('/api/events', (req, res) => {
  db.all(
    `SELECT e.id, e.title, e.body, e.imageUrl, e.videoUrl, e.imageData, e.videoData, e.createdBy, e.createdAt, u.name AS authorName
     FROM events e
     LEFT JOIN users u ON u.id = e.createdBy
     ORDER BY e.id DESC`,
    [],
    (err, eventsRows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      const ids = (eventsRows || []).map(r => r.id);
      if (!ids.length) return ok(res, []);
      const placeholders = ids.map(() => '?').join(',');

      db.all(
        `SELECT eventId, COUNT(*) AS likesCount
         FROM event_likes
         WHERE eventId IN (${placeholders})
         GROUP BY eventId`,
        ids,
        (eLikes, likesRows) => {
          if (eLikes) return fail(res, 500, 'Ошибка базы данных');
          const likesMap = {};
          (likesRows || []).forEach(r => {
            likesMap[eventIdNum(r.eventId)] = Number(r.likesCount || 0);
          });

          const finishWithComments = (likedIdsSet) => {
            db.all(
              `SELECT c.id, c.eventId, c.userId, c.text, c.createdAt, u.name AS userName
               FROM event_comments c
               LEFT JOIN users u ON u.id = c.userId
               WHERE c.eventId IN (${placeholders})
               ORDER BY c.id ASC`,
              ids,
              (eComments, commentRows) => {
                if (eComments) return fail(res, 500, 'Ошибка базы данных');
                const commentsMap = {};
                (commentRows || []).forEach(c => {
                  const eid = eventIdNum(c.eventId);
                  if (!commentsMap[eid]) commentsMap[eid] = [];
                  commentsMap[eid].push(c);
                });
                const out = eventsRows.map(ev => {
                  const base = eventRowWithMedia(ev);
                  const eid = eventIdNum(ev.id);
                  return {
                    ...base,
                    id: eid,
                    likesCount: likesMap[eid] || 0,
                    likedByMe: !!(likedIdsSet && likedIdsSet.has(eid)),
                    comments: commentsMap[eid] || [],
                  };
                });
                ok(res, out);
              }
            );
          };

          const uid = currentUserId(req);
          if (!uid) return finishWithComments(null);
          db.all(
            `SELECT eventId FROM event_likes WHERE userId = ? AND eventId IN (${placeholders})`,
            [uid, ...ids],
            (eMyLikes, myLikesRows) => {
              if (eMyLikes) return fail(res, 500, 'Ошибка базы данных');
              const likedIdsSet = new Set((myLikesRows || []).map(r => eventIdNum(r.eventId)));
              finishWithComments(likedIdsSet);
            }
          );
        }
      );
    }
  );
});

// Мероприятия: публикацию может создавать только команда сайта (текст + файлы с компьютера).
app.post('/api/admin/events', requireAdmin, (req, res) => {
  eventUpload(req, res, (uploadErr) => {
    if (uploadErr) {
      const msg =
        uploadErr.code === 'LIMIT_FILE_SIZE'
          ? 'Файл слишком большой (максимум 30 МБ).'
          : uploadErr.message || 'Ошибка загрузки файла';
      return fail(res, 400, msg);
    }
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const videoFile = req.files && req.files.video ? req.files.video[0] : null;
    const imageData = imageFile ? fileToDataUrlOrNull(imageFile, INLINE_EVENT_IMAGE_MAX) : null;
    const videoData = videoFile ? fileToDataUrlOrNull(videoFile, INLINE_EVENT_VIDEO_MAX) : null;
    const imageUrl = imageFile && !imageData ? `/uploads/events/${imageFile.filename}` : null;
    const videoUrl = videoFile && !videoData ? `/uploads/events/${videoFile.filename}` : null;
    if (!title && !body && !imageUrl && !videoUrl && !imageData && !videoData) {
      return fail(res, 400, 'Заполните заголовок, текст или прикрепите фото/видео.');
    }
    db.run(
      `INSERT INTO events (title, body, imageUrl, videoUrl, imageData, videoData, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title || null, body || null, imageUrl, videoUrl, imageData, videoData, req.user.id],
      function (err) {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        audit(req.user.id, 'event_create', 'event', this.lastID, {
          title,
          hasImage: !!(imageUrl || imageData),
          hasVideo: !!(videoUrl || videoData),
          storedInline: !!(imageData || videoData),
        });
        ok(res, {
          id: this.lastID,
          imageUrl: imageData || imageUrl,
          videoUrl: videoData || videoUrl,
        });
      }
    );
  });
});

function eventLikeStats(eventId, userId, cb) {
  db.get(
    `SELECT COUNT(*) AS likesCount FROM event_likes WHERE eventId = ?`,
    [eventId],
    (eCnt, cntRow) => {
      if (eCnt) return cb(eCnt);
      const likesCount = cntRow ? Number(cntRow.likesCount || 0) : 0;
      if (!userId) return cb(null, { likesCount, likedByMe: false });
      db.get(
        `SELECT 1 AS ok FROM event_likes WHERE eventId = ? AND userId = ?`,
        [eventId, userId],
        (eMe, meRow) => {
          if (eMe) return cb(eMe);
          cb(null, { likesCount, likedByMe: !!meRow });
        }
      );
    }
  );
}

// Лайк/дизлайк мероприятия (переключатель).
app.post('/api/events/:id/like', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const uid = currentUserId(req);
  if (!id) return fail(res, 400, 'Некорректный id');
  if (!uid) return fail(res, 401, 'Нужно войти.');
  db.get(`SELECT id FROM events WHERE id = ?`, [id], (e0, row) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!row) return fail(res, 404, 'Публикация не найдена');
    db.get(
      `SELECT eventId FROM event_likes WHERE eventId = ? AND userId = ?`,
      [id, uid],
      (e1, exists) => {
        if (e1) return fail(res, 500, 'Ошибка базы данных');
        const afterToggle = (liked, err) => {
          if (err) return fail(res, 500, 'Ошибка базы данных');
          eventLikeStats(id, uid, (eStats, stats) => {
            if (eStats) return fail(res, 500, 'Ошибка базы данных');
            ok(res, { liked, eventId: id, likesCount: stats.likesCount, likedByMe: stats.likedByMe });
          });
        };
        if (exists) {
          db.run(`DELETE FROM event_likes WHERE eventId = ? AND userId = ?`, [id, uid], (e2) => afterToggle(false, e2));
        } else {
          db.run(`INSERT INTO event_likes (eventId, userId) VALUES (?, ?)`, [id, uid], (e3) => afterToggle(true, e3));
        }
      }
    );
  });
});

// Комментарий к публикации.
app.post('/api/events/:id/comments', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const uid = currentUserId(req);
  const text = String(req.body.text || '').trim();
  if (!id) return fail(res, 400, 'Некорректный id');
  if (!uid) return fail(res, 401, 'Нужно войти.');
  if (!text) return fail(res, 400, 'Комментарий пустой');
  db.get(`SELECT id FROM events WHERE id = ?`, [id], (e0, row) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!row) return fail(res, 404, 'Публикация не найдена');
    db.run(
      `INSERT INTO event_comments (eventId, userId, text) VALUES (?, ?, ?)`,
      [id, uid, text.slice(0, 1200)],
      function (e1) {
        if (e1) return fail(res, 500, 'Ошибка базы данных');
        db.get(
          `SELECT c.id, c.eventId, c.userId, c.text, c.createdAt, u.name AS userName
           FROM event_comments c
           LEFT JOIN users u ON u.id = c.userId
           WHERE c.id = ?`,
          [this.lastID],
          (e2, comment) => {
            if (e2) return fail(res, 500, 'Ошибка базы данных');
            ok(res, { comment: comment || { id: this.lastID, eventId: id, userId: uid, text } });
          }
        );
      }
    );
  });
});

// Волонтёр берёт одобренную заявку (лимит активных дел проверяем отдельным запросом).
app.post('/api/requests/:id/take', (req, res) => {
  const id = toInt(req.params.id);
  const volunteerId = toInt(req.body.volunteerId);
  if (!id || !volunteerId) return fail(res, 400, 'Некорректные данные');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.id !== volunteerId) return fail(res, 403, 'Нельзя начинать помощь от чужого имени');
  if (req.user.role !== 'volunteer') return fail(res, 403, 'Начать помогать может только волонтёр');
  if (!Number(req.user.volunteerVerified || 0)) return fail(res, 403, 'Сначала пройдите анкету и подтверждение команды сайта (синяя галочка волонтёра).');

  db.get(
    `SELECT COUNT(*) AS c FROM requests
     WHERE assignedVolunteerId = ? AND status = 'approved'
       AND IFNULL(completed,0)=0 AND IFNULL(cancelled,0)=0`,
    [volunteerId],
    (eCnt, cntRow) => {
      if (eCnt) return fail(res, 500, 'Ошибка базы данных');
      const n = cntRow && cntRow.c ? cntRow.c : 0;
      if (n >= MAX_VOLUNTEER_ASSIGNED_ACTIVE) {
        return fail(
          res,
          400,
          `У вас уже ${MAX_VOLUNTEER_ASSIGNED_ACTIVE} активных дел. Завершите или отмените одно, чтобы взять новое.`
        );
      }

  db.get(`SELECT assignedVolunteerId, status, completed, createdBy FROM requests WHERE id = ?`, [id], (err, row) => {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    if (!row) return fail(res, 404, 'Не найдено');
    if (row.status !== 'approved') return fail(res, 400, 'Заявка не одобрена');
    if (row.completed) return fail(res, 400, 'Заявка уже завершена');
    if (row.assignedVolunteerId) return fail(res, 400, 'Заявка уже занята');
    // отменённую нельзя взять
    db.get(`SELECT cancelled FROM requests WHERE id = ?`, [id], (eCan, canRow) => {
      if (eCan) return fail(res, 500, 'Ошибка базы данных');
      if (canRow && canRow.cancelled) return fail(res, 400, 'Заявка отменена');

    // Если сложность уже задана создателем заявки — сохраняем её.
    // Если фронт передал "difficulty" (например, будущая функция) — используем.
    const difficulty = clamp(toInt(req.body.difficulty) || 0, 0, 5) || 0;
    db.get(`SELECT difficulty FROM requests WHERE id = ?`, [id], (eDiff, rDiff) => {
      if (eDiff) return fail(res, 500, 'Ошибка базы данных');
      const finalDiff = clamp((difficulty || (rDiff && rDiff.difficulty) || 1), 1, 5);
      const pointsToAdd = pointsByDifficulty(finalDiff);

    db.run(
      `UPDATE requests
       SET assignedVolunteerId = ?,
           difficulty = ?,
           pointsToAdd = ?,
           helpAccepted = 0,
           finishedVolunteer = 0,
           finishedSeeker = 0
       WHERE id = ?`,
      [volunteerId, finalDiff, pointsToAdd, id],
      function (err2) {
      if (err2) return fail(res, 500, 'Ошибка базы данных');
        audit(req.user.id, 'request_take', 'request', id, { difficulty: finalDiff, pointsToAdd });

      // Автоматически создаём чат (если его ещё нет)
      createOrGetChat(volunteerId, row.createdBy, (e3, chatId) => {
        if (e3) return fail(res, 500, 'Ошибка базы данных');
        ok(res, { ok: true, chatId });
      });
    });
    });
    });
  });
  });
});

// Нуждающийся подтверждает, что волонтёр реально помогает (далее — этап «оба завершили»).
app.post('/api/requests/:id/accept', (req, res) => {
  const id = toInt(req.params.id);
  const seekerId = toInt(req.body.seekerId);
  if (!id || !seekerId) return fail(res, 400, 'Некорректные данные');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.id !== seekerId) return fail(res, 403, 'Нельзя принимать помощь от чужого имени');
  if (req.user.role !== 'seeker') return fail(res, 403, 'Принять помощь может только нуждающийся');

  db.get(
    `SELECT createdBy, assignedVolunteerId, status, completed, helpAccepted FROM requests WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      if (row.status !== 'approved') return fail(res, 400, 'Заявка не одобрена');
      if (row.completed) return fail(res, 400, 'Заявка уже завершена');
      if (row.createdBy !== seekerId) return fail(res, 403, 'Это не ваша заявка');
      if (!row.assignedVolunteerId) return fail(res, 400, 'Нет волонтёра');
      if (row.helpAccepted) return ok(res, { ok: true }); // уже принято

      db.run(
        `UPDATE requests SET helpAccepted = 1, helpAcceptedAt = datetime('now') WHERE id = ?`,
        [id],
        function (err2) {
          if (err2) return fail(res, 500, 'Ошибка базы данных');
          audit(req.user.id, 'request_accept_help', 'request', id, {});
          ok(res, { ok: true });
        }
      );
    }
  );
});

// Каждая сторона по очереди нажимает «завершить»; когда оба — начисляем баллы волонтёру.
app.post('/api/requests/:id/finish', (req, res) => {
  const id = toInt(req.params.id);
  const userId = toInt(req.body.userId);
  if (!id || !userId) return fail(res, 400, 'Некорректные данные');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.id !== userId) return fail(res, 403, 'Нельзя завершать от чужого имени');

  db.get(
    `SELECT createdBy, assignedVolunteerId, completed, helpAccepted, finishedVolunteer, finishedSeeker, pointsToAdd
     FROM requests WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      if (row.completed) return ok(res, { ok: true, alreadyCompleted: true });
      if (!row.helpAccepted) return fail(res, 400, 'Сначала нужно принять помощь');
      db.get(`SELECT cancelled FROM requests WHERE id = ?`, [id], (eCan, canRow) => {
        if (!eCan && canRow && canRow.cancelled) return fail(res, 400, 'Заявка отменена');

      let setField = null;
      if (row.assignedVolunteerId === userId) setField = 'finishedVolunteer';
      if (row.createdBy === userId) setField = 'finishedSeeker';
      if (!setField) return fail(res, 403, 'Вы не участник этой заявки');

      db.run(
        `UPDATE requests SET ${setField} = 1 WHERE id = ?`,
        [id],
        function (err2) {
          if (err2) return fail(res, 500, 'Ошибка базы данных');
          audit(req.user.id, 'request_finish_vote', 'request', id, { by: setField });

          // Проверяем, не оба ли уже подтвердили
          db.get(
            `SELECT completed, finishedVolunteer, finishedSeeker, assignedVolunteerId, pointsToAdd
             FROM requests WHERE id = ?`,
            [id],
            (err3, r2) => {
              if (err3) return fail(res, 500, 'Ошибка базы данных');
              if (!r2) return fail(res, 404, 'Не найдено');
              if (r2.completed) return ok(res, { ok: true, alreadyCompleted: true });

              if (r2.finishedVolunteer && r2.finishedSeeker) {
                // Завершаем заявку и начисляем баллы (один раз)
                db.run(`UPDATE requests SET completed = 1, finishedAt = datetime('now') WHERE id = ? AND completed = 0`, [id], function (err4) {
                  if (err4) return fail(res, 500, 'Ошибка базы данных');
                  // если changes=0, значит кто-то уже закрыл
                  if (!this.changes) return ok(res, { ok: true, alreadyCompleted: true });

                  const add = r2.pointsToAdd || 5;
                  db.run(
                    `UPDATE users SET points = points + ?, completed = completed + 1 WHERE id = ?`,
                    [add, r2.assignedVolunteerId],
                    function (err5) {
                      if (err5) return fail(res, 500, 'Ошибка базы данных');
                      audit(req.user.id, 'request_completed', 'request', id, { pointsAdded: add, volunteerId: r2.assignedVolunteerId });
                      ok(res, { ok: true, pointsAdded: add });
                    }
                  );
                });
              } else {
                ok(res, { ok: true, waitingOther: true });
              }
            }
          );
        }
      );
      });
    }
  );
});

// volunteer: старый эндпоинт "complete" (оставил для совместимости)
// теперь правильно завершать через /finish (по согласию обоих)
app.post('/api/requests/:id/complete', (req, res) => {
  const id = toInt(req.params.id);
  const volunteerId = toInt(req.body.volunteerId);
  if (!id || !volunteerId) return fail(res, 400, 'Некорректные данные');
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.id !== volunteerId) return fail(res, 403, 'Нельзя завершать от чужого имени');

  db.get(`SELECT assignedVolunteerId, completed FROM requests WHERE id = ?`, [id], (err, row) => {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    if (!row) return fail(res, 404, 'Не найдено');
    if (row.completed) return fail(res, 400, 'Заявка уже завершена');
    if (row.assignedVolunteerId !== volunteerId) return fail(res, 403, 'Это не ваша заявка');

    // просто помечаем, что волонтёр хочет завершить, а дальше ждём второго
    // (начисление баллов будет в /finish, когда оба подтвердят)
    db.run(`UPDATE requests SET finishedVolunteer = 1 WHERE id = ?`, [id], function (err2) {
      if (err2) return fail(res, 500, 'Ошибка базы данных');
      audit(req.user.id, 'request_finish_vote', 'request', id, { by: 'finishedVolunteer', legacy: true });
      ok(res, { ok: true, waitingOther: true });
    });
  });
});

// отмена дела (может сделать автор заявки или назначенный волонтёр, пока не завершено)
app.post('/api/requests/:id/cancel', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const userId = toInt(req.body.userId);
  const reason = String(req.body.reason || '').trim();
  if (!id || !userId) return fail(res, 400, 'Некорректные данные');
  if (req.user.id !== userId) return fail(res, 403, 'Нельзя отменять от чужого имени');
  if (!reason) return fail(res, 400, 'Нужна причина отмены');

  db.get(
    `SELECT id, createdBy, assignedVolunteerId, status, completed, cancelled, helpAccepted
     FROM requests WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      if (row.completed) return fail(res, 400, 'Дело уже завершено');
      if (row.cancelled) return ok(res, { ok: true, alreadyCancelled: true });
      if (row.status !== 'approved') return fail(res, 400, 'Можно отменять только одобренные дела');

      const isCreator = (row.createdBy === userId);
      const isVolunteer = (row.assignedVolunteerId === userId);
      if (!isCreator && !isVolunteer) return fail(res, 403, 'Вы не участник этого дела');

      db.run(
        `UPDATE requests
         SET cancelled = 1,
             cancelReason = ?,
             cancelledBy = ?,
             cancelledAt = datetime('now'),
             helpAccepted = 0,
             finishedVolunteer = 0,
             finishedSeeker = 0
         WHERE id = ?`,
        [reason, userId, id],
        function (e2) {
          if (e2) return fail(res, 500, 'Ошибка базы данных');
          audit(req.user.id, 'request_cancel', 'request', id, { reason, by: isCreator ? 'seeker' : 'volunteer' });
          ok(res, { ok: true });
        }
      );
    }
  );
});

// создать заявку (уходит на проверку)
app.post('/api/requests', (req, res) => {
  const { title, type, difficulty, description, createdBy } = req.body;
  if (!title || !type || !description || !createdBy) return res.status(400).json({ error: 'Не заполнены поля' });
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  if (req.user.id !== toInt(createdBy)) return fail(res, 403, 'Нельзя создавать заявку от чужого имени');
  if (req.user.role !== 'seeker') return fail(res, 403, 'Заявки может создавать только нуждающийся');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (req.user.requestsLimitedUntil && req.user.requestsLimitedUntil > now) return fail(res, 403, 'Вам ограничено создание заявок до ' + req.user.requestsLimitedUntil);
  const diff = clamp(toInt(difficulty) || 1, 1, 5);
  const pts = pointsByDifficulty(diff);

  let requestCity = String(req.body.requestCity || req.user.city || '').trim();
  if (!requestCity) {
    return fail(res, 400, 'Укажите город, где нужна помощь (или заполните город в профиле).');
  }
  let urgency = String(req.body.urgency || 'flex');
  if (!['today', 'week', 'flex'].includes(urgency)) urgency = 'flex';
  const neededAt = String(req.body.neededAt || '').trim() || null;
  const recurring = req.body.recurring ? 1 : 0;
  const recurringNote = String(req.body.recurringNote || '').trim().slice(0, 400) || null;

  db.get(
    `SELECT COUNT(*) AS c FROM requests
     WHERE createdBy = ? AND IFNULL(cancelled,0)=0 AND IFNULL(completed,0)=0
       AND status IN ('pending','approved')`,
    [req.user.id],
    (eCnt, cntRow) => {
      if (eCnt) return fail(res, 500, 'Ошибка базы данных');
      const activeN = cntRow && cntRow.c ? cntRow.c : 0;
      if (activeN >= MAX_SEEKER_ACTIVE_REQUESTS) {
        return fail(
          res,
          400,
          `У вас уже ${MAX_SEEKER_ACTIVE_REQUESTS} активных заявок (на проверке или в работе). Завершите или отмените одну, чтобы создать новую.`
        );
      }

  db.run(
        `INSERT INTO requests (
           title, type, difficulty, pointsToAdd, description, createdBy, status,
           helpAccepted, finishedVolunteer, finishedSeeker,
           requestCity, urgency, neededAt, recurring, recurringNote
         )
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?, ?, ?)`,
        [title, type, diff, pts, description, createdBy, requestCity, urgency, neededAt, recurring, recurringNote],
    function (err) {
          if (err) return fail(res, 500, 'Ошибка базы данных');
          const rid = this.lastID;
          audit(req.user.id, 'request_create', 'request', rid, {
            type,
            difficulty: diff,
            requestCity,
            urgency,
            neededAt,
            recurring: !!recurring,
          });
          ok(res, { id: rid });
        }
      );
    }
  );
});

// одна заявка по id (для истории модерации и перехода из профиля)
app.get('/api/requests/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Некорректный id');
  db.get(
    `SELECT r.*,
            cu.name  AS creatorName,
            cu.email AS creatorEmail,
            vu.name  AS volunteerName,
            vu.email AS volunteerEmail
     FROM requests r
     LEFT JOIN users cu ON cu.id = r.createdBy
     LEFT JOIN users vu ON vu.id = r.assignedVolunteerId
     WHERE r.id = ?`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      if (!row) return fail(res, 404, 'Не найдено');
      ok(res, row);
    }
  );
});

// Информация о блокировке для текущего пользователя
app.get('/api/users/me/ban-info', (req, res) => {
  if (!req.user) return fail(res, 401, 'Нужно войти.');
  const id = req.user.id;
  db.get(
    `SELECT a.action, a.details, a.createdAt, u.name as actorName, u.email as actorEmail
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actorUserId
     WHERE a.entityType = 'user' AND a.entityId = ?
           AND (a.action = 'complaint_resolve' OR a.action = 'admin_user_update')
     ORDER BY a.id DESC
     LIMIT 1`,
    [id],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      let details = null;
      if (row && row.details) {
        try { details = JSON.parse(row.details); } catch { details = null; }
      }
      ok(res, {
        userId: id,
        status: req.user.status,
        banUntil: req.user.banUntil || null,
        banReason: req.user.banReason || null,
        actorName: row ? row.actorName : null,
        actorEmail: row ? row.actorEmail : null,
        action: row ? row.action : null,
        actionDetails: details,
        actionAt: row ? row.createdAt : null,
      });
    }
  );
});

// Список id чатов, в которых участвует указанный пользователь.
app.get('/api/chats', requireAuth, (req, res) => {
  const userId = toInt(req.query.userId);
  if (!userId) return fail(res, 400, 'Некорректный userId');
  if (req.user.role !== 'admin' && req.user.id !== userId) return fail(res, 403, 'Нельзя смотреть чужие чаты');

  db.all(
    `SELECT cu.chatId as id
     FROM chat_users cu
     WHERE cu.userId = ?
     ORDER BY cu.chatId DESC`,
    [userId],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows.map(r => ({ id: r.id })));
    }
  );
});

// Участники чата (имена для боковой колонки на фронте).
app.get('/api/chats/:id/participants', requireAuth, (req, res) => {
  const chatId = toInt(req.params.id);
  if (!chatId) return fail(res, 400, 'Некорректный chatId');

  assertChatAccess(chatId, req, res, (e0, allowed) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!allowed) return;

    db.all(
      `SELECT u.id, u.name, u.email, u.role, u.points, u.seekerVerified, u.volunteerVerified
       FROM chat_users cu
       JOIN users u ON u.id = cu.userId
       WHERE cu.chatId = ?`,
      [chatId],
      (err, rows) => {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        ok(res, rows);
      }
    );
  });
});

// Сообщения чата; опционально ?q= подстрока поиска по тексту.
app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
  const chatId = toInt(req.params.id);
  if (!chatId) return fail(res, 400, 'Некорректный chatId');
  const q = String(req.query.q || '').trim();

  assertChatAccess(chatId, req, res, (e0, allowed) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!allowed) return;

    db.all(
      `SELECT id, chatId, fromUserId, text, createdAt, readAt
       FROM messages
       WHERE chatId = ?
         ${q ? "AND text LIKE ?" : ""}
       ORDER BY id ASC
       LIMIT 500`,
      q ? [chatId, `%${q}%`] : [chatId],
      (err, rows) => {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        // отметим прочитанным всё, что не от текущего пользователя
        db.run(
          `UPDATE messages SET readAt = datetime('now')
           WHERE chatId = ? AND fromUserId != ? AND readAt IS NULL`,
          [chatId, req.user.id]
        );
        ok(res, rows);
      }
    );
  });
});

// Отправка сообщения (проверяем лимит чата у пользователя).
app.post('/api/chats/:id/messages', requireAuth, (req, res) => {
  const chatId = toInt(req.params.id);
  const { fromUserId, text } = req.body;
  const fromId = toInt(fromUserId);
  if (!chatId || !fromId || !text) return fail(res, 400, 'Некорректные данные');
  if (req.user.id !== fromId) return fail(res, 403, 'Нельзя отправлять от чужого имени');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (req.user.chatLimitedUntil && req.user.chatLimitedUntil > now) return fail(res, 403, 'Вам ограничена отправка сообщений до ' + req.user.chatLimitedUntil);

  assertChatAccess(chatId, req, res, (e0, allowed) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!allowed) return;

    db.run(
      `INSERT INTO messages (chatId, fromUserId, text) VALUES (?, ?, ?)`,
      [chatId, fromId, String(text).slice(0, 2000)],
      function (err) {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        ok(res, { id: this.lastID });
      }
    );
  });
});

// Найти существующий диалог между двумя людьми или создать новый чат + две связи в chat_users.
function createOrGetChat(aId, bId, cb) {
  // Ищем пару участников в одном chatId (без дублей чатов на двоих).
  db.get(
    `
    SELECT cu1.chatId as chatId
    FROM chat_users cu1
    JOIN chat_users cu2 ON cu1.chatId = cu2.chatId
    WHERE cu1.userId = ? AND cu2.userId = ?
    ORDER BY cu1.chatId DESC
    LIMIT 1
    `,
    [aId, bId],
    (err, row) => {
      if (err) return cb(err);
      if (row && row.chatId) return cb(null, row.chatId);

      db.run(`INSERT INTO chats DEFAULT VALUES`, [], function (err2) {
        if (err2) return cb(err2);
        const chatId = this.lastID;
        db.run(`INSERT INTO chat_users (chatId, userId) VALUES (?, ?)`, [chatId, aId]);
        db.run(`INSERT INTO chat_users (chatId, userId) VALUES (?, ?)`, [chatId, bId]);
        cb(null, chatId);
      });
    }
  );
}

// Явное создание диалога (или возврат уже существующего между этой парой).
app.post('/api/chats/create', requireAuth, (req, res) => {
  const aId = toInt(req.body.aId);
  const bId = toInt(req.body.bId);
  if (!aId || !bId) return fail(res, 400, 'Некорректные данные');
  if (req.user.role !== 'admin' && req.user.id !== aId) return fail(res, 403, 'Нельзя создавать чат от чужого имени');
  createOrGetChat(aId, bId, (err, chatId) => {
    if (err) return fail(res, 500, 'Ошибка базы данных');
    ok(res, { chatId });
  });
});

// Отзыв только по завершённому делу (requestId обязателен).
app.post('/api/reviews', requireAuth, (req, res) => {
  const targetUserId = toInt(req.body.targetUserId);
  const fromUserId = toInt(req.body.fromUserId);
  const rating = toInt(req.body.rating);
  const comment = String(req.body.comment || '');
  const requestId = toInt(req.body.requestId);

  if (!targetUserId || !fromUserId || !rating || rating < 1 || rating > 5) {
    return fail(res, 400, 'Некорректные данные');
  }
  if (req.user.id !== fromUserId) return fail(res, 403, 'Нельзя оставлять отзыв от чужого имени');
  if (!requestId) return fail(res, 400, 'Отзыв можно оставить только после завершённого дела (нужен requestId)');

  db.get(
    `SELECT id, createdBy, assignedVolunteerId, completed, cancelled
     FROM requests WHERE id = ?`,
    [requestId],
    (e0, r) => {
      if (e0) return fail(res, 500, 'Ошибка базы данных');
      if (!r) return fail(res, 404, 'Дело не найдено');
      if (!r.completed || r.cancelled) return fail(res, 400, 'Отзыв можно оставить только после завершённого дела');

      const a = r.createdBy;
      const b = r.assignedVolunteerId;
      const isParticipant = (fromUserId === a || fromUserId === b);
      const otherIsTarget = (targetUserId === a || targetUserId === b) && targetUserId !== fromUserId;
      if (!isParticipant || !otherIsTarget) return fail(res, 403, 'Отзыв можно оставить только участнику вашего завершённого дела');

      db.get(
        `SELECT id FROM reviews WHERE fromUserId = ? AND requestId = ?`,
        [fromUserId, requestId],
        (eDup, dup) => {
          if (eDup) return fail(res, 500, 'Ошибка базы данных');
          if (dup) return fail(res, 400, 'Вы уже оставили отзыв по этому делу');

          db.run(
            `INSERT INTO reviews (targetUserId, fromUserId, requestId, rating, comment)
             VALUES (?, ?, ?, ?, ?)`,
            [targetUserId, fromUserId, requestId, rating, comment.slice(0, 2000)],
            function (err) {
              if (err) return fail(res, 500, 'Ошибка базы данных');

              const reviewId = this.lastID;
              db.run(
                `UPDATE users SET ratingSum = ratingSum + ?, ratingCount = ratingCount + 1 WHERE id = ?`,
                [rating, targetUserId],
                function (err2) {
                  if (err2) return fail(res, 500, 'Ошибка базы данных');
                  audit(req.user.id, 'review_create', 'review', reviewId, { targetUserId, requestId, rating });
                  ok(res, { id: reviewId });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Все отзывы о выбранном пользователе (для вкладки профиля).
app.get('/api/reviews/:targetUserId', (req, res) => {
  const targetUserId = toInt(req.params.targetUserId);
  if (!targetUserId) return fail(res, 400, 'Некорректный id');

  db.all(
    `SELECT r.id, r.targetUserId, r.fromUserId, r.rating, r.comment, r.createdAt,
            u.name as fromName, u.email as fromEmail
     FROM reviews r
     LEFT JOIN users u ON u.id = r.fromUserId
     WHERE r.targetUserId = ?
     ORDER BY r.id DESC
     LIMIT 200`,
    [targetUserId],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// жалобы
app.post('/api/complaints', requireAuth, rateLimit('complaint', 30, 60_000), (req, res) => {
  const targetUserId = toInt(req.body.targetUserId);
  const fromUserId = toInt(req.body.fromUserId);
  const text = String(req.body.text || '').trim();
  if (!targetUserId || !fromUserId || !text) return fail(res, 400, 'Некорректные данные');
  if (req.user.id !== fromUserId) return fail(res, 403, 'Нельзя жаловаться от чужого имени');
  if (targetUserId === fromUserId) return fail(res, 400, 'Нельзя жаловаться на себя');

  db.run(
    `INSERT INTO complaints (targetUserId, fromUserId, text) VALUES (?, ?, ?)`,
    [targetUserId, fromUserId, text.slice(0, 2000)],
    function (err) {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      audit(req.user.id, 'complaint_create', 'complaint', this.lastID, { targetUserId });
      ok(res, { id: this.lastID });
    }
  );
});

// admin: список жалоб
app.get('/api/admin/complaints', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  db.all(
    `SELECT c.*, tu.email as targetEmail, fu.email as fromEmail
     FROM complaints c
     LEFT JOIN users tu ON tu.id = c.targetUserId
     LEFT JOIN users fu ON fu.id = c.fromUserId
     WHERE c.status = ?
     ORDER BY c.id DESC
     LIMIT 200`,
    [status],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// admin: решить жалобу + действия (с комментарием)
app.post('/api/admin/complaints/:id/resolve', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  const action = String(req.body.action || 'dismiss');
  const comment = String(req.body.comment || '').trim();
  const pointsDelta = toInt(req.body.pointsDelta) || -10;
  if (!id) return fail(res, 400, 'Некорректный id');
  if (action !== 'dismiss' && !comment) return fail(res, 400, 'Укажите причину (комментарий)');

  db.get(`SELECT * FROM complaints WHERE id = ?`, [id], (e0, c) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!c) return fail(res, 404, 'Не найдено');
    if (c.status !== 'pending') return fail(res, 400, 'Жалоба уже обработана');

    db.run(
      `UPDATE complaints
       SET status = 'resolved', resolvedBy = ?, resolvedAt = datetime('now'), resolveComment = ?
       WHERE id = ?`,
      [req.user.id, comment || null, id],
      function (e1) {
        if (e1) return fail(res, 500, 'Ошибка базы данных');

        const targetId = c.targetUserId;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        if (action === 'block_30') {
          const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
          db.run(`UPDATE users SET status = 'blocked', banReason = ?, banUntil = ? WHERE id = ?`, [comment, until, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'block_30', comment, until });
        } else if (action === 'block_perm') {
          db.run(`UPDATE users SET status = 'blocked', banReason = ?, banUntil = NULL WHERE id = ?`, [comment, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'block_perm', comment });
        } else if (action === 'limit_chat_7') {
          const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
          db.run(`UPDATE users SET chatLimitedUntil = ? WHERE id = ?`, [until, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'limit_chat_7', comment, until });
        } else if (action === 'limit_requests_7') {
          const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
          db.run(`UPDATE users SET requestsLimitedUntil = ? WHERE id = ?`, [until, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'limit_requests_7', comment, until });
        } else if (action === 'limit_both_7') {
          const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
          db.run(`UPDATE users SET chatLimitedUntil = ?, requestsLimitedUntil = ? WHERE id = ?`, [until, until, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'limit_both_7', comment, until });
        } else if (action === 'deduct') {
          db.run(`UPDATE users SET points = MAX(points + ?, 0) WHERE id = ?`, [pointsDelta, targetId]);
          audit(req.user.id, 'complaint_resolve', 'user', targetId, { action: 'deduct', pointsDelta, comment });
        } else {
          audit(req.user.id, 'complaint_resolve', 'complaint', id, { action: 'dismiss', comment });
        }
        ok(res, { ok: true });
      }
    );
  });
});

// Сводка уведомлений для пользователя (сообщения, заявки, жалобы для админа)
app.get('/api/notifications/summary', requireAuth, (req, res) => {
  const uid = req.user.id;
  const role = req.user.role;
  const items = [];
  let total = 0;

  db.get(
    `SELECT COUNT(*) as c FROM messages m
     INNER JOIN chat_users cu ON cu.chatId = m.chatId AND cu.userId = ?
     WHERE m.fromUserId != ? AND m.readAt IS NULL`,
    [uid, uid],
    (e0, row0) => {
      if (e0) return fail(res, 500, 'Ошибка базы данных');
      const unread = row0 && row0.c ? row0.c : 0;
      if (unread > 0) {
        items.push({
          id: 'messages',
          text: `Непрочитанных сообщений: ${unread}`,
          count: unread,
          page: 'chat',
        });
        total += Math.min(unread, 99);
      }

      const finish = () => ok(res, { total, items });

      if (role === 'admin') {
        db.get(`SELECT COUNT(*) as c FROM requests WHERE status = 'pending'`, [], (e1, r1) => {
          if (e1) return fail(res, 500, 'Ошибка базы данных');
          const n = r1 && r1.c ? r1.c : 0;
          if (n > 0) {
            items.push({ id: 'admin_req', text: `Заявок на верификацию: ${n}`, count: n, page: 'admin' });
            total += n;
          }
          db.get(`SELECT COUNT(*) as c FROM complaints WHERE status = 'pending'`, [], (e2, r2) => {
            if (e2) return fail(res, 500, 'Ошибка базы данных');
            const n2 = r2 && r2.c ? r2.c : 0;
            if (n2 > 0) {
              items.push({ id: 'admin_comp', text: `Жалоб на рассмотрение: ${n2}`, count: n2, page: 'admin' });
              total += n2;
            }
            finish();
          });
        });
      } else if (role === 'seeker') {
        db.get(`SELECT COUNT(*) as c FROM requests WHERE createdBy = ? AND status = 'pending'`, [uid], (e1, r1) => {
          if (e1) return fail(res, 500, 'Ошибка базы данных');
          const n = r1 && r1.c ? r1.c : 0;
          if (n > 0) {
            items.push({ id: 'my_pending', text: `Ваших заявок на проверке: ${n}`, count: n, page: 'dashboard' });
            total += n;
          }
          db.get(
            `SELECT COUNT(*) as c FROM requests WHERE createdBy = ? AND assignedVolunteerId IS NOT NULL AND IFNULL(helpAccepted,0)=0 AND IFNULL(cancelled,0)=0 AND IFNULL(completed,0)=0`,
            [uid],
            (e2, r2) => {
              if (e2) return fail(res, 500, 'Ошибка базы данных');
              const n2 = r2 && r2.c ? r2.c : 0;
              if (n2 > 0) {
                items.push({ id: 'accept_help', text: `Примите помощь по заявкам: ${n2}`, count: n2, page: 'dashboard' });
                total += n2;
              }
              db.get(
                `SELECT COUNT(*) as c FROM requests WHERE createdBy = ? AND IFNULL(helpAccepted,0)=1 AND IFNULL(completed,0)=0 AND IFNULL(finishedSeeker,0)=0 AND IFNULL(cancelled,0)=0`,
                [uid],
                (e3, r3) => {
                  if (e3) return fail(res, 500, 'Ошибка базы данных');
                  const n3 = r3 && r3.c ? r3.c : 0;
                  if (n3 > 0) {
                    items.push({
                      id: 'finish_seek',
                      text: `Подтвердите завершение дела (нуждающийся): ${n3}`,
                      count: n3,
                      page: 'dashboard',
                    });
                    total += n3;
                  }
                  finish();
                }
              );
            }
          );
        });
      } else if (role === 'volunteer') {
        db.get(
          `SELECT COUNT(*) as c FROM requests WHERE status = 'approved' AND IFNULL(cancelled,0)=0 AND IFNULL(completed,0)=0 AND (assignedVolunteerId IS NULL OR assignedVolunteerId = 0)`,
          [],
          (e1, r1) => {
            if (e1) return fail(res, 500, 'Ошибка базы данных');
            const n = r1 && r1.c ? r1.c : 0;
            if (n > 0) {
              items.push({ id: 'open_req', text: `Новых заявок без волонтёра: ${n}`, count: n, page: 'dashboard' });
              total += Math.min(n, 30);
            }
            db.get(
              `SELECT COUNT(*) as c FROM requests WHERE assignedVolunteerId = ? AND IFNULL(helpAccepted,0)=1 AND IFNULL(completed,0)=0 AND IFNULL(finishedVolunteer,0)=0 AND IFNULL(cancelled,0)=0`,
              [uid],
              (e2, r2) => {
                if (e2) return fail(res, 500, 'Ошибка базы данных');
                const n2 = r2 && r2.c ? r2.c : 0;
                if (n2 > 0) {
                  items.push({
                    id: 'finish_vol',
                    text: `Подтвердите завершение дела (волонтёр): ${n2}`,
                    count: n2,
                    page: 'dashboard',
                  });
                  total += n2;
                }
                finish();
              }
            );
          }
        );
      } else {
        finish();
      }
    }
  );
});

// admin: список заблокированных / с ограничениями
app.get('/api/admin/users/blocked', requireAdmin, (req, res) => {
  db.all(
    `SELECT id, name, email, role, status, banUntil, banReason, chatLimitedUntil, requestsLimitedUntil, points
     FROM users
     WHERE status = 'blocked'
        OR banUntil IS NOT NULL
        OR chatLimitedUntil IS NOT NULL
        OR requestsLimitedUntil IS NOT NULL
     ORDER BY status = 'blocked' DESC, id DESC`,
    [],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows || []);
    }
  );
});

// admin: управление пользователями (баллы/статус/ограничения)
app.post('/api/admin/users/update', requireAdmin, (req, res) => {
  const email = String(req.body.email || '').trim();
  const pointsDelta = toInt(req.body.pointsDelta) || 0;
  const status = String(req.body.status || 'keep'); // keep|active|limited|blocked
  const punishmentType = String(req.body.punishmentType || 'none'); // block_temp, block_perm, limit_chat, limit_requests, limit_both, remove_limits
  const punishmentReason = String(req.body.punishmentReason || '').trim();
  const durationDays = toInt(req.body.durationDays) || 0;
  const resetPoints = !!req.body.resetPoints;
  const seekerVerification = String(req.body.seekerVerification || 'keep'); // keep|approved|rejected|pending
  const volunteerVerification = String(req.body.volunteerVerification || 'keep'); // keep|approved|rejected|pending

  if (!email) return fail(res, 400, 'Нужен email');
  if (punishmentType !== 'none' && punishmentType !== 'remove_limits' && !punishmentReason) {
    return fail(res, 400, 'Укажите причину для наказания');
  }

  db.get(`SELECT * FROM users WHERE email = ?`, [email], (e0, u) => {
    if (e0) return fail(res, 500, 'Ошибка базы данных');
    if (!u) return fail(res, 404, 'Пользователь не найден');

    let finalStatus = status === 'keep' ? u.status : status;
    let banUntil = u.banUntil || null;
    let banReason = u.banReason || null;
    let chatLimitedUntil = u.chatLimitedUntil || null;
    let requestsLimitedUntil = u.requestsLimitedUntil || null;
    let seekerVerified = Number(u.seekerVerified || 0);
    let volunteerVerified = Number(u.volunteerVerified || 0);
    let seekerFormStatus = String(u.seekerFormStatus || 'not_submitted');
    let volunteerFormStatus = String(u.volunteerFormStatus || 'not_submitted');

    if (punishmentType === 'remove_limits') {
      // полное снятие блокировок/ограничений
      finalStatus = 'active';
      banUntil = null;
      banReason = null;
      chatLimitedUntil = null;
      requestsLimitedUntil = null;
    } else if (punishmentType !== 'none') {
      const until = durationDays > 0
        ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
        : null;
      if (punishmentType === 'block_temp') {
        finalStatus = 'blocked';
        banUntil = until;
        banReason = punishmentReason;
      } else if (punishmentType === 'block_perm') {
        finalStatus = 'blocked';
        banUntil = null;
        banReason = punishmentReason;
      } else if (punishmentType === 'limit_chat') {
        chatLimitedUntil = until;
      } else if (punishmentType === 'limit_requests') {
        requestsLimitedUntil = until;
      } else if (punishmentType === 'limit_both') {
        chatLimitedUntil = until;
        requestsLimitedUntil = until;
      }
    }

    const deltaPoints = resetPoints ? -u.points : pointsDelta;
    if (seekerVerification === 'approved') {
      seekerVerified = 1;
      seekerFormStatus = 'approved';
    } else if (seekerVerification === 'rejected') {
      seekerVerified = 0;
      seekerFormStatus = 'rejected';
    } else if (seekerVerification === 'pending') {
      seekerVerified = 0;
      seekerFormStatus = 'pending';
    }
    if (volunteerVerification === 'approved') {
      volunteerVerified = 1;
      volunteerFormStatus = 'approved';
    } else if (volunteerVerification === 'rejected') {
      volunteerVerified = 0;
      volunteerFormStatus = 'rejected';
    } else if (volunteerVerification === 'pending') {
      volunteerVerified = 0;
      volunteerFormStatus = 'pending';
    }

    db.run(
      `UPDATE users
       SET points = MAX(points + ?, 0),
           status = ?,
           banUntil = ?,
           banReason = ?,
           chatLimitedUntil = ?,
           requestsLimitedUntil = ?,
           seekerVerified = ?,
           volunteerVerified = ?,
           seekerFormStatus = ?,
           volunteerFormStatus = ?
       WHERE id = ?`,
      [deltaPoints, finalStatus, banUntil, banReason, chatLimitedUntil, requestsLimitedUntil, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, u.id],
      function (err) {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        audit(req.user.id, 'admin_user_update', 'user', u.id, {
          email,
          pointsDelta: deltaPoints,
          status: finalStatus,
          punishmentType,
          punishmentReason,
          durationDays,
          resetPoints,
          seekerVerification,
          volunteerVerification,
        });
        ok(res, { ok: true });
      }
    );
  });
});

// Топ волонтёров (по баллам)
app.get('/api/top/volunteers', (req, res) => {
  const limit = clamp(toInt(req.query.limit) || 10, 1, 50);
  db.all(
    `SELECT id, name, email, points, completed, ratingSum, ratingCount, city, age, about, seekerVerified, volunteerVerified
     FROM users
     WHERE role = 'volunteer' AND status != 'blocked'
     ORDER BY points DESC, completed DESC, id ASC
     LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, rows);
    }
  );
});

// п.6 — метрики для админ-панели
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  db.get(
    `SELECT
       (SELECT COUNT(*) FROM users) AS usersTotal,
       (SELECT COUNT(*) FROM users WHERE role = 'volunteer') AS volunteers,
       (SELECT COUNT(*) FROM users WHERE role = 'seeker') AS seekers,
       (SELECT COUNT(*) FROM requests WHERE status = 'pending') AS requestsPending,
       (SELECT COUNT(*) FROM requests WHERE status = 'approved' AND IFNULL(completed,0)=0 AND IFNULL(cancelled,0)=0) AS requestsActive,
       (SELECT COUNT(*) FROM requests WHERE IFNULL(completed,0)=1) AS requestsCompleted,
       (SELECT COUNT(*) FROM complaints WHERE status = 'pending') AS complaintsPending,
       (SELECT COUNT(*) FROM users WHERE seekerFormStatus = 'pending') AS seekerFormsPending,
       (SELECT COUNT(*) FROM users WHERE volunteerFormStatus = 'pending') AS volunteerFormsPending,
       (SELECT COUNT(*) FROM messages) AS messagesTotal,
       (SELECT COUNT(*) FROM chats) AS chatsTotal`,
    [],
    (err, row) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      ok(res, row || {});
    }
  );
});

// п.6 — выгрузка CSV (UTF-8 BOM для Excel)
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const kind = String(req.query.kind || 'requests');
  if (kind === 'users') {
    db.all(
      `SELECT id, name, email, role, points, completed, ratingSum, ratingCount, status, city, age, about, seekerVerified, volunteerVerified, seekerFormStatus, volunteerFormStatus, seekerPhone, volunteerPhone
       FROM users ORDER BY id ASC`,
      [],
      (err, rows) => {
        if (err) return fail(res, 500, 'Ошибка базы данных');
        const cols = ['id', 'name', 'email', 'role', 'points', 'completed', 'ratingSum', 'ratingCount', 'status', 'city', 'age', 'about', 'seekerVerified', 'volunteerVerified', 'seekerFormStatus', 'volunteerFormStatus', 'seekerPhone', 'volunteerPhone'];
        const lines = [cols.join(';')];
        (rows || []).forEach((r) => {
          lines.push(cols.map((c) => csvEscape(r[c])).join(';'));
        });
        const body = '\ufeff' + lines.join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="voluntis-users.csv"');
        return res.send(body);
      }
    );
    return;
  }
  db.all(
    `SELECT id, title, type, status, requestCity, urgency, neededAt, recurring, recurringNote,
            difficulty, pointsToAdd, description, createdBy, assignedVolunteerId,
            completed, cancelled, createdAt, helpAccepted, finishedAt
     FROM requests ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return fail(res, 500, 'Ошибка базы данных');
      const cols = [
        'id',
        'title',
        'type',
        'status',
        'requestCity',
        'urgency',
        'neededAt',
        'recurring',
        'recurringNote',
        'difficulty',
        'pointsToAdd',
        'description',
        'createdBy',
        'assignedVolunteerId',
        'completed',
        'cancelled',
        'createdAt',
        'helpAccepted',
        'finishedAt',
      ];
      const lines = [cols.join(';')];
      (rows || []).forEach((r) => {
        lines.push(cols.map((c) => csvEscape(r[c])).join(';'));
      });
      const body = '\ufeff' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="voluntis-requests.csv"');
      return res.send(body);
    }
  );
});

// Проверка для Render / мониторинга
app.get('/api/health', (req, res) => ok(res, { ok: true, service: 'voluntis-api' }));

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 — чтобы Render и другие хостинги принимали внешние подключения.
app.listen(PORT, '0.0.0.0', () => console.log(`Server: http://localhost:${PORT}`));