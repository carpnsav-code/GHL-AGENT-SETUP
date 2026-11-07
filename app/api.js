// JSON API for the Mint Concrete crew app: accounts, time clock, group chat.

import * as store from './db.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  destroySession,
  tokenFromRequest,
  sessionCookie,
  clearSessionCookie,
} from './auth.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const MIN_PASSWORD = 6;
const MAX_MESSAGE = 2000;
const MAX_NOTE = 200;
const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Fixed-window limiter for login/registration attempts, per client IP. */
function makeRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt < t) {
      h = { count: 0, resetAt: t + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt < t) hits.delete(k);
    return h.count <= max;
  };
}

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function locationOut(lat, lng, accuracy) {
  if (lat == null || lng == null) return null;
  return { lat, lng, accuracy: accuracy ?? null };
}

function entryOut(e) {
  return {
    id: e.id,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    note: e.note ?? '',
    inLocation: locationOut(e.in_lat, e.in_lng, e.in_accuracy),
    outLocation: locationOut(e.out_lat, e.out_lng, e.out_accuracy),
  };
}

/**
 * Validate the GPS fix sent by the phone. Returns `{lat, lng, accuracy}` or
 * null when none was sent; throws when `required` and none was sent.
 */
function parseLocation(raw, required) {
  if (raw == null || typeof raw !== 'object') {
    if (required) throw new HttpError(400, 'Location is required. Turn on location access for this app and try again.');
    return null;
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'Invalid location.');
  }
  const accuracy = Number.isFinite(Number(raw.accuracy)) && Number(raw.accuracy) >= 0 ? Math.round(Number(raw.accuracy)) : null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), accuracy };
}

function messageOut(m) {
  return {
    id: m.id,
    userId: m.user_id,
    displayName: m.display_name,
    username: m.username,
    body: m.body,
    createdAt: m.created_at,
  };
}

// ---------------------------------------------------------------------------

export function createApi(db, { joinCode = '', requireLocation = true } = {}) {
  const authLimiter = makeRateLimiter({ max: 30, windowMs: 15 * 60 * 1000 });

  // Live update stream (Server-Sent Events) ---------------------------------
  const streams = new Set();
  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref?.();

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(frame);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  // Route table -------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) =>
    routes.push({ method, pattern, handler, auth: opts.auth !== false });

  // --- Accounts ---
  route('POST', '/api/auth/register', async ({ req, res, body }) => {
    if (!authLimiter(clientIp(req))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const username = str(body.username, 30).toLowerCase();
    const displayName = str(body.displayName, 60) || username;
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Username must be 3-30 characters: letters, numbers, dots, dashes or underscores.');
    }
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    if (joinCode && str(body.joinCode, 100) !== joinCode) throw new HttpError(403, 'Wrong company join code.');
    if (store.findUserByUsername(db, username)) throw new HttpError(409, 'That username is already taken.');

    const role = store.countUsers(db) === 0 ? 'owner' : 'crew';
    const user = store.createUser(db, { username, displayName, passwordHash: await hashPassword(password), role });
    const { token } = createSession(db, user.id, req.headers['user-agent']);
    send(res, 201, { user: store.publicUser(user), token }, { 'Set-Cookie': sessionCookie(req, token) });
  }, { auth: false });

  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    if (!authLimiter(clientIp(req))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const username = str(body.username, 30).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = store.findUserByUsername(db, username);
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) throw new HttpError(401, 'Wrong username or password.');
    const { token } = createSession(db, user.id, req.headers['user-agent']);
    send(res, 200, { user: store.publicUser(user), token }, { 'Set-Cookie': sessionCookie(req, token) });
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ req, res }) => {
    destroySession(db, tokenFromRequest(req));
    send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
  }, { auth: false });

  route('GET', '/api/auth/me', ({ res, user }) => {
    send(res, 200, { user: store.publicUser(user) });
  });

  route('GET', '/api/team', ({ res }) => {
    send(res, 200, { users: store.listUsers(db).map(store.publicUser) });
  });

  // --- Time clock ---
  route('GET', '/api/time/status', ({ res, user }) => {
    const open = store.openEntryFor(db, user.id);
    send(res, 200, {
      open: open ? entryOut(open) : null,
      onClock: store.listOnClock(db).map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        since: r.clock_in,
        note: r.note ?? '',
        location: locationOut(r.in_lat, r.in_lng, r.in_accuracy),
      })),
      requireLocation,
      serverTime: store.now(),
    });
  });

  route('POST', '/api/time/clock-in', ({ res, user, body }) => {
    if (store.openEntryFor(db, user.id)) throw new HttpError(409, 'You are already clocked in.');
    const location = parseLocation(body.location, requireLocation);
    const entry = store.clockIn(db, user.id, str(body.note, MAX_NOTE), location);
    broadcast('clock', { userId: user.id, displayName: user.display_name, action: 'in', at: entry.clock_in });
    send(res, 201, { entry: entryOut(entry) });
  });

  route('POST', '/api/time/clock-out', ({ res, user, body }) => {
    const open = store.openEntryFor(db, user.id);
    if (!open) throw new HttpError(409, 'You are not clocked in.');
    const location = parseLocation(body.location, requireLocation);
    const entry = store.clockOut(db, open.id, str(body.note, MAX_NOTE), location);
    broadcast('clock', { userId: user.id, displayName: user.display_name, action: 'out', at: entry.clock_out });
    send(res, 200, { entry: entryOut(entry) });
  });

  route('GET', '/api/time/entries', ({ res, user, url }) => {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    send(res, 200, { entries: store.listEntries(db, user.id, limit).map(entryOut) });
  });

  // --- Group chat ---
  route('GET', '/api/chat/messages', ({ res, url }) => {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    const messages = store.listMessages(db, {
      afterId: after != null ? Number(after) : null,
      beforeId: before != null ? Number(before) : null,
      limit,
    });
    send(res, 200, { messages: messages.map(messageOut) });
  });

  route('POST', '/api/chat/messages', ({ res, user, body }) => {
    const text = str(body.body, MAX_MESSAGE);
    if (!text) throw new HttpError(400, 'Message cannot be empty.');
    const message = messageOut(store.insertMessage(db, user.id, text));
    broadcast('message', message);
    send(res, 201, { message });
  });

  route('GET', '/api/chat/stream', ({ req, res }) => openStream(req, res));

  // Dispatcher --------------------------------------------------------------
  async function handle(req, res, url) {
    const samePath = routes.filter((r) => r.pattern === url.pathname);
    if (!samePath.length) return send(res, 404, { error: 'Not found' });
    const match = samePath.find((r) => r.method === req.method);
    if (!match) {
      return send(res, 405, { error: 'Method not allowed' }, { Allow: samePath.map((r) => r.method).join(', ') });
    }
    try {
      const user = resolveSession(db, tokenFromRequest(req));
      if (match.auth && !user) throw new HttpError(401, 'Please log in.');
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Body must be a JSON object');
      }
      await match.handler({ req, res, url, user, body });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server.' });
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of streams) res.end();
    streams.clear();
  }

  return { handle, close, broadcast };
}
