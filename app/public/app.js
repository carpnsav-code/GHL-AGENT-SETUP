// Mint Concrete crew app — client.
// Plain JavaScript, no build step. Talks to /api/* on the same origin.

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---------------------------------------------------------------------------
// API client. The session cookie does the work; the token is also kept in
// localStorage and sent as a Bearer header so an installed (home-screen) copy
// stays logged in even if the browser drops cookies.

const api = {
  token: safeGet('mc_token'),
  async call(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (p) => api.call('GET', p),
  post: (p, b = {}) => api.call('POST', p, b),
  setToken(t) {
    this.token = t;
    if (t) safeSet('mc_token', t); else safeRemove('mc_token');
  },
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function safeRemove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// State

const state = {
  user: null,
  tab: safeGet('mc_tab') || 'clock',
  clock: { open: null, onClock: [], entries: [], loaded: false },
  chat: { messages: [], lastId: 0, unread: 0, loaded: false, hasMore: true },
  timers: { tick: null, poll: null },
  stream: null,
  installPrompt: null,
};

// ---------------------------------------------------------------------------
// Helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 42%)`;
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDay(iso) {
  const d = new Date(iso);
  const today = startOfDay(new Date());
  const that = startOfDay(d);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek() { const d = startOfDay(new Date()); d.setDate(d.getDate() - d.getDay()); return d; } // weeks start Sunday
function overlapMs(entry, from) {
  const s = Date.parse(entry.clockIn);
  const e = entry.clockOut ? Date.parse(entry.clockOut) : Date.now();
  return Math.max(0, Math.min(e, Date.now()) - Math.max(s, from));
}

/** Ask the phone for a GPS fix. Resolves to {lat, lng, accuracy} or rejects with a readable message. */
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This device cannot share its location.'));
    if (!window.isSecureContext) return reject(new Error('Location only works over HTTPS. Ask the office for the secure app link.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => {
        const msgs = {
          1: 'Location access is blocked. Allow location for this app in your phone settings, then try again.',
          2: "Couldn't get a GPS fix. Step outside or check that location services are on, then try again.",
          3: 'Getting your location timed out. Try again.',
        };
        reject(new Error(msgs[err.code] || 'Could not get your location.'));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
    );
  });
}

const mapUrl = (loc) => `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
function pin(loc, label) {
  if (!loc) return `<span class="loc none">${label}: no location</span>`;
  const acc = loc.accuracy != null ? ` ±${Math.round(loc.accuracy)}m` : '';
  return `<a class="loc" href="${mapUrl(loc)}" target="_blank" rel="noopener">📍 ${label}${acc}</a>`;
}

let toastTimer = null;
function toast(msg, kind = '') {
  $toast.textContent = msg;
  $toast.className = `toast ${kind}`;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2800);
}

const ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
};

// ---------------------------------------------------------------------------
// Boot: restore the saved login

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });

  if (!api.token && !document.cookie.includes('mc_session=')) return renderAuth();
  try {
    const { user } = await api.get('/api/auth/me');
    enter(user);
  } catch (err) {
    if (err.status === 401) { api.setToken(null); return renderAuth(); }
    renderRetry(err);
  }
}

function renderRetry(err) {
  $app.innerHTML = `
    <div class="boot">
      <div class="logo-mark">MC</div>
      <p>Can't reach the server.<br><small>${esc(err.message)}</small></p>
      <button class="btn" style="width:auto" id="retry">Try again</button>
    </div>`;
  document.getElementById('retry').onclick = boot;
}

// ---------------------------------------------------------------------------
// Auth screen

function renderAuth(mode = 'login') {
  const lastUser = safeGet('mc_last_user') || '';
  $app.innerHTML = `
    <div class="auth">
      <div class="brand">
        <div class="logo-mark">MC</div>
        <div><h1>Mint Concrete</h1><p>Crew time clock &amp; team chat</p></div>
      </div>
      <div class="segmented" role="tablist">
        <button type="button" data-mode="login" class="${mode === 'login' ? 'active' : ''}">Log in</button>
        <button type="button" data-mode="register" class="${mode === 'register' ? 'active' : ''}">Create account</button>
      </div>
      <form class="card" id="authForm" autocomplete="on">
        <div class="error" id="authError" hidden></div>
        ${mode === 'register' ? `
          <div class="field"><label for="displayName">Your name</label>
            <input id="displayName" name="displayName" placeholder="e.g. Mike Ramirez" required maxlength="60" autocomplete="name"></div>` : ''}
        <div class="field"><label for="username">Username</label>
          <input id="username" name="username" placeholder="e.g. mike" required maxlength="30" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="username" value="${mode === 'login' ? esc(lastUser) : ''}"></div>
        <div class="field"><label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="6" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"></div>
        ${mode === 'register' ? `
          <div class="field"><label for="joinCode">Company join code <small>(if your boss gave you one)</small></label>
            <input id="joinCode" name="joinCode" autocapitalize="off" autocorrect="off" autocomplete="off"></div>
          <p class="hint">You only have to log in once on this phone. The app remembers you.</p>` : ''}
        <button class="btn" type="submit" id="authSubmit">${mode === 'login' ? 'Log in' : 'Create my account'}</button>
      </form>
    </div>`;

  $app.querySelectorAll('.segmented button').forEach((b) => { b.onclick = () => renderAuth(b.dataset.mode); });
  const form = document.getElementById('authForm');
  const $err = document.getElementById('authError');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('authSubmit');
    btn.disabled = true; $err.hidden = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', data);
      api.setToken(res.token);
      safeSet('mc_last_user', res.user.username);
      enter(res.user);
    } catch (err) {
      $err.textContent = err.message; $err.hidden = false; btn.disabled = false;
    }
  };
  (mode === 'login' && lastUser ? document.getElementById('password') : form.querySelector('input')).focus();
}

// ---------------------------------------------------------------------------
// Main shell

function enter(user) {
  state.user = user;
  renderShell();
  loadClock();
  loadChat().then(startStream);
  document.addEventListener('visibilitychange', onVisibility);
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* best effort */ }
  stopLive();
  api.setToken(null);
  state.user = null;
  state.clock = { open: null, onClock: [], entries: [], loaded: false };
  state.chat = { messages: [], lastId: 0, unread: 0, loaded: false, hasMore: true };
  document.removeEventListener('visibilitychange', onVisibility);
  renderAuth();
}

function renderShell() {
  $app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="logo-mark">MC</div>
        <div class="title"><strong>Mint Concrete</strong><span id="topSub">${esc(state.user.displayName)}</span></div>
        <button type="button" id="logoutBtn">Log out</button>
      </header>
      <main class="content">
        <section class="panel clock" id="clockPanel"></section>
        <section class="panel chat" id="chatPanel" hidden>
          <div class="messages" id="messages"></div>
          <form class="composer" id="composer">
            <textarea id="msgInput" rows="1" placeholder="Message the crew…" maxlength="2000" enterkeyhint="send"></textarea>
            <button type="submit" id="sendBtn" aria-label="Send" disabled>${ICONS.send}</button>
          </form>
        </section>
      </main>
      <nav class="tabbar">
        <button type="button" data-tab="clock">${ICONS.clock}Time clock</button>
        <button type="button" data-tab="chat">${ICONS.chat}Crew chat<span class="badge" id="chatBadge" hidden></span></button>
      </nav>
    </div>`;
  document.getElementById('logoutBtn').onclick = () => { if (confirm('Log out of Mint Concrete on this device?')) logout(); };
  $app.querySelectorAll('.tabbar button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  setupComposer();
  showTab(state.tab);
}

function showTab(tab) {
  state.tab = tab;
  safeSet('mc_tab', tab);
  document.getElementById('clockPanel').hidden = tab !== 'clock';
  document.getElementById('chatPanel').hidden = tab !== 'chat';
  $app.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'chat') {
    state.chat.unread = 0; updateBadge();
    requestAnimationFrame(() => scrollToBottom(true));
  }
}

