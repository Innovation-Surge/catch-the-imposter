'use strict';

/*
 * Imposter — game rules + JSON API, independent of where rooms are stored.
 *
 * Used by both runtimes:
 *   - server.js                 (plain Node, in-memory store)
 *   - netlify/functions/api.mjs (Netlify Function, Netlify Blobs store)
 *
 * A store is any object with:
 *   load(code)               -> { room, etag } | null
 *   save(code, room, etag)   -> true if written (etag null = only if the code is new)
 *   loadSeen(code)           -> { [viewerKey]: timestamp }
 *   saveSeen(code, seen)
 *
 * Clients poll POST /api/state; every write goes through an optimistic
 * compare-and-swap so simultaneous votes/clues never overwrite each other.
 */

const crypto = require('crypto');

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const ROUND_CHOICES = [3, 4]; // the moderator picks how many rounds a game has
const MODES = ['app', 'inperson']; // clues typed in the app, or spoken aloud in the same room
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // idle rooms are dropped after 6 hours

/* ---------------- helpers ---------------- */

const token = () => crypto.randomBytes(16).toString('hex');
const shortId = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
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

function createRoom(code) {
  const room = {
    code,
    modToken: token(),
    topic: '',
    word: '',
    players: [], // { id, token, name }
    gone: {}, // token -> message, for players who were removed or left
    closed: false,
    mode: 'app',
    maxRounds: 4,
    gameNo: 0,
    version: 0,
    touched: Date.now(),
  };
  resetGame(room);
  return room;
}

function resetGame(room) {
  Object.assign(room, {
    phase: 'lobby', // lobby | clues (app) or discuss (in person) | voting | tiebreak | guess | review | ended
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
  // In person, clues are spoken aloud; the moderator opens voting when the table is ready.
  room.phase = room.mode === 'inperson' ? 'discuss' : 'clues';
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

const isFinalRound = (room) => room.round >= room.maxRounds;

function openVoting(room) {
  if (room.phase !== 'discuss') fail('Voting can only be opened after the clues.');
  room.phase = 'voting';
  room.votes = {};
}

// Moderator moves on without accusing anyone (not allowed in the final round).
function skipVoting(room) {
  if (room.phase !== 'discuss' && room.phase !== 'voting') fail('There is no vote to skip.');
  if (room.candidates) fail('A re-vote is in progress — it must be decided.');
  if (isFinalRound(room)) fail('Final round — players must vote.');
  room.tallies.push({ round: room.round, revote: false, counts: {}, abstain: 0, outcome: 'skipped', accusedId: null });
  beginRound(room, room.round + 1);
}

function castVote(room, pid, target) {
  if (room.phase !== 'voting') fail('Voting is not open.');
  if (target === 'skip') {
    if (room.mode === 'inperson') fail('Only the moderator can skip the voting.');
    if (isFinalRound(room)) fail('Final round — you must pick someone.');
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
  const finalRound = isFinalRound(room);
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
  // Imposter caught — gets a chance to name the word. In person they say it out
  // loud and the moderator rules on it directly; in the app they type it first.
  room.phase = room.mode === 'inperson' ? 'review' : 'guess';
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

function removePlayer(room, p, message) {
  room.players = room.players.filter((x) => x !== p);
  room.gone[p.token] = message;
}

/* ---------------- views ---------------- */

function viewFor(room, role, pid, isOnline) {
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
    mode: room.mode,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS, rounds: room.maxRounds, roundChoices: ROUND_CHOICES },
    you: isMod ? { role: 'mod' } : { role: 'player', id: me.id, name: me.name, isImposter },
    topic: isMod || started ? room.topic : null,
    word: isMod || ended || (started && !isImposter) ? room.word : null,
    imposterId: (isMod && started) || ended ? room.imposterId : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) })),
    modOnline: isOnline('mod'),
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

/* ---------------- actions ---------------- */

function identify(room, t) {
  if (!room || !t) return null;
  if (t === room.modToken) return { role: 'mod', key: 'mod' };
  const p = room.players.find((x) => x.token === t);
  return p ? { role: 'player', pid: p.id, key: p.id, player: p } : null;
}

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
    case 'setOptions': {
      modOnly();
      if (room.phase !== 'lobby') fail('Options cannot change after the game starts.');
      if (a.mode !== undefined) {
        if (!MODES.includes(a.mode)) fail('Unknown clue mode.');
        room.mode = a.mode;
      }
      if (a.rounds !== undefined) {
        if (!ROUND_CHOICES.includes(Number(a.rounds))) fail(`Rounds must be ${ROUND_CHOICES.join(' or ')}.`);
        room.maxRounds = Number(a.rounds);
      }
      break;
    }
    case 'kick': {
      modOnly();
      if (room.phase !== 'lobby') fail('Players are locked while a game is running.');
      const p = room.players.find((x) => x.id === a.id);
      if (!p) fail('Player not found.');
      removePlayer(room, p, 'The moderator removed you from the room.');
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
    case 'openVoting':
      modOnly();
      openVoting(room);
      break;
    case 'skipVoting':
      modOnly();
      skipVoting(room);
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
      removePlayer(room, player, 'You left the room.');
      break;
    case 'closeRoom':
      modOnly();
      room.closed = true;
      break;
    default:
      fail('Unknown action.');
  }
}

