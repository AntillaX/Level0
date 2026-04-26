/* ─── State ────────────────────────────────────────────────────── */

const state = {
  ws: null,
  connected: false,
  reconnectAttempt: 0,
  reconnectTimer: null,

  // Identity / room
  playerId: null,
  roomCode: null,
  role: null,         // 'player' | 'spectator'
  myName: '',

  // Server snapshot (whatever Room.getFullState returns)
  room: null,

  // Catalog
  games: [],
  pickerLoaded: false,
};

const SCREENS = ['landing', 'room', 'game', 'gameover'];

/* ─── Utilities ────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  SCREENS.forEach((s) => $(`${s}-screen`).classList.toggle('active', s === name));
}

function track(eventName, params = {}) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 2400);
}

function setReconnecting(on) {
  $('reconnect-overlay').classList.toggle('hidden', !on);
}

/* ─── Persistence (so a refresh keeps you in your seat) ────────── */

const SESSION_KEY = 'level0.session';

function saveSession() {
  if (!state.playerId || !state.roomCode) {
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    playerId: state.playerId,
    roomCode: state.roomCode,
    name: state.myName,
  }));
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

/* ─── WebSocket ────────────────────────────────────────────────── */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Behind nginx the path is /level0/ so we keep it; locally pathname is /.
  const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  return `${proto}//${location.host}${base}`;
}

function connect() {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    state.reconnectAttempt = 0;
    setReconnecting(false);

    // Try to resume an in-progress session.
    const saved = loadSession();
    if (saved && saved.playerId && saved.roomCode) {
      send({ type: 'reconnect', playerId: saved.playerId, roomCode: saved.roomCode });
    }
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    state.ws = null;
    if (state.playerId && state.roomCode) {
      setReconnecting(true);
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', () => {
    // close handler will clean up
  });
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(8000, 500 * Math.pow(1.7, state.reconnectAttempt++));
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

function send(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast('Not connected — try again in a sec');
    return false;
  }
  state.ws.send(JSON.stringify(msg));
  return true;
}

/* ─── Server → client ──────────────────────────────────────────── */

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_created':
    case 'room_joined':
    case 'spectator_joined':
    case 'reconnected': {
      state.playerId = msg.playerId;
      state.roomCode = msg.roomCode;
      state.role = msg.role || (msg.type === 'spectator_joined' ? 'spectator' : 'player');
      state.room = msg;
      saveSession();
      renderForState();
      break;
    }

    case 'player_joined':
    case 'player_left':
    case 'spectator_added':
    case 'spectator_left':
    case 'player_disconnected':
    case 'player_reconnected':
    case 'bot_added':
    case 'bot_removed': {
      mergeRoomState(msg);
      renderForState();
      break;
    }

    case 'game_started': {
      mergeRoomState(msg);
      renderForState();
      track('level0_game_start', { game: msg.gameType });
      break;
    }

    case 'game_update': {
      mergeRoomState(msg);
      renderForState();
      break;
    }

    case 'game_over': {
      // game_over arrives just after a game_update that already set
      // status:'finished', so the board is current. We still merge
      // the wins map and switch screens — but pause briefly first
      // so the winning line animation gets to play before we yank
      // the board off-screen.
      if (state.room) {
        state.room.result = msg.result;
        state.room.wins = msg.wins;
      }
      const isWin = msg.result && msg.result.kind === 'win';
      setTimeout(goToGameOver, isWin ? 1200 : 400);
      track('level0_game_over', {
        game: state.room && state.room.gameType,
        kind: msg.result && msg.result.kind,
      });
      break;
    }

    case 'left_room': {
      state.playerId = null;
      state.roomCode = null;
      state.role = null;
      state.room = null;
      clearSession();
      showScreen('landing');
      break;
    }

    case 'error': {
      // "Room not found" on a reconnect attempt means our saved
      // session is stale (server restarted, room reaped). Clear it
      // and go home rather than spamming the user.
      if (msg.message === 'Room not found' && !state.room) {
        clearSession();
        state.playerId = null;
        state.roomCode = null;
        showScreen('landing');
        return;
      }
      toast(msg.message || 'Something went wrong');
      break;
    }

    default:
      // Unknown — ignore.
      break;
  }
}

