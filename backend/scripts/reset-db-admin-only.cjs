/**
 * Удаляет всех пользователей кроме admin@example.com, все заявки, чаты, сообщения,
 * отзывы, жалобы, сессии, аудит и meta. Сбрасывает статистику у админа.
 * Остановите server.js перед запуском, иначе возможен SQLITE_BUSY.
 * Запуск: node scripts/reset-db-admin-only.cjs (из папки backend)
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

const steps = [
  'DELETE FROM sessions',
  'DELETE FROM messages',
  'DELETE FROM chat_users',
  'DELETE FROM chats',
  'DELETE FROM reviews',
  'DELETE FROM complaints',
  'DELETE FROM audit_logs',
  'DELETE FROM requests',
  'DELETE FROM meta',
  `DELETE FROM users WHERE LOWER(TRIM(email)) <> LOWER('admin@example.com')`,
  `UPDATE users SET points = 0, completed = 0, ratingSum = 0, ratingCount = 0,
     status = 'active', banUntil = NULL, banReason = NULL,
     chatLimitedUntil = NULL, requestsLimitedUntil = NULL
   WHERE LOWER(TRIM(email)) = LOWER('admin@example.com')`,
];

function run() {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = OFF');
    for (const sql of steps) {
      db.run(sql, (err) => {
        if (err) console.error('SQL error:', err.message, '\n', sql.slice(0, 80));
      });
    }
    db.run('PRAGMA foreign_keys = ON', (err) => {
      if (err) console.error(err);
      db.get('SELECT COUNT(*) AS c FROM users', (e, row) => {
        if (e) console.error(e);
        else console.log('Готово. Пользователей в БД:', row && row.c);
        db.close();
      });
    });
  });
}

run();
