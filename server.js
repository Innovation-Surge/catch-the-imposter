'use strict';

/*
 * Imposter — real-time party word game.
 * Zero dependencies: plain Node.js http server.
 *   - Live updates:  GET  /events?code=..&token=..   (Server-Sent Events)
 *   - Actions:       POST /api/create | /api/join | /api/action   (JSON)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 4;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // idle rooms are removed after 6 hours
const PUBLIC_DIR = path.join(__dirname, 'public');

const rooms = new Map();

/* ---------------- helpers ---------------- */

const token = () => crypto.randomBytes(16).toString('hex');
const shortId = () => crypto.randomBytes(5).toString('hex');

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  while (rooms.has(code));
  return code;
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Normalise for comparison: case-, space-, punctuation- and accent-insensitive.
// Keeps letters, combining marks (needed for Bangla etc.) and digits.
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GameError extends Error {}
const fail = (msg) => {
  throw new GameError(msg);
};

/* ---------------- game model ---------------- */

function createRoom() {
  const room = {
    code: newCode(),
    modToken: token(),
    topic: '',
    word: '',
    players: [], // { id, token, name }
    conns: new Map(), // connId -> { res, role, pid }
    gameNo: 0,
    touched: Date.now(),
  };
  resetGame(room);
  rooms.set(room.code, room);
  return room;
}

function resetGame(room) {
  Object.assign(room, {
    phase: 'lobby', // lobby | clues | voting | tiebreak | guess | review | ended
    round: 0,
    word: '',
    imposterId: null,
    order: [],
    turn: 0,
    clues: [], // { round, playerId, text, skipped }
    votes: {}, // voterId -> targetId | 'skip'
    candidates: null, // restricted list during a final-round re-vote
    revoted: false,
    tallies: [],
    accusedId: null,
    tieCandidates: [],
    guess: null,
    result: null,
  });
}

function startGame(room) {
  if (room.phase !== 'lobby') fail('The game has already started.');
  if (!room.topic || !room.word) fail('Set the topic and the secret name first.');
  const n = room.players.length;
  if (n < MIN_PLAYERS) fail(`Need at least ${MIN_PLAYERS} players (currently ${n}).`);
  if (n > MAX_PLAYERS) fail(`At most ${MAX_PLAYERS} players allowed.`);
  room.gameNo++;
  room.imposterId = room.players[crypto.randomInt(n)].id;
  room.order = shuffle(room.players.map((p) => p.id));
  beginRound(room, 1);
}

function beginRound(room, r) {
  room.round = r;
  room.phase = 'clues';
  room.turn = 0;
  if (r > 1) room.order.push(room.order.shift()); // rotate who starts each round
  room.votes = {};
  room.candidates = null;
  room.revoted = false;
}

function advanceTurn(room) {
  room.turn++;
  if (room.turn >= room.order.length) {
    room.phase = 'voting';
    room.votes = {};
  }
}

function submitClue(room, pid, text) {
  if (room.phase !== 'clues') fail('It is not the clue phase.');
  if (room.order[room.turn] !== pid) fail("It's not your turn.");
  const clue = clean(text, 40);
  if (!clue) fail('Type a clue first.');
  if (pid !== room.imposterId) {
    // Never reject the imposter's clue — that would leak the word to them.
    const w = norm(room.word);
    if (w.length >= 3 && norm(clue).includes(w)) fail("Your clue can't contain the secret name.");
  }
  room.clues.push({ round: room.round, playerId: pid, text: clue });
  advanceTurn(room);
}

function skipTurn(room) {
  if (room.phase !== 'clues') fail('It is not the clue phase.');
  room.clues.push({ round: room.round, playerId: room.order[room.turn], text: null, skipped: true });
  advanceTurn(room);
}

function castVote(room, pid, target) {
  if (room.phase !== 'voting') fail('Voting is not open.');
  if (target === 'skip') {
    if (room.round >= MAX_ROUNDS) fail('Final round — you must pick someone.');
  } else {
    if (target === pid) fail("You can't vote for yourself.");
    const pool = room.candidates ?? room.players.map((p) => p.id);
    if (!pool.includes(target)) fail('That player is not a valid choice.');
  }
  room.votes[pid] = target;
  if (room.players.every((p) => p.id in room.votes)) resolveVotes(room);
}

