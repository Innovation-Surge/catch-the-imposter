'use strict';
// End-to-end simulation: starts the server on a random port and plays full games
// with fake players over the real HTTP polling interface.
//   node test/simulate.js
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

// Minimal polling client (same as the browser) that keeps the latest state and records 'kicked'.
function listen(session) {
  const client = { state: null, kicked: null, ctrl: { abort: () => (client.stopped = true) } };
  (async () => {
    while (!client.stopped) {
      const r = await post('state', session).catch(() => ({}));
      if (client.stopped) break;
      if (r.ok) client.state = r.state;
      else if (r.kicked) {
        client.kicked = { message: r.kicked };
        break;
      }
      await sleep(25);
    }
  })();
  return client;
}

async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for: ' + label);
}

async function setup(n, word = 'Mango') {
  const mod = await post('create');
  assert(mod.ok);
  const m = { session: { code: mod.code, token: mod.token } };
  m.sse = listen(m.session);
  m.act = (type, extra) => post('action', { ...m.session, type, ...extra });
  const players = [];
  for (let i = 0; i < n; i++) {
    const j = await post('join', { code: mod.code.toLowerCase(), name: `P${i + 1}` });
    assert(j.ok, j.error);
    const p = { name: `P${i + 1}`, session: { code: j.code, token: j.token } };
    p.sse = listen(p.session);
    p.act = (type, extra) => post('action', { ...p.session, type, ...extra });
    players.push(p);
  }
  await until(() => m.sse.state?.players.length === n && players.every((p) => p.sse.state), 'lobby sync');
  assert((await m.act('setSecret', { topic: 'Fruit', word })).ok);
  return { m, players };
}

async function startAndMap(ctx) {
  const r = await ctx.m.act('start');
  assert(r.ok, r.error);
  await until(() => ctx.m.sse.state?.phase === 'clues' && ctx.players.every((p) => p.sse.state?.phase === 'clues'), 'game start');
  for (const p of ctx.players) p.id = p.sse.state.you.id;
  ctx.byId = Object.fromEntries(ctx.players.map((p) => [p.id, p]));
  ctx.imp = ctx.players.find((p) => p.sse.state.you.isImposter);
  ctx.crew = ctx.players.filter((p) => p !== ctx.imp);
  return ctx;
}

async function giveClues(ctx) {
  const st = () => ctx.m.sse.state;
  const round = st().round;
  while (st().phase === 'clues' && st().round === round) {
    const p = ctx.byId[st().turnId];
    const r = await p.act('clue', { text: `clue-${p.name}-r${round}` });
    assert(r.ok, r.error);
    await until(() => st().turnId !== p.id || st().phase !== 'clues', 'turn advance');
  }
}

