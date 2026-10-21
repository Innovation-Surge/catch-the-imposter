# Imposter — party word game

Real-time web game: one moderator, 4–10 players, one hidden imposter.
Runs two ways with the same game code (`lib/game.js`):
- **Netlify** — static `public/` + a Netlify Function at `/api/*`, rooms stored in Netlify Blobs.
- **Plain Node.js (18+)** — `server.js`, rooms in memory.

Clients poll `/api/state` about every 1.5 s (every 5 s while the tab is hidden).

## Rules (as implemented)

1. Moderator taps **Host a game**, gets a 5-letter room code, sets a **topic** (e.g. Fruit) and a **secret name** (e.g. Mango).
   In the lobby the moderator also picks the **game options**:
   - **Clues:** *typed in the app* (default), or *said out loud* when everyone is in the same room.
   - **Rounds:** 3 or 4 (default 4). The last round is the final round.
2. Players join on their phones with the code or the shared link (`/?room=CODE`). Min 4, max 10, unique names.
3. Moderator presses **Start** → room locks, one random player becomes the imposter. Everyone sees the topic; only non-imposters see the name. Cards are hidden behind "tap to reveal".
4. Each round: every player gives one clue in turn order (order rotates each round), then everyone votes.
   - **Said out loud:** players speak their clue in the shown order; nothing is typed. The moderator then taps **Open imposter voting**, or **Skip voting → next round**. Only the moderator can skip — players can't vote "skip", and the moderator can also cancel an open vote and start the next round.
   - Before the final round: a player needs a **strict majority** of all votes to be accused; in app mode players may **skip**. No majority → next round.
   - Final round (round 3 or 4): skip is not allowed — players must decide. Most votes is accused. Tie → one re-vote among the tied players; still tied → moderator picks among them.
5. Accused is innocent → **imposter wins**.
6. Accused is the imposter → imposter may guess the secret name (or give up).
   - **Typed in the app:** exact match (ignores case, spaces, punctuation, accents) → **imposter wins**. Not exact → moderator rules (accept spelling variants / reject). Reject or give up → **players win**.
   - **Said out loud:** the imposter says their guess; nothing is typed. The moderator taps **Right — imposter wins** or **Wrong — players win**.

Once a vote decides, every screen shows the imposter's name in big letters with a short reveal animation: **CAUGHT** when the imposter was voted out, **ESCAPED** when an innocent player was. The animation plays once and is turned off for people who have reduced motion set.

The moderator sees who voted for whom, live during voting and for every past round in the vote history, with votes for the imposter highlighted. Players only see the totals.

Extras: players can't put the secret name inside their clue; moderator can skip a stuck player's turn, close voting early (missing votes = skip), remove players in the lobby, abort, play again with the same players. Refreshing or losing signal rejoins automatically.

## Run

```bash
node server.js            # http://localhost:3000   (PORT env var to change)
npm test                  # plays simulated games against a live server
```

## Deploy

**Netlify:** connect the repo (or `netlify deploy --prod`). `netlify.toml` already sets the publish dir to `public/`, so the game is served at `/`, and the API function runs at `/api/*`. Leave the build command empty. Blobs need no setup. Local Netlify emulation: `npx netlify-cli dev`.

**Any VPS (PM2):**
```bash
pm2 start server.js --name imposter
```

**Docker:**
```bash
docker build -t imposter . && docker run -d -p 3000:3000 --restart unless-stopped imposter
```

**Render / Railway / Fly:** create a Node web service, start command `node server.js`, health check `/health`. No build step.

**Behind nginx:**
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

**Important (Node server only):** run a single instance. Game state is in memory, so don't load-balance across multiple processes (no PM2 cluster mode). A restart ends any game in progress.

## API (for reference)

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/create` | – | New room → `{code, token}` (moderator) |
| POST | `/api/join` | `{code, name}` | Join lobby → `{code, token}` |
| POST | `/api/action` | `{code, token, type, ...}` | `setSecret, setOptions, start, openVoting, skipVoting, clue, vote, skipTurn, closeVoting, tiebreak, guess, pass, review, kick, leave, newGame, closeRoom` |
| POST | `/api/state` | `{code, token}` | Per-viewer `state` (the imposter's view never contains the word), or `{ok:false, kicked}` |
| GET | `/health` | – | Liveness (Node server only) |