function mergeRoomState(msg) {
  if (!state.room) state.room = {};
  // Server sends a flat object with top-level room state + game state.
  // We just shallow-merge the keys we know about.
  const keys = [
    'roomCode', 'gameType', 'gameName', 'hostId', 'roomState',
    'minPlayers', 'maxPlayers', 'players', 'spectators',
    'board', 'marks', 'order', 'currentTurn', 'status', 'result', 'wins',
    'moveCount',
  ];
  for (const k of keys) {
    if (msg[k] !== undefined) state.room[k] = msg[k];
  }
}

/* ─── Render dispatch ──────────────────────────────────────────── */

function renderForState() {
  const r = state.room;
  if (!r) { showScreen('landing'); return; }

  if (r.roomState === 'lobby') {
    renderRoom();
    showScreen('room');
  } else if (r.roomState === 'playing') {
    renderGame();
    showScreen('game');
  } else if (r.roomState === 'finished') {
    renderGameOver();
    showScreen('gameover');
  }
}

function goToGameOver() {
  renderGameOver();
  showScreen('gameover');
}

/* ─── Render: Room / lobby ─────────────────────────────────────── */

function renderRoom() {
  const r = state.room;
  $('room-game-name').textContent = r.gameName || '';
  $('room-code').textContent = r.roomCode || '';

  // Players list
  const playersEl = $('players-list');
  playersEl.innerHTML = '';
  for (const p of r.players || []) {
    playersEl.appendChild(renderPerson(p, r));
  }
  $('players-count').textContent = `${(r.players || []).length}/${r.maxPlayers}`;

  // Spectators list (hidden unless any)
  const specs = r.spectators || [];
  const section = $('spectators-section');
  section.hidden = specs.length === 0;
  const specsEl = $('spectators-list');
  specsEl.innerHTML = '';
  for (const s of specs) specsEl.appendChild(renderPerson(s, r));
  $('spectators-count').textContent = `${specs.length}`;

  // Host gets Start + Add Bot when seats permit.
  const isHost = r.hostId === state.playerId;
  const playerCount = (r.players || []).length;
  const enoughPlayers = playerCount >= (r.minPlayers || 2);
  const roomFull = playerCount >= (r.maxPlayers || 2);
  const startBtn = $('start-btn');
  const addBotBtn = $('add-bot-btn');
  const waitMsg = $('waiting-msg');

  if (state.role === 'spectator') {
    startBtn.classList.add('hidden');
    addBotBtn.classList.add('hidden');
    waitMsg.classList.remove('hidden');
    waitMsg.textContent = enoughPlayers ? 'Waiting for host to start…' : 'Waiting for players…';
  } else if (isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !enoughPlayers;
    startBtn.textContent = enoughPlayers ? 'Start Game' : `Need ${r.minPlayers} players`;
    addBotBtn.classList.toggle('hidden', roomFull);
    waitMsg.classList.add('hidden');
  } else {
    startBtn.classList.add('hidden');
    addBotBtn.classList.add('hidden');
    waitMsg.classList.remove('hidden');
    waitMsg.textContent = enoughPlayers ? 'Waiting for host to start…' : 'Waiting for players…';
  }
}

