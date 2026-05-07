const Player = require('./Player');
const { GAMES } = require('./games');

const SPECTATOR_LIMIT = 20;
const BOT_NAMES = ['Atlas', 'Echo', 'Nova', 'Sage', 'Pixel', 'Onyx'];
const RECONNECT_GRACE_MS = 20000; // refresh tolerance for handlesDisconnect games

class Room {
  constructor(code, gameType) {
    this.code = code;
    this.gameType = gameType;
    this.gameMeta = GAMES[gameType];
    this.occupants = new Map(); // id -> Player (players + spectators)
    this.hostId = null;
    this.game = null;
    this.state = 'lobby'; // 'lobby' | 'playing' | 'finished'
    // Tally of wins across multiple rounds in the same room. Each
    // call to playAgain() spins up a new Game instance, so this
    // lives at the room level so the running score survives.
    this.persistentWins = {};
    // For games with handlesDisconnect: per-player grace timers that
    // give a refreshing player ~20s to reconnect before the round is
    // abandoned. Cleared on reconnect or when the room is destroyed.
    this.reconnectGraceTimers = new Map();
  }

  // ── helpers ──────────────────────────────────────────────────────

  players() {
    const out = [];
    for (const p of this.occupants.values()) {
      if (!p.isSpectator) out.push(p);
    }
    return out;
  }

  spectators() {
    const out = [];
    for (const p of this.occupants.values()) {
      if (p.isSpectator) out.push(p);
    }
    return out;
  }

  connectedPlayerCount() {
    let n = 0;
    for (const p of this.occupants.values()) {
      if (!p.isSpectator && p.connected) n++;
    }
    return n;
  }

  canSeatPlayer() {
    return this.state === 'lobby' && this.players().length < this.gameMeta.maxPlayers;
  }

  // ── joining ──────────────────────────────────────────────────────

  addPlayer(playerId, name, ws) {
    if (!this.canSeatPlayer()) {
      return { success: false, error: 'Room is full or game already started — try joining as spectator' };
    }
    const player = new Player(playerId, name, ws, 'player');
    this.occupants.set(playerId, player);
    if (!this.hostId) this.hostId = playerId;
    return { success: true };
  }

  addSpectator(spectatorId, name, ws) {
    if (this.spectators().length >= SPECTATOR_LIMIT) {
      return { success: false, error: 'Spectator limit reached' };
    }
    this.occupants.set(spectatorId, new Player(spectatorId, name, ws, 'spectator'));
    return { success: true };
  }

