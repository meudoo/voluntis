/**
 * Smoke E2E: seeker creates request → admin approves → volunteer takes → accept → finish ×2.
 * Run: node scripts/e2e-smoke.mjs  (from backend/, server must be on :3000)
 */
const base = 'http://127.0.0.1:3000';

async function post(path, body, token) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${j.error || r.statusText}`);
  return j;
}

async function get(path, token) {
  const r = await fetch(base + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${j.error || r.statusText}`);
  return j;
}

async function main() {
  const seeker = await post('/api/login', { email: 'oleg@example.com', password: '123' });
  const vol = await post('/api/login', { email: 'anna@example.com', password: '123' });
  const admin = await post('/api/login', { email: 'admin@example.com', password: 'admin' });

  const ts = Date.now();
  const created = await post(
    '/api/requests',
    {
      title: 'E2E ' + ts,
      type: 'shopping',
      difficulty: 2,
      description: 'smoke test',
      createdBy: seeker.user.id,
      requestCity: 'smoke-city',
      urgency: 'flex',
      recurring: false,
    },
    seeker.token
  );
  const rid = created.id;

  await post('/api/admin/requests/' + rid + '/approve', {}, admin.token);

  const takeOut = await post('/api/requests/' + rid + '/take', { volunteerId: vol.user.id }, vol.token);
  if (!takeOut.chatId) throw new Error('take: no chatId');

  // посторонний пользователь (не в этом чате) не должен читать переписку
  const strangerEmail = `e2e_stranger_${ts}@smoke.local`;
  const other = await post('/api/register', {
    name: 'E2E stranger',
    email: strangerEmail,
    password: '123',
    role: 'volunteer',
  });
  const badMsg = await fetch(base + '/api/chats/' + takeOut.chatId + '/messages', {
    headers: { Authorization: 'Bearer ' + other.token },
  });
  if (badMsg.status !== 403) throw new Error('expected 403 for non-member chat read, got ' + badMsg.status);

  await post('/api/requests/' + rid + '/accept', { seekerId: seeker.user.id }, seeker.token);
  await post('/api/requests/' + rid + '/finish', { userId: vol.user.id }, vol.token);
  const fin2 = await post('/api/requests/' + rid + '/finish', { userId: seeker.user.id }, seeker.token);
  if (!fin2.pointsAdded) throw new Error('expected pointsAdded on final finish');

  const summ = await get('/api/notifications/summary', vol.token);
  if (typeof summ.total !== 'number') throw new Error('notifications summary shape');

  const rev = await post(
    '/api/reviews',
    {
      targetUserId: vol.user.id,
      fromUserId: seeker.user.id,
      requestId: rid,
      rating: 5,
      comment: 'ok',
    },
    seeker.token
  );
  if (!rev.id) throw new Error('review id');

  try {
    await post(
      '/api/reviews',
      {
        targetUserId: vol.user.id,
        fromUserId: seeker.user.id,
        requestId: rid,
        rating: 4,
        comment: 'dup',
      },
      seeker.token
    );
    throw new Error('duplicate review should fail');
  } catch (e) {
    if (!String(e.message).includes('400')) throw e;
  }

  console.log('e2e-smoke OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
