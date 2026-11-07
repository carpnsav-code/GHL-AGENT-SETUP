// SQLite persistence for the Mint Concrete crew app.
// Uses the Node 22 built-in `node:sqlite` module — no native dependencies to install.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'crew',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    user_agent   TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS time_entries (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clock_in  TEXT NOT NULL,
    clock_out TEXT,
    note      TEXT
  );
  CREATE INDEX IF NOT EXISTS time_entries_user ON time_entries(user_id, clock_in);
  -- Only one open shift per person.
  CREATE UNIQUE INDEX IF NOT EXISTS time_entries_open
    ON time_entries(user_id) WHERE clock_out IS NULL;

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
`;

/**
 * Open (and create, if needed) the database at `file`.
 * Pass ':memory:' for an ephemeral database (used by the tests).
 */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Users

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null;
}

export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function createUser(db, { username, displayName, passwordHash, role }) {
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName, passwordHash, role, now());
  return findUserById(db, Number(info.lastInsertRowid));
}

export function listUsers(db) {
  return db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY display_name').all();
}

/** Shape of a user that is safe to send to the browser. */
export function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
}

// ---------------------------------------------------------------------------
// Sessions

export function insertSession(db, { tokenHash, userId, expiresAt, userAgent }) {
  const t = now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(tokenHash, userId, t, t, expiresAt, userAgent ?? null);
}

export function findSession(db, tokenHash) {
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) ?? null;
}

export function touchSession(db, id, expiresAt) {
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now(), expiresAt, id);
}

export function deleteSession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

// ---------------------------------------------------------------------------
// Time clock

export function openEntryFor(db, userId) {
  return db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(userId) ?? null;
}

export function clockIn(db, userId, note) {
  const info = db
    .prepare('INSERT INTO time_entries (user_id, clock_in, note) VALUES (?, ?, ?)')
    .run(userId, now(), note || null);
  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function clockOut(db, entryId, note) {
  if (note) {
    db.prepare(
      "UPDATE time_entries SET clock_out = ?, note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' — ' || ? END WHERE id = ?",
    ).run(now(), note, note, entryId);
  } else {
    db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), entryId);
  }
  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entryId);
}

export function listEntries(db, userId, limit = 100) {
  return db
    .prepare('SELECT * FROM time_entries WHERE user_id = ? ORDER BY clock_in DESC LIMIT ?')
    .all(userId, limit);
}

/** Everyone currently clocked in, for the "on the clock" roster. */
export function listOnClock(db) {
  return db
    .prepare(
      `SELECT t.id, t.user_id, t.clock_in, t.note, u.display_name, u.username
         FROM time_entries t JOIN users u ON u.id = t.user_id
        WHERE t.clock_out IS NULL
        ORDER BY t.clock_in`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Group chat

export function insertMessage(db, userId, body) {
  const info = db
    .prepare('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, ?)')
    .run(userId, body, now());
  return getMessage(db, Number(info.lastInsertRowid));
}

export function getMessage(db, id) {
  return db
    .prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, u.display_name, u.username
         FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    )
    .get(id);
}

/**
 * Messages newer than `afterId` (ascending), or the latest `limit` messages
 * when `afterId` is omitted.
 */
export function listMessages(db, { afterId = null, beforeId = null, limit = 100 } = {}) {
  const base = `SELECT m.id, m.user_id, m.body, m.created_at, u.display_name, u.username
                  FROM messages m JOIN users u ON u.id = m.user_id`;
  if (afterId != null) {
    return db.prepare(`${base} WHERE m.id > ? ORDER BY m.id ASC LIMIT ?`).all(afterId, limit);
  }
  if (beforeId != null) {
    return db.prepare(`${base} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`).all(beforeId, limit).reverse();
  }
  return db.prepare(`${base} ORDER BY m.id DESC LIMIT ?`).all(limit).reverse();
}
