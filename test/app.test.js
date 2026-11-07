import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../app/server.js';

let server;
let base;

before(async () => {
  server = createServer({ dbFile: ':memory:', joinCode: 'MINT2026' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.shutdown());

/** Minimal client that remembers its session cookie, like a browser. */
function client() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    },
  };
}

const boss = client();
const mike = client();

test('serves the web app shell', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Mint Concrete/);
  const manifest = await fetch(base + '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).name, 'Mint Concrete');
});

test('registration validates input and requires the join code', async () => {
  let r = await boss.call('POST', '/api/auth/register', { username: 'ab', password: 'secret1', joinCode: 'MINT2026' });
  assert.equal(r.status, 400);
  r = await boss.call('POST', '/api/auth/register', { username: 'boss', password: '123', joinCode: 'MINT2026' });
  assert.equal(r.status, 400);
  r = await boss.call('POST', '/api/auth/register', { username: 'boss', password: 'secret1', joinCode: 'nope' });
  assert.equal(r.status, 403);
});

test('first account becomes owner, later ones are crew', async () => {
  let r = await boss.call('POST', '/api/auth/register', {
    username: 'Boss', displayName: 'The Boss', password: 'secret1', joinCode: 'MINT2026',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.username, 'boss');
  assert.equal(r.data.user.role, 'owner');
  assert.ok(r.data.token);
  assert.match(boss.cookie, /^mc_session=/);

  r = await mike.call('POST', '/api/auth/register', {
    username: 'mike', displayName: 'Mike Ramirez', password: 'secret1', joinCode: 'MINT2026',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'crew');

  r = await client().call('POST', '/api/auth/register', { username: 'MIKE', password: 'secret1', joinCode: 'MINT2026' });
  assert.equal(r.status, 409, 'usernames are unique case-insensitively');
});

test('login persists: the cookie alone identifies the user on later requests', async () => {
  const r = await boss.call('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.displayName, 'The Boss');

  const anon = await client().call('GET', '/api/auth/me');
  assert.equal(anon.status, 401);
});

test('login works with a Bearer token too (installed-app fallback)', async () => {
  const fresh = client();
  let r = await fresh.call('POST', '/api/auth/login', { username: 'mike', password: 'wrong' });
  assert.equal(r.status, 401);
  r = await fresh.call('POST', '/api/auth/login', { username: 'MIKE', password: 'secret1' });
  assert.equal(r.status, 200);
  const token = r.data.token;
  const bare = client();
  r = await bare.call('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.username, 'mike');
});

test('clock in / clock out is saved and reported', async () => {
  let r = await mike.call('GET', '/api/time/status');
  assert.equal(r.data.open, null);

  r = await mike.call('POST', '/api/time/clock-in', { note: 'Elm St driveway' });
  assert.equal(r.status, 201);
  assert.equal(r.data.entry.note, 'Elm St driveway');
  assert.equal(r.data.entry.clockOut, null);

  r = await mike.call('POST', '/api/time/clock-in', {});
  assert.equal(r.status, 409, 'cannot clock in twice');

  r = await boss.call('GET', '/api/time/status');
  assert.equal(r.data.onClock.length, 1);
  assert.equal(r.data.onClock[0].displayName, 'Mike Ramirez');

  r = await mike.call('POST', '/api/time/clock-out', { note: 'poured 2 slabs' });
  assert.equal(r.status, 200);
  assert.ok(r.data.entry.clockOut);
  assert.equal(r.data.entry.note, 'Elm St driveway — poured 2 slabs');

  r = await mike.call('POST', '/api/time/clock-out', {});
  assert.equal(r.status, 409, 'cannot clock out when not clocked in');

  r = await mike.call('GET', '/api/time/entries');
  assert.equal(r.data.entries.length, 1);
  assert.ok(Date.parse(r.data.entries[0].clockOut) >= Date.parse(r.data.entries[0].clockIn));

  r = await boss.call('GET', '/api/time/entries');
  assert.equal(r.data.entries.length, 0, 'entries are per person');
});

test('group chat: everyone sees everyone, live over SSE', async () => {
  // Open a live stream as the boss before Mike posts.
  const ac = new AbortController();
  const streamRes = await fetch(base + '/api/chat/stream', { headers: { Cookie: boss.cookie }, signal: ac.signal });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const waitFor = async (needle) => {
    while (!buffer.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  await waitFor('event: hello');

  let r = await mike.call('POST', '/api/chat/messages', { body: '   ' });
  assert.equal(r.status, 400);
  r = await mike.call('POST', '/api/chat/messages', { body: 'Pour starts at 6am tomorrow' });
  assert.equal(r.status, 201);
  const first = r.data.message;
  assert.equal(first.displayName, 'Mike Ramirez');

  await waitFor('Pour starts at 6am tomorrow');
  ac.abort();

  r = await boss.call('POST', '/api/chat/messages', { body: 'Copy that' });
  assert.equal(r.status, 201);

  r = await mike.call('GET', '/api/chat/messages');
  assert.deepEqual(r.data.messages.map((m) => m.body), ['Pour starts at 6am tomorrow', 'Copy that']);

  r = await mike.call('GET', `/api/chat/messages?after=${first.id}`);
  assert.deepEqual(r.data.messages.map((m) => m.body), ['Copy that']);

  const anon = await client().call('GET', '/api/chat/messages');
  assert.equal(anon.status, 401, 'chat is private to logged-in crew');
});

test('logout ends the session', async () => {
  const c = client();
  await c.call('POST', '/api/auth/login', { username: 'mike', password: 'secret1' });
  assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
  const saved = c.cookie;
  await c.call('POST', '/api/auth/logout');
  const r = await client().call('GET', '/api/auth/me', undefined, { Cookie: saved });
  assert.equal(r.status, 401);
});