function resolveVotes(room) {
  const counts = {};
  let abstain = 0;
  for (const p of room.players) {
    const t = room.votes[p.id];
    if (!t || t === 'skip') abstain++;
    else counts[t] = (counts[t] || 0) + 1;
  }
  const total = room.players.length;
  const top = Math.max(0, ...Object.values(counts));
  const leaders = top ? Object.keys(counts).filter((k) => counts[k] === top) : [];
  const finalRound = room.round >= MAX_ROUNDS;
  const entry = { round: room.round, revote: !!room.candidates, counts, abstain, outcome: '', accusedId: null };
  room.tallies.push(entry);

  if (!finalRound) {
    // Rounds 1-3: a strict majority of all players is needed to accuse someone.
    if (top > total / 2) {
      entry.outcome = 'accused';
      entry.accusedId = leaders[0];
      return accuse(room, leaders[0]);
    }
    entry.outcome = 'no-majority';
    return beginRound(room, room.round + 1);
  }

  // Final round: players must decide. Most votes wins.
  if (leaders.length === 1) {
    entry.outcome = 'accused';
    entry.accusedId = leaders[0];
    return accuse(room, leaders[0]);
  }
  if (!room.revoted) {
    // Tie: one re-vote among the tied players.
    entry.outcome = 'tie-revote';
    room.revoted = true;
    room.candidates = leaders.length ? leaders : room.players.map((p) => p.id);
    room.votes = {};
    return;
  }
  // Still tied after re-vote: moderator breaks the tie among the tied players.
  entry.outcome = 'tie-moderator';
  room.tieCandidates = leaders.length ? leaders : room.candidates ?? room.players.map((p) => p.id);
  room.phase = 'tiebreak';
}

function tiebreak(room, id) {
  if (room.phase !== 'tiebreak') fail('There is no tie to break.');
  if (!room.tieCandidates.includes(id)) fail('Pick one of the tied players.');
  room.tallies[room.tallies.length - 1].accusedId = id;
  accuse(room, id);
}

function accuse(room, id) {
  room.accusedId = id;
  if (id !== room.imposterId) return endGame(room, 'imposter', 'wrong-accusation');
  room.phase = 'guess'; // imposter caught — gets a chance to name the word
}

function submitGuess(room, pid, text) {
  if (room.phase !== 'guess') fail('Not the guessing phase.');
  if (pid !== room.imposterId) fail('Only the imposter can guess.');
  const g = clean(text, 60);
  if (!g) fail('Type your guess first.');
  room.guess = g;
  if (norm(g) === norm(room.word)) return endGame(room, 'imposter', 'guessed-word');
  room.phase = 'review'; // not an exact match — moderator rules on spelling / near-misses
}

function endGame(room, winner, reason) {
  room.phase = 'ended';
  room.result = { winner, reason };
}

/* ---------------- views ---------------- */

const isOnline = (room, pid) => [...room.conns.values()].some((c) => c.pid === pid);

function viewFor(room, role, pid) {
  const isMod = role === 'mod';
  const me = isMod ? null : room.players.find((p) => p.id === pid);
  const started = room.phase !== 'lobby';
  const ended = room.phase === 'ended';
  const isImposter = !!me && started && me.id === room.imposterId;
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    gameNo: room.gameNo,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS, rounds: MAX_ROUNDS },
    you: isMod ? { role: 'mod' } : { role: 'player', id: me.id, name: me.name, isImposter },
    topic: isMod || started ? room.topic : null,
    word: isMod || ended || (started && !isImposter) ? room.word : null,
    imposterId: (isMod && started) || ended ? room.imposterId : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(room, p.id) })),
    modOnline: [...room.conns.values()].some((c) => c.role === 'mod'),
    order: room.order,
    turnId: room.phase === 'clues' ? room.order[room.turn] : null,
    clues: room.clues,
    voted: Object.keys(room.votes),
    myVote: me ? room.votes[me.id] ?? null : null,
    votes: isMod ? room.votes : null,
    candidates: room.candidates,
    tallies: room.tallies,
    accusedId: room.accusedId,
    tieCandidates: room.tieCandidates,
    guess: isMod || ended || isImposter ? room.guess : null,
    result: room.result,
  };
}

/* ---------------- live updates (SSE) ---------------- */

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.conns.values()) {
    if (c.role === 'player' && !room.players.some((p) => p.id === c.pid)) continue;
    sse(c.res, 'state', viewFor(room, c.role, c.pid));
  }
}

function dropConns(room, predicate, message) {
  for (const [id, c] of room.conns) {
    if (!predicate(c)) continue;
    sse(c.res, 'kicked', { message });
    c.res.end();
    room.conns.delete(id);
  }
}

function identify(room, t) {
  if (!room || !t) return null;
  if (t === room.modToken) return { role: 'mod' };
  const p = room.players.find((x) => x.token === t);
  return p ? { role: 'player', pid: p.id, player: p } : null;
}