/* ---------------- API over a store ---------------- */

function createApi(store, opts = {}) {
  const onlineMs = opts.onlineMs ?? 15000; // a viewer counts as online if it polled this recently
  const touchMs = opts.touchMs ?? 5000; // how often a viewer's "last seen" is written

  const roomCode = (c) => clean(c, 8).toUpperCase();

  async function loadLive(code) {
    const cur = code && (await store.load(code));
    if (!cur || cur.room.closed || Date.now() - cur.room.touched > ROOM_TTL_MS) return null;
    return cur;
  }

  // Read-modify-write with compare-and-swap; retries when another request won the race.
  async function mutate(code, fn) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const cur = await loadLive(code);
      if (!cur) fail('That room no longer exists.');
      const out = fn(cur.room);
      cur.room.version++;
      cur.room.touched = Date.now();
      if (await store.save(code, cur.room, cur.etag)) return out;
      await sleep(15 + Math.random() * 60 * (attempt + 1));
    }
    fail('The server is busy — please try again.');
  }

  async function create() {
    for (let i = 0; i < 10; i++) {
      const room = createRoom(newCode());
      if (await store.save(room.code, room, null)) return { code: room.code, token: room.modToken };
    }
    fail('Could not create a room — please try again.');
  }

  async function join(body) {
    const code = roomCode(body.code);
    const nm = clean(body.name, 20);
    return mutate(code, (room) => {
      if (room.phase !== 'lobby') fail('This game has already started. The room is locked.');
      if (!nm) fail('Enter your name.');
      if (room.players.length >= MAX_PLAYERS) fail(`The room is full (${MAX_PLAYERS} players max).`);
      if (room.players.some((p) => p.name.toLowerCase() === nm.toLowerCase())) fail('That name is already taken in this room.');
      const p = { id: shortId(), token: token(), name: nm };
      room.players.push(p);
      return { code: room.code, token: p.token };
    });
  }

  async function action(body) {
    const code = roomCode(body.code);
    const { type, code: _c, token: t, ...a } = body;
    await mutate(code, (room) => {
      const who = identify(room, t);
      if (!who) fail('Your session has expired — please rejoin.');
      handleAction(room, who, type, a);
    });
    return {};
  }

  async function state(body) {
    const code = roomCode(body.code);
    const raw = code && (await store.load(code));
    if (!raw) return { ok: false, kicked: 'That room no longer exists.' };
    const room = raw.room;
    if (room.closed) return { ok: false, kicked: 'The moderator closed the room.' };
    if (Date.now() - room.touched > ROOM_TTL_MS) return { ok: false, kicked: 'This room expired.' };
    const who = identify(room, body.token);
    if (!who) return { ok: false, kicked: room.gone?.[body.token] || 'You are no longer in this room.' };

    const now = Date.now();
    const seen = (await store.loadSeen(code)) || {};
    if (!(now - (seen[who.key] || 0) < touchMs)) {
      seen[who.key] = now;
      await store.saveSeen(code, seen);
    }
    const isOnline = (key) => now - (seen[key] || 0) < onlineMs;
    return { state: viewFor(room, who.role, who.pid, isOnline) };
  }

  const routes = { create, join, action, state };

  // Returns the JSON response body for POST /api/<route>.
  return async function api(route, body) {
    try {
      const fn = routes[route];
      if (!fn) fail('Not found.');
      return { ok: true, ...(await fn(body || {})) };
    } catch (e) {
      if (!(e instanceof GameError)) console.error(e);
      return { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong.' };
    }
  };
}

/* ---------------- in-memory store (single Node process) ---------------- */

function memoryStore() {
  const rooms = new Map(); // code -> { json, etag }
  const seen = new Map();
  let n = 0;
  setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      if (now - JSON.parse(r.json).touched > ROOM_TTL_MS) {
        rooms.delete(code);
        seen.delete(code);
      }
    }
  }, 10 * 60 * 1000).unref();
  return {
    size: () => rooms.size,
    async load(code) {
      const r = rooms.get(code);
      return r ? { room: JSON.parse(r.json), etag: r.etag } : null;
    },
    async save(code, room, etag) {
      const r = rooms.get(code);
      if (etag === null ? r : !r || r.etag !== etag) return false;
      rooms.set(code, { json: JSON.stringify(room), etag: String(++n) });
      return true;
    },
    async loadSeen(code) {
      return { ...seen.get(code) };
    },
    async saveSeen(code, s) {
      seen.set(code, { ...s });
    },
  };
}

module.exports = { createApi, memoryStore, GameError };
