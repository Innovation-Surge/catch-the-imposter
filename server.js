'use strict';

/*
 * Imposter — local / VPS server. Game logic lives in lib/game.js;
 * this file only serves public/ and the JSON API from memory.
 *   - Actions & live state:  POST /api/create | /api/join | /api/action | /api/state
 * On Netlify the same API runs as a function instead (netlify/functions/api.mjs).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApi, memoryStore, GameError } = require('./lib/game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = memoryStore();
const api = createApi(store, {
  onlineMs: Number(process.env.ONLINE_MS) || undefined,
  touchMs: Number(process.env.TOUCH_MS) || undefined,
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function send(res, status, body) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store' });
  res.end(json ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(new GameError('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new GameError('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, rooms: store.size() });
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);
      return send(res, 200, await api(url.pathname.slice(5), body));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    if (!res.headersSent) send(res, 200, { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong.' });
  }
});

server.listen(PORT, () => console.log(`Imposter game running on http://localhost:${PORT}`));

module.exports = { server };