function updateBadge() {
  const b = document.getElementById('chatBadge');
  if (!b) return;
  b.hidden = state.chat.unread === 0;
  b.textContent = state.chat.unread > 99 ? '99+' : String(state.chat.unread);
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  loadClock();
  catchUp();
  if (!state.stream || state.stream.readyState === EventSource.CLOSED) startStream();
}

// ---------------------------------------------------------------------------
// Time clock

async function loadClock() {
  try {
    const [status, list] = await Promise.all([api.get('/api/time/status'), api.get('/api/time/entries?limit=200')]);
    state.clock = {
      open: status.open, onClock: status.onClock, entries: list.entries, loaded: true,
      requireLocation: status.requireLocation,
    };
    renderClock();
  } catch (err) {
    if (err.status === 401) return sessionLost();
    toast(err.message, 'error');
  }
}

function renderClock() {
  const { open, onClock, entries, loaded } = state.clock;
  const panel = document.getElementById('clockPanel');
  if (!panel) return;
  if (!loaded) { panel.innerHTML = '<div class="empty">Loading…</div>'; return; }

  const todayMs = entries.reduce((s, e) => s + overlapMs(e, startOfDay(new Date()).getTime()), 0);
  const weekMs = entries.reduce((s, e) => s + overlapMs(e, startOfWeek().getTime()), 0);
  const recent = entries.filter((e) => e.clockOut).slice(0, 30);

  panel.innerHTML = `
    <div class="card status ${open ? 'in' : ''}">
      <div class="label">${open ? 'On the clock' : 'Off the clock'}</div>
      <div class="big" id="elapsed">${open ? fmtClock(Date.now() - Date.parse(open.clockIn)) : '—'}</div>
      <div class="sub">${open ? `Clocked in at ${fmtTime(open.clockIn)}${open.note ? ` · ${esc(open.note)}` : ''}` : 'Tap below when you start work'}</div>
      ${open ? `<div class="sub">${pin(open.inLocation, 'Clock-in location')}</div>` : '<div class="sub small">Your location is recorded when you clock in and out.</div>'}
    </div>
    <form id="clockForm">
      <div class="field">
        <input id="note" placeholder="${open ? 'Note for clock-out (optional)' : 'Job site or note (optional)'}" maxlength="200" autocomplete="off">
      </div>
      <button class="btn big ${open ? 'danger' : ''}" type="submit" id="clockBtn">${open ? 'Clock out' : 'Clock in'}</button>
    </form>
    <div class="totals">
      <div class="card"><div class="k">Today</div><div class="v" id="todayTotal">${fmtDur(todayMs)}</div></div>
      <div class="card"><div class="k">This week</div><div class="v" id="weekTotal">${fmtDur(weekMs)}</div></div>
    </div>
    ${installBanner()}
    <h2 class="section">On the clock now</h2>
    <div class="card list" id="onClock">
      ${onClock.length ? onClock.map((p) => `
        <div class="row">
          <div class="avatar" style="background:${avatarColor(p.displayName)}">${esc(initials(p.displayName))}</div>
          <div class="main"><strong>${esc(p.displayName)}${p.userId === state.user.id ? ' (you)' : ''}</strong><span>Since ${fmtTime(p.since)}${p.note ? ` · ${esc(p.note)}` : ''}</span><span>${pin(p.location, 'Location')}</span></div>
          <div class="dur live" data-since="${esc(p.since)}">${fmtDur(Date.now() - Date.parse(p.since))}</div>
        </div>`).join('') : '<div class="empty">Nobody is clocked in right now.</div>'}
    </div>
    <h2 class="section">Your recent shifts</h2>
    <div class="card list">
      ${recent.length ? recent.map((e) => `
        <div class="row">
          <div class="main"><strong>${fmtDay(e.clockIn)}</strong><span>${fmtTime(e.clockIn)} – ${fmtTime(e.clockOut)}${e.note ? ` · ${esc(e.note)}` : ''}</span><span>${pin(e.inLocation, 'In')} &nbsp; ${pin(e.outLocation, 'Out')}</span></div>
          <div class="dur">${fmtDur(Date.parse(e.clockOut) - Date.parse(e.clockIn))}</div>
        </div>`).join('') : '<div class="empty">No completed shifts yet.</div>'}
    </div>`;

  document.getElementById('clockForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('clockBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Getting your location…';
    const note = document.getElementById('note').value.trim();
    let location = null;
    try {
      location = await getLocation();
    } catch (err) {
      if (state.clock.requireLocation !== false) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = label;
        return;
      }
    }
    btn.textContent = open ? 'Clocking out…' : 'Clocking in…';
    try {
      await api.post(open ? '/api/time/clock-out' : '/api/time/clock-in', { note, location });
      toast(open ? 'Clocked out. Nice work.' : 'Clocked in. Have a good one.');
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (err) {
      if (err.status === 401) return sessionLost();
      toast(err.message, 'error');
    }
    loadClock();
  };
  const ib = document.getElementById('installBtn');
  if (ib) ib.onclick = async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; renderClock(); };

  clearInterval(state.timers.tick);
  state.timers.tick = setInterval(tick, 1000);
}