function openEvents(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });
  res.write('retry: 2000\n\n');
  const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
  const who = identify(room, url.searchParams.get('token'));
  if (!who) {
    sse(res, 'kicked', { message: room ? 'You are no longer in this room.' : 'That room no longer exists.' });
    return res.end();
  }
  const connId = shortId();
  room.conns.set(connId, { res, role: who.role, pid: who.pid });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    if (room.conns.delete(connId)) broadcast(room);
  });
  broadcast(room);
}

/* ---------------- actions ---------------- */

function handleAction(room, who, type, a) {
  const isMod = who.role === 'mod';
  const player = who.player || null;
  const modOnly = () => !isMod && fail('Only the moderator can do that.');
  const playerOnly = () => !player && fail('Only players can do that.');

  switch (type) {
    case 'setSecret': {
      modOnly();
      if (room.phase !== 'lobby') fail('The secret cannot change after the game starts.');
      const topic = clean(a.topic, 40);
      const word = clean(a.word, 60);
      if (!topic || !word) fail('Both the topic and the secret name are required.');
      room.topic = topic;
      room.word = word;
      break;
    }
    case 'kick': {
      modOnly();
      if (room.phase !== 'lobby') fail('Players are locked while a game is running.');
      const p = room.players.find((x) => x.id === a.id);
      if (!p) fail('Player not found.');
      room.players = room.players.filter((x) => x !== p);
      dropConns(room, (c) => c.pid === p.id, 'The moderator removed you from the room.');
      break;
    }
    case 'start':
      modOnly();
      startGame(room);
      break;
    case 'clue':
      playerOnly();
      submitClue(room, player.id, a.text);
      break;
    case 'skipTurn':
      modOnly();
      skipTurn(room);
      break;
    case 'vote':
      playerOnly();
      castVote(room, player.id, a.target);
      break;
    case 'closeVoting':
      modOnly();
      if (room.phase !== 'voting') fail('Voting is not open.');
      resolveVotes(room);
      break;
    case 'tiebreak':
      modOnly();
      tiebreak(room, a.target);
      break;
    case 'guess':
      playerOnly();
      submitGuess(room, player.id, a.text);
      break;
    case 'pass':
      playerOnly();
      if (room.phase !== 'guess' || player.id !== room.imposterId) fail('Nothing to pass on.');
      endGame(room, 'players', 'imposter-passed');
      break;
    case 'review':
      modOnly();
      if (room.phase !== 'review') fail('No guess to review.');
      endGame(room, a.accept ? 'imposter' : 'players', a.accept ? 'guessed-word' : 'wrong-guess');
      break;
    case 'newGame':
      modOnly();
      resetGame(room);
      break;
    case 'leave':
      playerOnly();
      if (room.phase !== 'lobby') fail("You can't leave while a game is running.");
      room.players = room.players.filter((x) => x !== player);
      dropConns(room, (c) => c.pid === player.id, 'You left the room.');
      break;
    case 'closeRoom':
      modOnly();
      dropConns(room, () => true, 'The moderator closed the room.');
      rooms.delete(room.code);
      return;
    default:
      fail('Unknown action.');
  }
  broadcast(room);
}

function api(route, body) {
  if (route === 'create') {
    const room = createRoom();
    return { code: room.code, token: room.modToken };
  }
  if (route === 'join') {
    const room = rooms.get(clean(body.code, 8).toUpperCase());
    if (!room) fail('Room not found — check the code.');
    if (room.phase !== 'lobby') fail('This game has already started. The room is locked.');
    const nm = clean(body.name, 20);
    if (!nm) fail('Enter your name.');
    if (room.players.length >= MAX_PLAYERS) fail(`The room is full (${MAX_PLAYERS} players max).`);
    if (room.players.some((p) => p.name.toLowerCase() === nm.toLowerCase())) fail('That name is already taken in this room.');
    const p = { id: shortId(), token: token(), name: nm };
    room.players.push(p);
    broadcast(room);
    return { code: room.code, token: p.token };
  }
  if (route === 'action') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    const who = identify(room, body.token);
    if (!who) fail('Your session has expired — please rejoin.');
    const { type, ...a } = body;
    handleAction(room, who, type, a);
    return {};
  }
  fail('Not found.');
}

/* ---------------- http ---------------- */

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
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain' });
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
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && url.pathname === '/events') return openEvents(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...api(url.pathname.slice(5), body) });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    if (!res.headersSent) send(res, 200, { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_TTL_MS) {
      dropConns(room, () => true, 'This room expired.');
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Imposter game running on http://localhost:${PORT}`));

module.exports = { server };
