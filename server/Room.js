const Player = require('./Player');
const { GAMES } = require('./games');

const SPECTATOR_LIMIT = 20;
const BOT_NAMES = ['Atlas', 'Echo', 'Nova', 'Sage', 'Pixel', 'Onyx'];

class Room {
  constructor(code, gameType) {
    this.code = code;
    this.gameType = gameType;
    this.gameMeta = GAMES[gameType];
    this.occupants = new Map(); // id -> Player (players + spectators)
    this.hostId = null;
    this.game = null;
    this.state = 'lobby'; // 'lobby' | 'playing' | 'finished'
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
    return { success: true, role: occ.role };
  }

  // ── leaving ──────────────────────────────────────────────────────

  handleDisconnect(id) {
    const occ = this.occupants.get(id);
    if (!occ) return;

    occ.connected = false;
    occ.ws = null;

    // In the lobby, leaving = gone (so people can re-join with a fresh
    // identity if they want). Mid-game, keep the seat reserved so
    // they can reconnect.
    if (this.state === 'lobby' || occ.isSpectator) {
      this.occupants.delete(id);
      if (!occ.isSpectator && this.hostId === id) {
        this.reassignHost();
      }
      this.broadcast({
        type: occ.isSpectator ? 'spectator_left' : 'player_left',
        leftId: id,
        leftName: occ.name,
        ...this.getState(),
      });
      return;
    }

    this.broadcast({
      type: 'player_disconnected',
      playerId: id,
      playerName: occ.name,
      ...this.getState(),
    });
  }

  removeOccupant(id) {
    const occ = this.occupants.get(id);
    if (!occ) return;
    this.occupants.delete(id);
    if (!occ.isSpectator && this.hostId === id) this.reassignHost();
    this.broadcast({
      type: occ.isSpectator ? 'spectator_left' : 'player_left',
      leftId: id,
      leftName: occ.name,
      ...this.getState(),
    });
  }

  reassignHost() {
    for (const p of this.occupants.values()) {
      if (!p.isSpectator) {
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
    this.game = new GameClass(players, this.broadcastWithRoomState.bind(this), () => this.onGameEnd());
    this.state = 'playing';
    this.game.start();
    return { success: true };
  }

  broadcastWithRoomState(msg) {
    this.broadcast({ ...this.getState(), ...msg });
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
      Object.assign(state, this.game.getFullState(viewerId));
    }
    return state;
  }

  destroy() {
    if (this.game && typeof this.game.destroy === 'function') {
      this.game.destroy();
    }
  }
}

module.exports = Room;