function tick() {
  const { open, entries } = state.clock;
  const el = document.getElementById('elapsed');
  if (!el) return clearInterval(state.timers.tick);
  if (open) {
    el.textContent = fmtClock(Date.now() - Date.parse(open.clockIn));
    document.getElementById('todayTotal').textContent = fmtDur(entries.reduce((s, e) => s + overlapMs(e, startOfDay(new Date()).getTime()), 0));
    document.getElementById('weekTotal').textContent = fmtDur(entries.reduce((s, e) => s + overlapMs(e, startOfWeek().getTime()), 0));
  }
  document.querySelectorAll('.dur.live').forEach((d) => { d.textContent = fmtDur(Date.now() - Date.parse(d.dataset.since)); });
}

function installBanner() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  if (state.installPrompt) {
    return `<div class="install">Put Mint Concrete on your home screen for one-tap access.<button class="btn ghost" type="button" id="installBtn">Install</button></div>`;
  }
  if (/iphone|ipad/i.test(navigator.userAgent)) {
    return `<div class="install">On iPhone: tap Share, then “Add to Home Screen” to install this app.</div>`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Crew chat

async function loadChat() {
  try {
    const { messages } = await api.get('/api/chat/messages?limit=100');
    state.chat.messages = messages;
    state.chat.lastId = messages.length ? messages[messages.length - 1].id : 0;
    state.chat.hasMore = messages.length === 100;
    state.chat.loaded = true;
    renderMessages();
    scrollToBottom(true);
  } catch (err) {
    if (err.status === 401) return sessionLost();
    toast(err.message, 'error');
  }
}

async function loadOlder() {
  const first = state.chat.messages[0];
  if (!first) return;
  const box = document.getElementById('messages');
  const before = box.scrollHeight - box.scrollTop;
  const { messages } = await api.get(`/api/chat/messages?before=${first.id}&limit=100`);
  state.chat.hasMore = messages.length === 100;
  state.chat.messages = [...messages, ...state.chat.messages];
  renderMessages();
  box.scrollTop = box.scrollHeight - before;
}

function messageHtml(m, prev) {
  const mine = m.userId === state.user.id;
  const same = prev && prev.userId === m.userId && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60000
    && startOfDay(new Date(prev.createdAt)).getTime() === startOfDay(new Date(m.createdAt)).getTime();
  const daySep = !prev || startOfDay(new Date(prev.createdAt)).getTime() !== startOfDay(new Date(m.createdAt)).getTime();
  return `${daySep ? `<div class="day">${fmtDay(m.createdAt)}</div>` : ''}
    <div class="msg ${mine ? 'me' : ''} ${same ? 'same' : ''}" data-id="${m.id}">
      <div class="who">${mine ? 'You' : esc(m.displayName)}</div>
      <div class="bubble">${linkify(esc(m.body))}</div>
      <div class="time">${fmtTime(m.createdAt)}</div>
    </div>`;
}

function linkify(html) {
  return html.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function renderMessages() {
  const box = document.getElementById('messages');
  if (!box) return;
  const { messages, hasMore } = state.chat;
  box.innerHTML = (hasMore && messages.length ? '<button class="btn ghost" type="button" id="olderBtn" style="align-self:center">Load earlier messages</button>' : '')
    + (messages.length ? messages.map((m, i) => messageHtml(m, messages[i - 1])).join('') : '<div class="empty">No messages yet. Say hi to the crew 👋</div>')
    + '<button class="newer" id="newerBtn" type="button" hidden>New messages ↓</button>';
  const ob = document.getElementById('olderBtn');
  if (ob) ob.onclick = () => { ob.disabled = true; loadOlder().catch((e) => toast(e.message, 'error')); };
  document.getElementById('newerBtn').onclick = () => scrollToBottom(true);
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 120; }
function scrollToBottom(force) {
  const box = document.getElementById('messages');
  if (!box) return;
  if (force || nearBottom(box)) {
    box.scrollTop = box.scrollHeight;
    const nb = document.getElementById('newerBtn'); if (nb) nb.hidden = true;
  }
}

function appendMessage(m) {
  if (m.id <= state.chat.lastId) return;
  const box = document.getElementById('messages');
  const stick = box ? nearBottom(box) : true;
  const prev = state.chat.messages[state.chat.messages.length - 1];
  state.chat.messages.push(m);
  state.chat.lastId = m.id;
  const mine = m.userId === state.user.id;
  if (box) {
    if (!prev) renderMessages();
    else document.getElementById('newerBtn').insertAdjacentHTML('beforebegin', messageHtml(m, prev));
    if (stick || mine || !prev) scrollToBottom(true);
    else document.getElementById('newerBtn').hidden = false;
  }
  if (state.tab !== 'chat' && !mine) { state.chat.unread += 1; updateBadge(); }
}

function setupComposer() {
  const form = document.getElementById('composer');
  const input = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  const touch = matchMedia('(pointer: coarse)').matches;
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; btn.disabled = !input.value.trim(); };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); form.requestSubmit(); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    btn.disabled = true;
    try {
      const { message } = await api.post('/api/chat/messages', { body });
      input.value = ''; grow();
      appendMessage(message);
    } catch (err) {
      if (err.status === 401) return sessionLost();
      toast(err.message, 'error'); btn.disabled = false;
    }
    input.focus();
  };
}