async function voteAll(ctx, choose) {
  const before = ctx.m.sse.state.tallies.length;
  for (const p of ctx.players) {
    const r = await p.act('vote', { target: choose(p) });
    assert(r.ok, `${p.name}: ${r.error}`);
  }
  await until(() => ctx.m.sse.state.tallies.length > before, 'tally');
  return ctx.m.sse.state;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.stack]);
  }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, ONLINE_MS: '400', TOUCH_MS: '50' }, stdio: 'inherit' });
  await until(async () => true, 'boot');
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/health');
      break;
    } catch {
      await sleep(100);
    }
  }

  await test('player limits, lock, secrecy of word and imposter', async () => {
    const { m, players } = await setup(3);
    let r = await m.act('start');
    assert(!r.ok && /at least 4/.test(r.error), 'should refuse with 3 players');
    const ctx = { m, players };
    r = await post('join', { code: m.session.code, name: 'p1' });
    assert(!r.ok && /taken/.test(r.error), 'duplicate name refused');
    for (let i = 4; i <= 10; i++) {
      const j = await post('join', { code: m.session.code, name: `X${i}` });
      assert(j.ok, j.error);
      const p = { name: `X${i}`, session: { code: j.code, token: j.token } };
      p.sse = listen(p.session);
      p.act = (type, extra) => post('action', { ...p.session, type, ...extra });
      players.push(p);
    }
    r = await post('join', { code: m.session.code, name: 'Eleventh' });
    assert(!r.ok && /full/.test(r.error), '11th player must be refused');
    await until(() => players.every((p) => p.sse.state), 'all 10 connected');
    await startAndMap(ctx);
    r = await post('join', { code: m.session.code, name: 'Late' });
    assert(!r.ok && /locked/.test(r.error), 'room must lock after start');
    assert.strictEqual(ctx.imp.sse.state.word, null, 'imposter must not see the word');
    assert.strictEqual(ctx.imp.sse.state.topic, 'Fruit', 'imposter sees the topic');
    for (const p of ctx.crew) {
      assert.strictEqual(p.sse.state.word, 'Mango');
      assert.strictEqual(p.sse.state.imposterId, null, 'players must not see who the imposter is');
    }
    assert.strictEqual(m.sse.state.imposterId, ctx.imp.id, 'moderator knows the imposter');
  });

  await test('no majority for 3 rounds → final round forces a choice → wrong pick, imposter wins', async () => {
    const ctx = await startAndMap(await setup(5));
    for (let round = 1; round <= 3; round++) {
      await giveClues(ctx);
      const s = await voteAll(ctx, () => 'skip');
      assert.strictEqual(s.round, round + 1, 'should advance to next round');
      assert.strictEqual(s.tallies.at(-1).outcome, 'no-majority');
    }
    await giveClues(ctx);
    const r = await ctx.crew[0].act('vote', { target: 'skip' });
    assert(!r.ok && /must pick/.test(r.error), 'skip not allowed in final round');
    const innocent = ctx.crew[1];
    const s = await voteAll(ctx, (p) => (p === innocent ? ctx.crew[0].id : innocent.id));
    assert.strictEqual(s.phase, 'ended');
    assert.deepStrictEqual(s.result, { winner: 'imposter', reason: 'wrong-accusation' });
    assert.strictEqual(ctx.crew[2].sse.state.imposterId, ctx.imp.id, 'imposter revealed to all at the end');
  });

  await test('imposter caught in round 1, guesses the word (case/space-insensitive) → imposter wins', async () => {
    const ctx = await startAndMap(await setup(4));
    await giveClues(ctx);
    const s = await voteAll(ctx, (p) => (p === ctx.imp ? ctx.crew[0].id : ctx.imp.id));
    assert.strictEqual(s.phase, 'guess');
    let r = await ctx.crew[0].act('guess', { text: 'Mango' });
    assert(!r.ok, 'only imposter can guess');
    r = await ctx.imp.act('guess', { text: '  mAnGo!' });
    assert(r.ok);
    await until(() => ctx.m.sse.state.phase === 'ended', 'end');
    assert.deepStrictEqual(ctx.m.sse.state.result, { winner: 'imposter', reason: 'guessed-word' });
  });

  await test('imposter caught, wrong guess → moderator rejects → players win', async () => {
    const ctx = await startAndMap(await setup(6));
    await giveClues(ctx);
    await voteAll(ctx, (p) => (p === ctx.imp ? ctx.crew[0].id : ctx.imp.id));
    await ctx.imp.act('guess', { text: 'Banana' });
    await until(() => ctx.m.sse.state.phase === 'review', 'review');
    assert.strictEqual(ctx.crew[0].sse.state.guess, null, 'guess hidden from players during review');
    await ctx.m.act('review', { accept: false });
    await until(() => ctx.m.sse.state.phase === 'ended', 'end');
    assert.deepStrictEqual(ctx.m.sse.state.result, { winner: 'players', reason: 'wrong-guess' });
  });

  await test('near-miss spelling → moderator accepts → imposter wins', async () => {
    const ctx = await startAndMap(await setup(4));
    await giveClues(ctx);
    await voteAll(ctx, (p) => (p === ctx.imp ? ctx.crew[0].id : ctx.imp.id));
    await ctx.imp.act('guess', { text: 'Mangoe' });
    await until(() => ctx.m.sse.state.phase === 'review', 'review');
    await ctx.m.act('review', { accept: true });
    await until(() => ctx.m.sse.state.phase === 'ended', 'end');
    assert.strictEqual(ctx.m.sse.state.result.winner, 'imposter');
  });

  await test('imposter gives up → players win', async () => {
    const ctx = await startAndMap(await setup(4));
    await giveClues(ctx);
    await voteAll(ctx, (p) => (p === ctx.imp ? ctx.crew[0].id : ctx.imp.id));
    await ctx.imp.act('pass');
    await until(() => ctx.m.sse.state.phase === 'ended', 'end');
    assert.deepStrictEqual(ctx.m.sse.state.result, { winner: 'players', reason: 'imposter-passed' });
  });

  await test('final-round tie → re-vote → still tied → moderator breaks tie', async () => {
    const ctx = await startAndMap(await setup(4));
    for (let round = 1; round <= 3; round++) {
      await giveClues(ctx);
      await voteAll(ctx, () => 'skip');
    }
    await giveClues(ctx);
    const [a, b] = ctx.players; // tie 2–2 between a and b
    const pick = (p) => (p === a ? b.id : p === b ? a.id : ctx.players.indexOf(p) === 2 ? a.id : b.id);
    let s = await voteAll(ctx, pick);
    assert.strictEqual(s.tallies.at(-1).outcome, 'tie-revote');
    assert.deepStrictEqual([...s.candidates].sort(), [a.id, b.id].sort());
    s = await voteAll(ctx, pick);
    assert.strictEqual(s.phase, 'tiebreak');
    const r = await ctx.m.act('tiebreak', { target: a.id });
    assert(r.ok, r.error);
    await until(() => ['ended', 'guess'].includes(ctx.m.sse.state.phase), 'accusation');
    if (a === ctx.imp) assert.strictEqual(ctx.m.sse.state.phase, 'guess');
    else assert.strictEqual(ctx.m.sse.state.result.reason, 'wrong-accusation');
  });

  await test('clue rules: turn order and secret word blocked in clues', async () => {
    const ctx = await startAndMap(await setup(4));
    const st = ctx.m.sse.state;
    const notTurn = ctx.players.find((p) => p.id !== st.turnId);
    let r = await notTurn.act('clue', { text: 'hello' });
    assert(!r.ok && /not your turn/.test(r.error));
    const cur = ctx.byId[st.turnId];
    if (cur !== ctx.imp) {
      r = await cur.act('clue', { text: 'yellow mango' });
      assert(!r.ok && /can't contain/.test(r.error));
    }
  });

  await test('moderator controls: skip turn, close voting, play again keeps players, kick', async () => {
    const ctx = await startAndMap(await setup(5));
    await ctx.m.act('skipTurn');
    await until(() => ctx.m.sse.state.clues.length === 1, 'skip');
    assert(ctx.m.sse.state.clues[0].skipped);
    await giveClues(ctx);
    await ctx.players[0].act('vote', { target: 'skip' });
    await ctx.m.act('closeVoting');
    await until(() => ctx.m.sse.state.round === 2, 'close voting → next round');
    await ctx.m.act('newGame');
    await until(() => ctx.m.sse.state.phase === 'lobby', 'lobby');
    assert.strictEqual(ctx.m.sse.state.players.length, 5);
    assert.strictEqual(ctx.m.sse.state.word, '', 'word cleared for the next game');
    const victim = ctx.players[4];
    await ctx.m.act('kick', { id: victim.id });
    await until(() => victim.sse.kicked, 'kicked event');
    const r = await victim.act('vote', { target: 'skip' });
    assert(!r.ok, 'kicked player token is dead');
  });

  await test('reconnect: a player who drops and returns keeps their role', async () => {
    const ctx = await startAndMap(await setup(4));
    const p = ctx.imp;
    p.sse.ctrl.abort();
    await until(() => ctx.m.sse.state.players.find((x) => x.id === p.id).online === false, 'offline');
    p.sse = listen(p.session);
    await until(() => p.sse.state && ctx.m.sse.state.players.find((x) => x.id === p.id).online, 'back online');
    assert.strictEqual(p.sse.state.you.isImposter, true);
  });

  await test('simultaneous votes are all counted', async () => {
    const ctx = await startAndMap(await setup(8));
    await giveClues(ctx);
    const rs = await Promise.all(ctx.players.map((p) => p.act('vote', { target: 'skip' })));
    assert(rs.every((r) => r.ok), rs.find((r) => !r.ok)?.error);
    await until(() => ctx.m.sse.state.tallies.length === 1, 'tally');
    assert.strictEqual(ctx.m.sse.state.tallies[0].abstain, 8, 'no vote lost');
  });

  await test('options: rounds limited to 3 or 4, locked after start', async () => {
    const ctx = await setup(4);
    let r = await ctx.m.act('setOptions', { rounds: 5 });
    assert(!r.ok, '5 rounds refused');
    r = await ctx.players[0].act('setOptions', { rounds: 3 });
    assert(!r.ok && /moderator/.test(r.error), 'players cannot change options');
    assert((await ctx.m.act('setOptions', { rounds: 3 })).ok);
    await startAndMap(ctx);
    assert.strictEqual(ctx.players[0].sse.state.limits.rounds, 3);
    r = await ctx.m.act('setOptions', { rounds: 4 });
    assert(!r.ok, 'options locked once the game runs');
    for (let round = 1; round <= 2; round++) {
      await giveClues(ctx);
      await voteAll(ctx, () => 'skip');
    }
    await giveClues(ctx);
    r = await ctx.crew[0].act('vote', { target: 'skip' });
    assert(!r.ok && /must pick/.test(r.error), 'round 3 is final when 3 rounds are set');
  });

  await test('in person: no typed clues, moderator opens/skips voting, players cannot skip', async () => {
    const ctx = await setup(4);
    assert((await ctx.m.act('setOptions', { mode: 'inperson', rounds: 3 })).ok);
    await ctx.m.act('start');
    await until(() => ctx.players.every((p) => p.sse.state?.phase === 'discuss'), 'discuss phase');
    for (const p of ctx.players) p.id = p.sse.state.you.id;
    const imp = ctx.players.find((p) => p.sse.state.you.isImposter);
    const crew = ctx.players.filter((p) => p !== imp);
    let r = await crew[0].act('clue', { text: 'yellow' });
    assert(!r.ok, 'no typed clues in person');
    r = await crew[0].act('openVoting');
    assert(!r.ok && /moderator/.test(r.error), 'players cannot open voting');
    r = await crew[0].act('skipVoting');
    assert(!r.ok && /moderator/.test(r.error), 'players cannot skip voting');

    // Round 1: moderator skips straight to round 2.
    assert((await ctx.m.act('skipVoting')).ok);
    await until(() => ctx.m.sse.state.round === 2 && ctx.m.sse.state.phase === 'discuss', 'round 2');
    assert.strictEqual(ctx.m.sse.state.tallies.at(-1).outcome, 'skipped');

    // Round 2: voting opened, players may not skip; moderator cancels the vote.
    assert((await ctx.m.act('openVoting')).ok);
    await until(() => crew[0].sse.state.phase === 'voting', 'voting open');
    r = await crew[0].act('vote', { target: 'skip' });
    assert(!r.ok && /Only the moderator/.test(r.error), 'players cannot skip in person');
    assert((await crew[0].act('vote', { target: crew[1].id })).ok);
    assert((await ctx.m.act('skipVoting')).ok);
    await until(() => ctx.m.sse.state.round === 3 && ctx.m.sse.state.phase === 'discuss', 'round 3');

    // Round 3 (final): cannot skip; votes catch the imposter.
    r = await ctx.m.act('skipVoting');
    assert(!r.ok && /Final round/.test(r.error), 'final round cannot be skipped');
    await ctx.m.act('openVoting');
    await until(() => ctx.m.sse.state.phase === 'voting', 'final voting');
    for (const p of ctx.players) assert((await p.act('vote', { target: p === imp ? crew[0].id : imp.id })).ok);
    await until(() => ctx.m.sse.state.phase === 'guess', 'imposter caught');
    assert.strictEqual(ctx.m.sse.state.accusedId, imp.id);
  });

  srv.kill();
  for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? '\n' + e : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