  addBot() {
    if (!this.canSeatPlayer()) {
      return { success: false, error: 'Room is full or game already started' };
    }
    // Pick the first bot name that isn't already at the table.
    const taken = new Set(this.players().map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${this.players().length}`;
    let id;
    do { id = `bot_${Math.random().toString(36).slice(2, 10)}`; } while (this.occupants.has(id));
    this.occupants.set(id, new Player(id, name, null, 'player', true));
    return { success: true, botId: id };
  }

  removeBot(botId) {
    const occ = this.occupants.get(botId);
    if (!occ || !occ.isBot) return { success: false, error: 'Not a bot' };
    if (this.state !== 'lobby') return { success: false, error: 'Game already started' };
    this.occupants.delete(botId);
    return { success: true };
  }

  reconnect(id, ws) {
    const occ = this.occupants.get(id);
    if (!occ) return { success: false, error: 'You are not in this room' };
    occ.ws = ws;
    occ.connected = true;
    this.clearReconnectGrace(id);
    return { success: true, role: occ.role };
  }

  // ── Disconnect grace (for games with handlesDisconnect) ──────────

  startReconnectGrace(playerId, playerName) {
    const existing = this.reconnectGraceTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.reconnectGraceTimers.set(playerId, setTimeout(() => {
      this.reconnectGraceTimers.delete(playerId);
      const occ = this.occupants.get(playerId);
      if (!occ || occ.connected) return; // they came back
      // Grace expired without reconnect — abandon as usual.
      this.endRoundDueToLeave(playerId, playerName);
    }, RECONNECT_GRACE_MS));
  }

  clearReconnectGrace(playerId) {
    const t = this.reconnectGraceTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.reconnectGraceTimers.delete(playerId);
    }
  }

  clearAllReconnectGraces() {
    for (const t of this.reconnectGraceTimers.values()) clearTimeout(t);
    this.reconnectGraceTimers.clear();
  }

  // ── leaving ──────────────────────────────────────────────────────

  handleDisconnect(id) {
    const occ = this.occupants.get(id);
    if (!occ) return;

    occ.connected = false;
    occ.ws = null;

    // Lobby / spectator: just remove and broadcast.
    if (this.state === 'lobby' || occ.isSpectator) {
      this.occupants.delete(id);
      if (!occ.isSpectator && this.hostId === id) {
        const previousHost = this.hostId;
        this.reassignHost();
        if (this.hostId && this.hostId !== previousHost) {
          this.broadcast({ type: 'host_changed', hostId: this.hostId, ...this.getState() });
        }
      }
      this.broadcast({
        type: occ.isSpectator ? 'spectator_left' : 'player_left',
        leftId: id,
        leftName: occ.name,
        ...this.getState(),
      });
      return;
    }

    // Mid-game player drop. By default we abandon — the round
    // can't continue without them. But games with handlesDisconnect
    // (Mafia) get a grace window: just mark disconnected, broadcast
    // it, and start a 20s timer. If they reconnect (a tab refresh
    // is the common case), we cancel and the game continues; if not,
    // the timer fires and abandons like normal.
    if (this.gameMeta && this.gameMeta.handlesDisconnect) {
      this.broadcast({
        type: 'player_disconnected',
        playerId: id,
        playerName: occ.name,
        graceMs: RECONNECT_GRACE_MS,
        ...this.getState(),
      });
      this.startReconnectGrace(id, occ.name);
      return;
    }
    this.endRoundDueToLeave(id, occ.name);
  }

  removeOccupant(id) {
    const occ = this.occupants.get(id);
    if (!occ) return;

    // Mid-game leave: same path as a network drop — end the round and
    // bounce everyone back to lobby.
    if (this.state === 'playing' && !occ.isSpectator && !occ.isBot) {
      this.occupants.delete(id);
      if (this.hostId === id) {
        const prev = this.hostId;
        this.reassignHost();
        if (this.hostId && this.hostId !== prev) {
          this.broadcast({ type: 'host_changed', hostId: this.hostId, ...this.getState() });
        }
      }
      this.endRoundDueToLeave(id, occ.name);
      return;
    }

    this.occupants.delete(id);
    if (!occ.isSpectator && this.hostId === id) {
      const previousHost = this.hostId;
      this.reassignHost();
      if (this.hostId && this.hostId !== previousHost) {
        this.broadcast({ type: 'host_changed', hostId: this.hostId, ...this.getState() });
      }
    }
    this.broadcast({
      type: occ.isSpectator ? 'spectator_left' : 'player_left',
      leftId: id,
      leftName: occ.name,
      ...this.getState(),
    });
  }

  // Tear down the active game and put everyone back in the lobby.
  // Used for both deliberate Leave and network drops mid-game —
  // there's no "you win by forfeit" screen, just a brief notice and
  // the lobby state ready for a Play Again or a new joiner.
  endRoundDueToLeave(leftId, leftName) {
    if (this.game && typeof this.game.destroy === 'function') {
      this.game.destroy();
    }
    this.game = null;
    this.state = 'lobby';
    this.broadcast({
      type: 'round_abandoned',
      leftId,
      leftName,
      ...this.getState(),
    });
  }

  reassignHost() {
    for (const p of this.occupants.values()) {
      // Don't promote bots or spectators to host.
      if (!p.isSpectator && !p.isBot) {
        this.hostId = p.id;
        return;
      }
    }
    this.hostId = null;
  }

  isEmpty() {
    if (this.occupants.size === 0) return true;
    // A room with only bots (or only disconnected humans) is "empty"
    // for cleanup purposes — bots don't count as keeping a room alive.
    for (const occ of this.occupants.values()) {
      if (occ.connected && !occ.isBot) return false;
    }
    return true;
  }

  // ── game lifecycle ───────────────────────────────────────────────

  startGame() {
    if (this.state !== 'lobby') {
      return { success: false, error: 'Game already started' };
    }
    const players = this.players();
    if (players.length < this.gameMeta.minPlayers) {
      return { success: false, error: `Need at least ${this.gameMeta.minPlayers} players` };
    }
    const GameClass = this.gameMeta.GameClass;
    // Pass a wrapped broadcast so every game-emitted message carries the
    // current room state (roomCode, hostId, players, roomState, etc).
    // Without this the client wouldn't know to flip from lobby → game,
    // since the game class only knows about its own state.
    //
    // Also pass broadcastPerViewer for games that show per-player
    // private state (Mafia: each player sees a different view of the
    // world depending on their role + alive status).
    this.game = new GameClass(
      players,
      this.broadcastWithRoomState.bind(this),
      () => this.onGameEnd(),
      {
        wins: this.persistentWins,
        broadcastPerViewer: this.broadcastPerViewer.bind(this),
      },
    );
    this.state = 'playing';
    this.game.start();
    return { success: true };
  }

  broadcastWithRoomState(msg) {
    this.broadcast({ ...this.getState(), ...msg });
  }

  // Send a per-viewer message: viewerFn(occupant) returns a payload
  // for that occupant (or null/undefined to skip them). The current
  // room state is merged in automatically. Used for games where
  // players see different things (Mafia private actions).
  broadcastPerViewer(viewerFn) {
    const baseState = this.getState();
    for (const occ of this.occupants.values()) {
      if (!occ.connected || !occ.ws || occ.ws.readyState !== 1) continue;
      const payload = viewerFn(occ);
      if (!payload) continue;
      occ.ws.send(JSON.stringify({ ...baseState, ...payload }));
    }
  }

  playAgain() {
    if (this.state !== 'finished') {
      return { success: false, error: 'No finished game to replay' };
    }
    this.game = null;
    this.state = 'lobby';
    return this.startGame();
  }

  onGameEnd() {
    this.state = 'finished';
    // Snapshot the running tally so the next round starts with it.
    if (this.game && this.game.wins) {
      this.persistentWins = { ...this.game.wins };
    }
  }

  // ── messaging ────────────────────────────────────────────────────

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const occ of this.occupants.values()) {
      if (occ.connected && occ.ws && occ.ws.readyState === 1) {
        occ.ws.send(data);
      }
    }
  }

  broadcastExcept(excludeId, msg) {
    const data = JSON.stringify(msg);
    for (const [id, occ] of this.occupants) {
      if (id === excludeId) continue;
      if (occ.connected && occ.ws && occ.ws.readyState === 1) {
        occ.ws.send(data);
      }
    }
  }

  // ── state snapshots ──────────────────────────────────────────────

  getState() {
    return {
      roomCode: this.code,
      gameType: this.gameType,
      gameName: this.gameMeta.name,
      hostId: this.hostId,
      roomState: this.state,
      minPlayers: this.gameMeta.minPlayers,
      maxPlayers: this.gameMeta.maxPlayers,
      players: this.players().map((p) => p.toJSON()),
      spectators: this.spectators().map((p) => p.toJSON()),
    };
  }

  getFullState(viewerId) {
    const state = this.getState();
    if (this.game) {
      // Pass through the real occupant when we have one — Mafia
      // uses it to determine whether the viewer is a spectator
      // (and therefore sees the omniscient view). Other games
      // ignore the second arg.
      const occ = this.occupants.get(viewerId);
      Object.assign(state, this.game.getFullState(viewerId, occ));
    }
    return state;
  }

  destroy() {
    this.clearAllReconnectGraces();
    if (this.game && typeof this.game.destroy === 'function') {
      this.game.destroy();
    }
  }
}

module.exports = Room;