function renderPerson(person, room) {
  const li = document.createElement('li');
  li.className = 'person';
  if (person.id === room.hostId) li.classList.add('is-host');
  if (!person.connected) li.classList.add('is-disconnected');

  const name = document.createElement('span');
  name.className = 'person-name';
  name.textContent = person.name + (person.connected || person.isBot ? '' : ' (offline)');
  li.appendChild(name);

  if (person.isBot) {
    const tag = document.createElement('span');
    tag.className = 'person-tag person-tag-bot';
    tag.textContent = 'Bot';
    li.appendChild(tag);
  } else if (person.id === state.playerId) {
    const tag = document.createElement('span');
    tag.className = 'person-tag person-tag-self';
    tag.textContent = 'You';
    li.appendChild(tag);
  }
  if (!person.isBot && person.id === room.hostId) {
    const tag = document.createElement('span');
    tag.className = 'person-tag';
    tag.textContent = 'Host';
    li.appendChild(tag);
  }
  // In-game mark badge (X / O)
  if (room.marks && room.marks[person.id]) {
    const tag = document.createElement('span');
    tag.className = 'person-tag person-tag-mark';
    tag.textContent = room.marks[person.id];
    li.appendChild(tag);
  }
  // Host-only kick button for bots in the lobby.
  if (person.isBot && room.roomState === 'lobby' && room.hostId === state.playerId) {
    const btn = document.createElement('button');
    btn.className = 'person-remove';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Remove ${person.name}`);
    btn.textContent = '×';
    btn.addEventListener('click', () => send({ type: 'remove_bot', botId: person.id }));
    li.appendChild(btn);
  }
  return li;
}

/* ─── Render: Game (dispatched by gameType) ────────────────────── */

const GAME_RENDERERS = {
  tictactoe: renderTicTacToe,
};

function renderGame() {
  const r = state.room;
  $('game-name-label').textContent = r.gameName || '';
  const renderer = GAME_RENDERERS[r.gameType];
  const stage = $('game-stage');
  stage.innerHTML = '';
  if (!renderer) {
    stage.textContent = 'Unsupported game';
    return;
  }
  renderer(stage, r);
  renderScoreboard($('scoreboard'), r);
}

/* ─── Render: Tic-Tac-Toe ──────────────────────────────────────── */

function renderTicTacToe(stage, r) {
  const myMark = r.marks && r.marks[state.playerId];
  const isMyTurn = state.role === 'player' && r.currentTurn === state.playerId && r.status === 'playing';

  // Top banner — whose turn / outcome
  const banner = $('turn-banner');
  if (r.status === 'finished') {
    banner.textContent = '';
  } else if (isMyTurn) {
    banner.innerHTML = `Your turn — <span class="accent">${myMark}</span>`;
  } else {
    const turnPlayer = (r.players || []).find((p) => p.id === r.currentTurn);
    const turnMark = r.marks && r.marks[r.currentTurn];
    if (turnPlayer) {
      banner.innerHTML = `<span class="accent">${turnPlayer.name}</span> &middot; ${turnMark || ''}`;
    } else {
      banner.textContent = '…';
    }
  }

  const board = document.createElement('div');
  board.className = 'ttt-board';

  const winLine = (r.result && r.result.kind === 'win') ? r.result.line : null;
  const winningSet = new Set(winLine || []);

  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('button');
    cell.className = 'ttt-cell';
    cell.type = 'button';
    cell.setAttribute('aria-label', `Cell ${i + 1}`);

    const val = (r.board || [])[i];
    const empty = val === null || val === undefined;
    const canPlay = empty && isMyTurn;
    cell.disabled = !canPlay;
    if (canPlay) cell.classList.add('is-clickable');
    if (winningSet.has(i)) cell.classList.add('is-winning');

    if (!empty) {
      const span = document.createElement('span');
      span.className = 'ttt-mark' + (val === 'O' ? ' is-o' : '');
      span.textContent = val;
      cell.appendChild(span);
    }

    cell.addEventListener('click', () => {
      send({ type: 'game_action', action: { kind: 'place', cell: i } });
    });
    board.appendChild(cell);
  }

  if (winLine) board.appendChild(buildWinLineSvg(winLine));

  stage.appendChild(board);
}

// Coordinate space matches the 3×3 grid: (col, row), each in 0..3.
// Cell N has col = N % 3, row = floor(N / 3); center is +0.5.
function buildWinLineSvg(line) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ttt-winline');
  svg.setAttribute('viewBox', '0 0 3 3');
  svg.setAttribute('preserveAspectRatio', 'none');

  const [a, , c] = line;
  const x1 = (a % 3) + 0.5, y1 = Math.floor(a / 3) + 0.5;
  const x2 = (c % 3) + 0.5, y2 = Math.floor(c / 3) + 0.5;
  const len = Math.hypot(x2 - x1, y2 - y1);

  // Inset each end slightly so the line doesn't poke out of the cells.
  const inset = 0.15;
  const dx = (x2 - x1) / len, dy = (y2 - y1) / len;
  const sx = x1 + dx * inset, sy = y1 + dy * inset;
  const ex = x2 - dx * inset, ey = y2 - dy * inset;
  const drawLen = Math.hypot(ex - sx, ey - sy);

  const path = document.createElementNS(NS, 'line');
  path.setAttribute('class', 'ttt-winline-stroke');
  path.setAttribute('x1', sx);
  path.setAttribute('y1', sy);
  path.setAttribute('x2', ex);
  path.setAttribute('y2', ey);
  path.style.setProperty('--len', drawLen);
  svg.appendChild(path);
  return svg;
}

function renderScoreboard(el, r) {
  el.innerHTML = '';
  if (!r.players) return;
  for (const p of r.players) {
    const card = document.createElement('div');
    card.className = 'score-card';
    if (p.id === r.currentTurn && r.status === 'playing') card.classList.add('is-active');

    const name = document.createElement('span');
    name.className = 'score-card-name';
    name.textContent = p.id === state.playerId ? `${p.name} (you)` : p.name;
    card.appendChild(name);

    const wins = document.createElement('span');
    wins.className = 'score-card-wins';
    const mark = (r.marks && r.marks[p.id]) || '';
    wins.innerHTML = `<span class="score-card-mark">${mark}</span>${(r.wins && r.wins[p.id]) || 0}`;
    card.appendChild(wins);

    el.appendChild(card);
  }
}

/* ─── Render: Game over ────────────────────────────────────────── */

function renderGameOver() {
  const r = state.room;
  $('gameover-game-name').textContent = r.gameName || '';

  const title = $('gameover-title');
  const sub = $('gameover-sub');
  if (r.result && r.result.kind === 'win') {
    const winner = (r.players || []).find((p) => p.id === r.result.winnerId);
    if (winner) {
      const isYou = winner.id === state.playerId;
      title.textContent = isYou ? 'You win' : `${winner.name} wins`;
      sub.textContent = isYou ? 'Nice one.' : 'Better luck next round.';
    } else {
      title.textContent = 'Winner';
      sub.textContent = '';
    }
  } else if (r.result && r.result.kind === 'draw') {
    title.textContent = 'Draw';
    sub.textContent = 'Even game.';
  } else {
    title.textContent = 'Game over';
    sub.textContent = '';
  }

  renderScoreboard($('gameover-scores'), r);

  const isHost = r.hostId === state.playerId;
  $('play-again-btn').classList.toggle('hidden', !isHost || state.role === 'spectator');
  $('play-again-waiting').classList.toggle('hidden', isHost && state.role !== 'spectator');
}

/* ─── Picker ───────────────────────────────────────────────────── */

async function loadGameCatalog() {
  if (state.pickerLoaded) return;
  try {
    const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
    const res = await fetch(`${base}api/games`);
    state.games = await res.json();
    state.pickerLoaded = true;
  } catch {
    toast('Could not load games');
  }
}

function renderPicker() {
  const list = $('picker-list');
  list.innerHTML = '';
  for (const g of state.games) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'picker-tile';
    tile.disabled = !g.available;

    const name = document.createElement('span');
    name.className = 'picker-tile-name';
    name.textContent = g.name;
    tile.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'picker-tile-meta' + (g.available ? '' : ' picker-tile-soon');
    meta.textContent = g.available ? '' : 'Soon';
    tile.appendChild(meta);

    tile.addEventListener('click', () => {
      if (!g.available) return;
      const playerName = ($('player-name').value || '').trim();
      if (!playerName) { toast('Enter your name first'); $('player-name').focus(); return; }
      state.myName = playerName;
      send({ type: 'create_room', gameType: g.type, playerName });
    });
    list.appendChild(tile);
  }
}

/* ─── Wire up ──────────────────────────────────────────────────── */

function init() {
  connect();

  // Load the game catalog up front so the landing tiles are ready
  // by the time the user types their name.
  loadGameCatalog().then(renderPicker);

  $('join-btn').addEventListener('click', () => {
    const name = $('player-name').value.trim();
    const code = $('room-code-input').value.trim().toUpperCase();
    if (!name) { toast('Enter your name first'); $('player-name').focus(); return; }
    if (!/^[A-Z]{4}$/.test(code)) { toast('Enter a 4-letter code'); return; }
    state.myName = name;
    send({ type: 'join_room', roomCode: code, playerName: name });
  });

  $('room-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('room-leave-btn').addEventListener('click', () => send({ type: 'leave_room' }));
  $('game-leave-btn').addEventListener('click', () => {
    if (confirm('Leave the game?')) send({ type: 'leave_room' });
  });
  $('gameover-leave-btn').addEventListener('click', () => send({ type: 'leave_room' }));

  $('room-copy-btn').addEventListener('click', () => {
    const code = state.room && state.room.roomCode;
    if (!code) return;
    const url = `${location.origin}${location.pathname}`.replace(/\/$/, '') + '/';
    const text = `Join my Level 0 game: ${url} — code ${code}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('Copied invite'));
    } else {
      toast(`Code: ${code}`);
    }
  });

  $('start-btn').addEventListener('click', () => send({ type: 'start_game' }));
  $('add-bot-btn').addEventListener('click', () => send({ type: 'add_bot' }));
  $('play-again-btn').addEventListener('click', () => send({ type: 'play_again' }));
}

document.addEventListener('DOMContentLoaded', init);
