// Mint Concrete crew app — HTTP entry point.
//
//   npm run app            # serves on http://localhost:3000
//   PORT=8080 npm run app
//
// Serves the web app from app/public and the JSON API from app/api.js.
// Data lives in a single SQLite file (data/mint-concrete.sqlite by default).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, purgeExpiredSessions } from './db.js';
import { createApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_DB = path.join(__dirname, '..', 'data', 'mint-concrete.sqlite');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = path.extname(file);
  const isShell = ext === '.html' || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': isShell ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/**
 * Build the HTTP server. Options override environment variables so tests can
 * run against an in-memory database without touching the real one.
 */
export function createServer(options = {}) {
  const dbFile = options.dbFile ?? process.env.MC_DB_FILE ?? DEFAULT_DB;
  const db = openDatabase(dbFile);
  purgeExpiredSessions(db);
  const api = createApi(db, {
    joinCode: options.joinCode ?? process.env.MC_JOIN_CODE ?? '',
    requireLocation: options.requireLocation ?? process.env.MC_REQUIRE_LOCATION !== '0',
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api.handle(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  server.shutdown = () =>
    new Promise((resolve) => {
      api.close();
      server.close(() => {
        db.close();
        resolve();
      });
    });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Mint Concrete app running at http://localhost:${port}`);
    console.log(`Database: ${process.env.MC_DB_FILE ?? DEFAULT_DB}`);
    if (!process.env.MC_JOIN_CODE) {
      console.log('Tip: set MC_JOIN_CODE so only your crew can create accounts.');
    }
  });
  const stop = () => server.shutdown().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
