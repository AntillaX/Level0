# Level 0

Simple, chill multiplayer games for [platformvv.com](https://platformvv.com) —
tic-tac-toe, four in a row, and more to come. Built to be played while
hanging out with friends.

One Node + WebSocket server hosts every game. Picking a game is part of
room creation: each room is locked to a single game type. Spectators can
join any room and watch live; no bots.

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
`server/games/index.js`. The class implements:

- `start()`
- `handleAction(playerId, action)`
- `handleSpectatorJoin(spectatorId)` (optional)
- `getFullState(viewerId)` — what a (re)joiner sees
- `destroy()`

Client-side, add a renderer in `public/games/<name>.js` keyed off
`gameType` in the room state.

## Deployment

See [`deploy/README.md`](deploy/README.md) for the droplet steps.
