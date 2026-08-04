# Level 0

Simple, chill multiplayer games for [platformvv.com](https://platformvv.com) —
tic-tac-toe, four in a row, dots & boxes, Mafia, Texas hold'em, and more
to come. Built to be played while hanging out with friends.

One Node + WebSocket server hosts every game. Picking a game is part of
room creation: each room is locked to a single game type. Spectators can
join any room and watch live. Most games can be filled out with bots —
Mafia is the exception, since bots can't bluff.

## Games

- **Tic-Tac-Toe** — two players, three in a row.
- **Four in a Row** — drop, stack, connect four.
- **Dots & Boxes** — close more squares than your opponent.
- **Mafia** — 5-10 players, hidden roles, discuss and vote.
- **Texas Hold'em** — tournament poker at a 5- or 9-handed table.
  Everyone starts with $1,000,000. Seats nobody joins are filled with AI
  when the host starts, so you can run a full table on your own. Blinds
  open at $5K/$10K and step up every 8 hands, with a big-blind ante from
  level 4 — a table plays out in roughly 35-45 minutes. Last player
  holding chips wins.

## Poker AI

The poker bots aren't running a lookup table. On every decision each one
simulates a few hundred runouts of the current hand against random
opponent holdings to get a real equity number, then weighs that against
pot odds, the size of the bet it's facing, whether anyone has raised,
its position, and how deep its stack is. Under ~10 big blinds it
switches to push/fold. Each seat draws one of six personality profiles
(tight-aggressive, calling station, maniac, …) with per-bot jitter, so a
table of nine doesn't play as one player. A decision costs well under a
millisecond.

The engine lives in `server/games/poker/` and imports nothing from Level
0, so it can be lifted out if it ever outgrows this repo.

## Stack

- Node 20+, Express, `ws`
- Vanilla JS / HTML / CSS client (no build step)
- Rooms live in memory; restarting the server clears them

## Local development

```bash
npm install
npm start
# open http://localhost:3000 in two browser windows
```

`PORT` defaults to `3000` locally and is set to `3200` on the droplet.

## Adding a game

Each game is a class in `server/games/` registered in
`server/games/index.js`. The Room constructs it as
`new GameClass(players, broadcast, onEnd, opts)` and calls:

- `start()`
- `handleAction(playerId, action)` — returns `{ success, error? }`
- `getFullState(viewerId, occupant)` — what a (re)joiner sees
- `destroy()` — cancel any timers; the Room calls this when a room is
  reaped or replayed

`broadcast(msg)` already merges the current room state into whatever the
game sends, so the client knows to flip from lobby to game.

`opts` carries `wins` (the running tally across rounds),
`broadcastPerViewer`, and `options`.

**Private state.** `broadcast` sends one payload to everyone. Games
holding per-player secrets use `opts.broadcastPerViewer(fn)` instead,
which calls `fn(occupant)` once per connected occupant and sends each
the result. Mafia uses it for hidden roles, poker for hole cards.

**Registry flags.** `noBots` blocks bots entirely (Mafia).
`handlesDisconnect` gives mid-game drops a reconnect grace window.
`fillWithBots` tops the empty seats up with bots when the host starts,
instead of the host adding them one at a time. `options` declares
host-chosen room settings — each entry lists its allowed `choices` and a
`default`, and the Room validates the host's selection against that
spec, so a hand-edited client message can't widen it. A `tableSize`
option also drives the room's seat count. The client renders a setup
screen for any game that declares options.

Client-side, most renderers live inline in `public/app.js`; a large one
can go in `public/games/<name>.js` (as poker does) and register itself
into `GAME_RENDERERS` — and optionally `GAME_OVER_RENDERERS`, to take
over the end screen — keyed off `gameType`, with a `<script>` tag added
in `public/index.html`.

## Deployment

See [`deploy/README.md`](deploy/README.md) for the droplet steps.
