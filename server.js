const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const Room = require('./server/Room');
const { GAMES, isValidGameType } = require('./server/games');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// During UI iteration we serve public/ with Cache-Control: no-store so
// browsers always pick up the latest assets without a hard refresh.
// The site sits behind Cloudflare; once the UI settles we can flip
// this and let CF cache normally.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Lightweight catalog endpoint so the client can render the game-picker
// and any "coming soon" games without us hardcoding the list twice.
app.get('/api/games', (req, res) => {
  res.json(Object.values(GAMES).map((g) => ({
    type: g.type,
    name: g.name,
    tagline: g.tagline,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    available: g.available !== false,
  })));
});

const rooms = new Map();

// Avoid 0/O and 1/I/L to keep room codes legible when typed off a screen.
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function generatePlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Player';
  const trimmed = name.trim().slice(0, 16);
  return trimmed || 'Player';
}

// Reap empty rooms once a minute.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.isEmpty()) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60000);

// Heartbeat — terminate dead WS connections so close handlers fire and
// player state in the room moves to disconnected.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      return;
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.roomCode && ws.playerId) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.handleDisconnect(ws.playerId);
        if (room.isEmpty()) {
          room.destroy();
          rooms.delete(ws.roomCode);
        }
      }
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room': {
      if (!isValidGameType(msg.gameType)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown game' }));
        return;
      }
      const game = GAMES[msg.gameType];
      if (game.available === false) {
        ws.send(JSON.stringify({ type: 'error', message: `${game.name} isn't ready yet` }));
        return;
      }
      const name = sanitizeName(msg.playerName);
      const code = generateRoomCode();
      const playerId = generatePlayerId();
      const room = new Room(code, msg.gameType);
      rooms.set(code, room);

      room.addPlayer(playerId, name, ws);
      ws.playerId = playerId;
      ws.roomCode = code;

      ws.send(JSON.stringify({
        type: 'room_created',
        roomCode: code,
        playerId,
        ...room.getState(),
      }));
      break;
    }

    case 'join_room': {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }

      const name = sanitizeName(msg.playerName);
      const playerId = generatePlayerId();
      // If the room is full or already playing, fall back to spectator.
      const asSpectator = !!msg.asSpectator || !room.canSeatPlayer();
      const result = asSpectator
        ? room.addSpectator(playerId, name, ws)
        : room.addPlayer(playerId, name, ws);

      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        return;
      }

      ws.playerId = playerId;
      ws.roomCode = code;

      ws.send(JSON.stringify({
        type: asSpectator ? 'spectator_joined' : 'room_joined',
        roomCode: code,
        playerId,
        role: asSpectator ? 'spectator' : 'player',
        ...room.getFullState(playerId),
      }));

      room.broadcastExcept(playerId, {
        type: asSpectator ? 'spectator_added' : 'player_joined',
        ...room.getState(),
      });
      break;
    }

    case 'reconnect': {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }
      const result = room.reconnect(msg.playerId, ws);
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        return;
      }
      ws.playerId = msg.playerId;
      ws.roomCode = code;
      ws.send(JSON.stringify({
        type: 'reconnected',
        playerId: msg.playerId,
        role: result.role,
        ...room.getFullState(msg.playerId),
      }));
      room.broadcastExcept(msg.playerId, {
        type: 'player_reconnected',
        playerId: msg.playerId,
        ...room.getState(),
      });
      break;
    }

    case 'start_game': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can start the game' }));
        return;
      }
      const result = room.startGame();
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      }
      break;
    }

    case 'play_again': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can start the next round' }));
        return;
      }
      const result = room.playAgain();
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      }
      break;
    }

    case 'add_bot': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can add a bot' }));
        return;
      }
      const result = room.addBot();
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        return;
      }
      room.broadcast({ type: 'bot_added', ...room.getState() });
      break;
    }

    case 'remove_bot': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can remove a bot' }));
        return;
      }
      const result = room.removeBot(msg.botId);
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        return;
      }
      room.broadcast({ type: 'bot_removed', ...room.getState() });
      break;
    }

    case 'game_action': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game) return;
      const result = room.game.handleAction(ws.playerId, msg.action);
      if (result && !result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      }
      break;
    }

    case 'leave_room': {
      if (ws.roomCode && ws.playerId) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          room.removeOccupant(ws.playerId);
          if (room.isEmpty()) {
            room.destroy();
            rooms.delete(ws.roomCode);
          }
        }
      }
      ws.playerId = null;
      ws.roomCode = null;
      ws.send(JSON.stringify({ type: 'left_room' }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Level0 server running on port ${PORT}`);
});