// Live updates: Server-Sent Events, with polling as a fallback.
function startStream() {
  if (!state.user || !('EventSource' in window)) return startPolling();
  stopLive();
  const es = new EventSource('/api/chat/stream');
  state.stream = es;
  es.addEventListener('hello', catchUp);
  es.addEventListener('message', (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener('clock', (e) => {
    const d = JSON.parse(e.data);
    if (d.userId !== state.user.id) toast(`${d.displayName} clocked ${d.action}`);
    loadClock();
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { state.stream = null; startPolling(); }
  };
}

function startPolling() {
  clearInterval(state.timers.poll);
  state.timers.poll = setInterval(() => { if (document.visibilityState === 'visible') catchUp(); }, 8000);
}

async function catchUp() {
  if (!state.user || !state.chat.loaded) return;
  try {
    const { messages } = await api.get(`/api/chat/messages?after=${state.chat.lastId}&limit=200`);
    messages.forEach(appendMessage);
  } catch (err) {
    if (err.status === 401) sessionLost();
  }
}

function stopLive() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  clearInterval(state.timers.poll);
  clearInterval(state.timers.tick);
}

function sessionLost() {
  stopLive();
  api.setToken(null);
  state.user = null;
  toast('Your session ended. Please log in again.', 'error');
  renderAuth();
}

boot();
