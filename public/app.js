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

  // Last known wins map so we can detect changes and pulse the
  // score card belonging to whoever just won.
  lastWins: null,

  // Mafia-only: tracks whether the local user has tapped their
  // reveal card. We need this in addition to the server's revealed[]
  // list so re-renders triggered by other players' acks don't
  // un-flip the card during the round-trip.
  mafiaLocallyRevealed: false,
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
      // Auto-spectator: if the user tapped Join but the room was full
      // or already started, the server quietly seats them as a
      // spectator. Surface that with a toast so they know they aren't
      // playing this round.
      if (msg.type === 'spectator_joined') {
        toast('Game in progress — joined as spectator');
      }
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
    case 'bot_removed':
    // Mafia phase events — same merge+render handling.
    case 'reveal_progress':
    case 'night_started':
    case 'mafia_voted':
    case 'detective_done':
    case 'day_started':
    case 'day_voted':
    case 'day_resolved': {
      mergeRoomState(msg);
      renderForState();
      break;
    }

    case 'host_changed': {
      // The previous host left and someone else inherited the role.
      // Toast only the *new* host so they realise they have controls now.
      mergeRoomState(msg);
      if (msg.hostId === state.playerId) {
        toast("You're the host now");
      }
      renderForState();
      break;
    }

    case 'round_abandoned': {
      // A seated player left mid-game. Server has already cleared
      // the game and flipped the room back to 'lobby'. We toast the
      // survivors so they know why the screen changed.
      mergeRoomState(msg);
      const wasMe = msg.leftId === state.playerId;
      if (!wasMe) {
        const name = msg.leftName || 'Opponent';
        toast(`${name} left — back to lobby`);
      }
      renderForState();
      break;
    }

    case 'game_started': {
      // Fresh round → clear any per-round local flags. (Mafia's
      // local-reveal flag would otherwise carry over from the last
      // game and skip the role-flip animation.)
      state.mafiaLocallyRevealed = false;
      // Replace state.room rather than merging — game_started is a
      // full snapshot, and we want stale per-round fields from the
      // previous game (Mafia's detectiveResult, lastNightKill,
      // dayVotes, etc.) to drop. mergeRoomState only writes keys
      // present in `msg`, so a stale field that the new game omits
      // would otherwise persist.
      state.room = {};
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
      // Merge the full payload — Mafia's game_over carries the
      // final visibleRoles map (everyone's role revealed) plus the
      // updated alive/eliminations history that the gameover screen
      // renders. Without this, players who saw a stale visibleRoles
      // before the game ended got "?" placeholders for some roles
      // on the gameover screen.
      mergeRoomState(msg);
      const isLineWin = msg.result && msg.result.kind === 'win' && msg.result.line;
      setTimeout(goToGameOver, isLineWin ? 1200 : 400);
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
      state.mafiaLocallyRevealed = false;
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
    'moveCount', 'cols', 'rows', 'lastMove',
    // Dots & Boxes
    'size', 'hLines', 'vLines', 'boxes', 'scores',
    // Mafia
    'phase', 'round', 'alive', 'revealed', 'eliminations',
    'visibleRoles', 'myRole', 'mafiaVotes', 'detectiveTarget',
    'detectiveResult', 'lastNightKill', 'dayVotes', 'eliminated',
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
  // Mafia is a social-deduction game — bots can't bluff, so the
  // server rejects bot adds. Hide the button entirely for that game.
  const supportsBots = r.gameType !== 'mafia';
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
    addBotBtn.classList.toggle('hidden', roomFull || !supportsBots);
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
  fourinarow: renderFourInARow,
  dotsandboxes: renderDotsAndBoxes,
  mafia: renderMafia,
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
  // Mafia has its own players list (with role badges + alive state)
  // baked into the renderer — the generic mark/wins scoreboard at
  // the bottom is empty for it, so skip the render entirely.
  const scoreboardEl = $('scoreboard');
  if (r.gameType === 'mafia') {
    scoreboardEl.innerHTML = '';
  } else {
    renderScoreboard(scoreboardEl, r);
  }
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

  if (winLine) board.appendChild(buildWinLineSvg(winLine, board));

  stage.appendChild(board);
}

/* ─── Render: Four in a Row ────────────────────────────────────── */

// 7 columns × 6 rows. Flat 7×6 grid in row-major order — each cell
// is its own clickable target and the column-hover effect is wired
// up in JS via mouseover (CSS :has() works but isn't universally
// supported on older mobile browsers).
function renderFourInARow(stage, r) {
  const cols = r.cols || 7;
  const rows = r.rows || 6;
  const myMark = r.marks && r.marks[state.playerId];
  const isMyTurn = state.role === 'player' && r.currentTurn === state.playerId && r.status === 'playing';

  const banner = $('turn-banner');
  if (r.status === 'finished') {
    banner.textContent = '';
  } else if (isMyTurn) {
    banner.innerHTML = `Your turn — <span class="${markClass(myMark)}">●</span>`;
  } else {
    const turnPlayer = (r.players || []).find((p) => p.id === r.currentTurn);
    const turnMark = r.marks && r.marks[r.currentTurn];
    if (turnPlayer) {
      banner.innerHTML = `<span class="accent">${turnPlayer.name}</span> &middot; <span class="${markClass(turnMark)}">●</span>`;
    } else {
      banner.textContent = '…';
    }
  }

  const board = document.createElement('div');
  board.className = 'fr-board';
  board.style.setProperty('--fr-cols', cols);
  board.style.setProperty('--fr-rows', rows);
  // Color hint for the hover-preview disc (per-column ::before).
  if (myMark) board.classList.add(myMark === 'A' ? 'is-color-a' : 'is-color-b');

  const winSet = new Set((r.result && r.result.kind === 'win' && r.result.line) || []);
  const last = r.lastMove;

  // Track which columns are full so we can disable hover/click on them.
  const colFull = [];
  for (let c = 0; c < cols; c++) colFull[c] = topRow(r.board, c, rows, cols) === -1;

  // Cells in row-major order (top row first). Each cell carries its
  // column index so click handlers can route the drop to the right
  // column without needing a wrapping <button>.
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < cols; c++) {
      const idx = row * cols + c;
      const cell = document.createElement('div');
      cell.className = 'fr-cell';
      cell.dataset.col = String(c);
      const canPlayCol = !colFull[c] && isMyTurn;
      if (canPlayCol) cell.classList.add('is-clickable');
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `Column ${c + 1}`);

      const val = (r.board || [])[idx];
      if (val) {
        const token = document.createElement('div');
        token.className = `fr-token ${val === 'A' ? 'is-color-a' : 'is-color-b'}`;
        if (winSet.has(idx)) token.classList.add('is-winning');
        if (last && last.cell === idx) {
          token.classList.add('is-falling');
          token.style.setProperty('--fall-rows', row + 1);
        }
        cell.appendChild(token);
      }

      if (canPlayCol) {
        cell.addEventListener('click', () => {
          send({ type: 'game_action', action: { kind: 'drop', col: c } });
        });
      }
      board.appendChild(cell);
    }
  }

  // JS-driven column hover: on mouseover any cell, mark all cells in
  // the same column with .is-col-hover so we can light up the column
  // and float a preview disc above it.
  if (isMyTurn) {
    const setHover = (col) => {
      for (const el of board.querySelectorAll('.fr-cell.is-col-hover')) {
        el.classList.remove('is-col-hover');
      }
      board.removeAttribute('data-hover-col');
      board.style.removeProperty('--hover-col');
      if (col != null && !colFull[col]) {
        for (const el of board.querySelectorAll(`.fr-cell[data-col="${col}"]`)) {
          el.classList.add('is-col-hover');
        }
        board.dataset.hoverCol = String(col);
        // Used by the .fr-board::before preview disc to track the
        // hovered column (CSS calc reads --hover-col).
        board.style.setProperty('--hover-col', String(col));
      }
    };
    board.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('.fr-cell');
      setHover(cell ? Number(cell.dataset.col) : null);
    });
    board.addEventListener('mouseleave', () => setHover(null));
  }

  stage.appendChild(board);
}

function topRow(board, col, rows, cols) {
  for (let row = rows - 1; row >= 0; row--) {
    if ((board || [])[row * cols + col] === null || (board || [])[row * cols + col] === undefined) return row;
  }
  return -1;
}

// Map a per-game mark value to a CSS color class for in-game UI.
// TTT marks are 'X' / 'O' — uses .accent. FIAR marks are 'A' / 'B' —
// rendered as colored discs.
function markClass(m) {
  if (m === 'A') return 'is-color-a';
  if (m === 'B') return 'is-color-b';
  return 'accent';
}

/* ─── Render: Dots & Boxes ─────────────────────────────────────── */

// 5×5 boxes (6×6 dots) drawn as SVG. Coordinate system: viewBox 0..N,
// dots at integer (col, row) — so box (r, c) occupies the unit square
// from (c, r) to (c+1, r+1). Padding around the grid so dots don't
// touch the SVG edge. */
function renderDotsAndBoxes(stage, r) {
  const N = r.size || 5;
  const PAD = 0.35;
  const NS = 'http://www.w3.org/2000/svg';

  const myMark = r.marks && r.marks[state.playerId];
  const isMyTurn = state.role === 'player' && r.currentTurn === state.playerId && r.status === 'playing';

  const banner = $('turn-banner');
  if (r.status === 'finished') {
    banner.textContent = '';
  } else if (isMyTurn) {
    banner.innerHTML = `Your turn — <span class="${markClass(myMark)}">●</span>`;
  } else {
    const turnPlayer = (r.players || []).find((p) => p.id === r.currentTurn);
    const turnMark = r.marks && r.marks[r.currentTurn];
    if (turnPlayer) {
      banner.innerHTML = `<span class="accent">${turnPlayer.name}</span> &middot; <span class="${markClass(turnMark)}">●</span>`;
    } else {
      banner.textContent = '…';
    }
  }

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'db-board');
  svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${N + 2 * PAD} ${N + 2 * PAD}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Background panel (subtle gradient fill via CSS) — purely visual.
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('class', 'db-panel');
  bg.setAttribute('x', String(-PAD));
  bg.setAttribute('y', String(-PAD));
  bg.setAttribute('width', String(N + 2 * PAD));
  bg.setAttribute('height', String(N + 2 * PAD));
  bg.setAttribute('rx', '0.2');
  svg.appendChild(bg);

  const lastMove = r.lastMove;
  const isLast = (orient, row, col) =>
    lastMove && lastMove.orientation === orient && lastMove.row === row && lastMove.col === col;

  // ── Boxes (claimed fill) ──
  for (let row = 0; row < N; row++) {
    for (let c = 0; c < N; c++) {
      const owner = (r.boxes || [])[row * N + c];
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('class', 'db-box' + (owner ? ` is-claimed ${ownerClass(owner)}` : ''));
      rect.setAttribute('x', String(c + 0.05));
      rect.setAttribute('y', String(row + 0.05));
      rect.setAttribute('width', '0.9');
      rect.setAttribute('height', '0.9');
      rect.setAttribute('rx', '0.05');
      svg.appendChild(rect);
    }
  }

  // ── Drawn lines ──
  // Horizontal: hLines[row * N + col] for row 0..N, col 0..N-1.
  for (let row = 0; row <= N; row++) {
    for (let c = 0; c < N; c++) {
      const drawer = (r.hLines || [])[row * N + c];
      if (drawer) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', `db-line is-drawn ${ownerClass(drawer)}` + (isLast('h', row, c) ? ' is-last' : ''));
        line.setAttribute('x1', String(c));
        line.setAttribute('y1', String(row));
        line.setAttribute('x2', String(c + 1));
        line.setAttribute('y2', String(row));
        svg.appendChild(line);
      }
    }
  }
  // Vertical: vLines[row * (N+1) + col] for row 0..N-1, col 0..N.
  for (let row = 0; row < N; row++) {
    for (let c = 0; c <= N; c++) {
      const drawer = (r.vLines || [])[row * (N + 1) + c];
      if (drawer) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', `db-line is-drawn ${ownerClass(drawer)}` + (isLast('v', row, c) ? ' is-last' : ''));
        line.setAttribute('x1', String(c));
        line.setAttribute('y1', String(row));
        line.setAttribute('x2', String(c));
        line.setAttribute('y2', String(row + 1));
        svg.appendChild(line);
      }
    }
  }

  // ── Click targets for undrawn lines ──
  // Larger transparent rect over each undrawn segment so finger taps
  // are forgiving. Only attached when it's the local player's turn.
  if (isMyTurn) {
    const HIT_PAD = 0.22; // half-thickness of the click area
    for (let row = 0; row <= N; row++) {
      for (let c = 0; c < N; c++) {
        if ((r.hLines || [])[row * N + c]) continue;
        const hit = document.createElementNS(NS, 'rect');
        hit.setAttribute('class', `db-hit ${markClass(myMark)}`);
        hit.setAttribute('x', String(c + 0.1));
        hit.setAttribute('y', String(row - HIT_PAD));
        hit.setAttribute('width', '0.8');
        hit.setAttribute('height', String(HIT_PAD * 2));
        hit.dataset.orient = 'h';
        hit.dataset.row = String(row);
        hit.dataset.col = String(c);
        svg.appendChild(hit);
      }
    }
    for (let row = 0; row < N; row++) {
      for (let c = 0; c <= N; c++) {
        if ((r.vLines || [])[row * (N + 1) + c]) continue;
        const hit = document.createElementNS(NS, 'rect');
        hit.setAttribute('class', `db-hit ${markClass(myMark)}`);
        hit.setAttribute('x', String(c - HIT_PAD));
        hit.setAttribute('y', String(row + 0.1));
        hit.setAttribute('width', String(HIT_PAD * 2));
        hit.setAttribute('height', '0.8');
        hit.dataset.orient = 'v';
        hit.dataset.row = String(row);
        hit.dataset.col = String(c);
        svg.appendChild(hit);
      }
    }

    svg.addEventListener('click', (e) => {
      const hit = e.target.closest('.db-hit');
      if (!hit) return;
      send({
        type: 'game_action',
        action: {
          kind: 'line',
          orientation: hit.dataset.orient,
          row: Number(hit.dataset.row),
          col: Number(hit.dataset.col),
        },
      });
    });
  }

  // ── Dots (drawn last so they sit on top) ──
  for (let row = 0; row <= N; row++) {
    for (let c = 0; c <= N; c++) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'db-dot');
      dot.setAttribute('cx', String(c));
      dot.setAttribute('cy', String(row));
      dot.setAttribute('r', '0.07');
      svg.appendChild(dot);
    }
  }

  stage.appendChild(svg);
}

function ownerClass(mark) {
  return mark === 'A' ? 'is-color-a' : mark === 'B' ? 'is-color-b' : '';
}

/* ─── Render: Mafia ─────────────────────────────────────────────── */
//
// Mafia is rendered into the same #game-stage as the other games.
// The display branches on r.phase. Each phase shows a different
// view depending on the local player's role and alive status —
// state.room is already filtered by the server, so we just trust
// what's there.

function renderMafia(stage, r) {
  $('game-name-label').textContent = `Mafia · Round ${r.round || 1}`;
  const banner = $('turn-banner');
  banner.innerHTML = mafiaBannerHTML(r);

  const wrap = document.createElement('div');
  wrap.className = 'mafia';
  if (r.phase === 'reveal') wrap.appendChild(renderMafiaReveal(r));
  else if (r.phase === 'night') wrap.appendChild(renderMafiaNight(r));
  else if (r.phase === 'day') wrap.appendChild(renderMafiaDay(r));
  wrap.appendChild(renderMafiaPlayers(r));
  // In-game round history accordion. Collapsed by default; appears
  // once at least one elimination has happened.
  if ((r.eliminations || []).length > 0) {
    wrap.appendChild(renderMafiaHistory(r));
  }

  stage.appendChild(wrap);
}

function mafiaBannerHTML(r) {
  if (r.phase === 'reveal') {
    const acked = (r.revealed || []).length;
    const total = (r.players || []).length;
    return `Reveal your role <span class="dim">(${acked}/${total} ready)</span>`;
  }
  if (r.phase === 'night') return `<span class="accent">Night</span> falls`;
  if (r.phase === 'day') return `<span class="accent">Day</span> ${r.round || 1}`;
  return '';
}

// Card flips on tap to show the local player's secret role.
function renderMafiaReveal(r) {
  const wrap = document.createElement('div');
  wrap.className = 'mafia-reveal';

  const me = (r.players || []).find((p) => p.id === state.playerId);
  const role = r.myRole;
  // Local + server-confirmed ack. Without the local flag, an
  // incoming state update from another player's ack causes a
  // re-render that builds a fresh card without is-flipped — so a
  // card the user just tapped briefly un-flips before the server
  // round-trip lands.
  const serverAcked = (r.revealed || []).includes(state.playerId);
  const acked = serverAcked || state.mafiaLocallyRevealed;

  // Spectators don't get a role to flip — show a status card instead.
  if (state.role === 'spectator' || !role) {
    const note = document.createElement('div');
    note.className = 'mafia-reveal-card mafia-reveal-spectate';
    note.innerHTML = `<div class="mafia-reveal-front"><span class="dim">Spectating</span></div>`;
    wrap.appendChild(note);
    return wrap;
  }

  const card = document.createElement('div');
  card.className = 'mafia-reveal-card' + (acked ? ' is-flipped' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', acked ? `You are ${role}` : 'Tap to reveal your role');

  const inner = document.createElement('div');
  inner.className = 'mafia-reveal-inner';

  const front = document.createElement('div');
  front.className = 'mafia-reveal-front';
  front.innerHTML = `<span class="mafia-reveal-eyebrow">Your role</span><span class="mafia-reveal-tap">Tap to reveal</span>`;
  inner.appendChild(front);

  const back = document.createElement('div');
  back.className = `mafia-reveal-back is-role-${role}`;
  back.appendChild(roleBadge(role));
  const flavor = document.createElement('p');
  flavor.className = 'mafia-reveal-flavor';
  flavor.innerHTML = roleFlavor(role, r);
  back.appendChild(flavor);
  inner.appendChild(back);

  card.appendChild(inner);

  const handler = () => {
    if (card.classList.contains('is-flipped')) return;
    card.classList.add('is-flipped');
    state.mafiaLocallyRevealed = true;
    // Server tracks the ack — flip locally first for snappy feel,
    // then notify the server so the count progresses.
    send({ type: 'game_action', action: { kind: 'reveal_ack' } });
  };
  card.addEventListener('click', handler);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
  wrap.appendChild(card);
  return wrap;
}

function roleFlavor(role, r) {
  if (role === 'mafia') {
    const teammates = (r.players || []).filter(
      (p) => p.id !== state.playerId && (r.visibleRoles || {})[p.id] === 'mafia'
    );
    if (teammates.length === 0) {
      return 'You are <strong>Mafia</strong>. You work alone — eliminate the town.';
    }
    const names = teammates.map((p) => `<strong class="is-color-mafia">${p.name}</strong>`).join(', ');
    return `You are <strong>Mafia</strong>. Your teammate${teammates.length > 1 ? 's' : ''}: ${names}.`;
  }
  if (role === 'detective') return 'You are the <strong>Detective</strong>. Each night, investigate one player.';
  return 'You are a <strong>Civilian</strong>. Find the Mafia and vote them out.';
}

function roleBadge(role) {
  const span = document.createElement('span');
  span.className = `mafia-role-badge is-role-${role}`;
  span.textContent = role.toUpperCase();
  return span;
}

// Night: mafia vote, detective investigates, civilians wait.
function renderMafiaNight(r) {
  const wrap = document.createElement('div');
  wrap.className = 'mafia-night';

  const role = r.myRole;
  const isAlive = (r.alive || {})[state.playerId];
  const isSpectator = state.role === 'spectator' || !role || !isAlive;

  // Mafia: see teammates' votes + cast your own.
  if (!isSpectator && role === 'mafia') {
    wrap.appendChild(renderNightMafiaVote(r));
  } else if (!isSpectator && role === 'detective') {
    wrap.appendChild(renderNightDetective(r));
  } else if (!isSpectator) {
    // Living civilian — just waits.
    wrap.appendChild(textCard('You are asleep.', 'The Mafia and the Detective are awake.'));
  } else {
    // Eliminated / spectator — show the omniscient view.
    wrap.appendChild(renderNightSpectator(r));
  }

  // Progress hint for everyone (how many night actions resolved).
  wrap.appendChild(nightProgress(r));
  return wrap;
}

function renderNightMafiaVote(r) {
  const card = document.createElement('div');
  card.className = 'mafia-card';
  card.appendChild(headingEl('Pick a target'));
  const sub = document.createElement('p');
  sub.className = 'mafia-card-sub';
  sub.textContent = 'When all mafia have voted, the most-voted target dies.';
  card.appendChild(sub);

  const myVote = (r.mafiaVotes || {})[state.playerId];
  const list = document.createElement('div');
  list.className = 'mafia-vote-list';
  const targets = (r.players || []).filter((p) => (r.alive || {})[p.id] && (r.visibleRoles || {})[p.id] !== 'mafia');
  for (const p of targets) {
    const btn = mafiaVoteButton(p, myVote === p.id, r.mafiaVotes || {});
    btn.addEventListener('click', () => {
      send({ type: 'game_action', action: { kind: 'mafia_vote', targetId: p.id } });
    });
    list.appendChild(btn);
  }
  card.appendChild(list);
  return card;
}

function renderNightDetective(r) {
  const card = document.createElement('div');
  card.className = 'mafia-card';
  card.appendChild(headingEl('Investigate someone'));

  // Show the result card only if it's from the *current* round —
  // otherwise the detective would be stuck on round 1's result and
  // unable to investigate again in round 2+.
  const result = r.detectiveResult;
  if (result && result.round === r.round) {
    const target = (r.players || []).find((p) => p.id === result.targetId);
    const verdict = document.createElement('p');
    verdict.className = 'mafia-detective-result';
    verdict.innerHTML = `<strong>${target ? target.name : '?'}</strong> is <strong class="${result.isMafia ? 'is-color-mafia' : 'accent'}">${result.isMafia ? 'Mafia' : 'NOT Mafia'}</strong>` +
      `<span class="dim"> · round ${result.round}</span>.`;
    card.appendChild(verdict);
    return card;
  }

  const sub = document.createElement('p');
  sub.className = 'mafia-card-sub';
  sub.textContent = 'Pick one player to investigate. The result is yours alone.';
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'mafia-vote-list';
  const targets = (r.players || []).filter((p) => (r.alive || {})[p.id] && p.id !== state.playerId);
  for (const p of targets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mafia-vote-btn';
    btn.innerHTML = `<span class="mafia-vote-name">${p.name}</span>`;
    btn.addEventListener('click', () => {
      send({ type: 'game_action', action: { kind: 'investigate', targetId: p.id } });
    });
    list.appendChild(btn);
  }
  card.appendChild(list);
  return card;
}

function renderNightSpectator(r) {
  const card = document.createElement('div');
  card.className = 'mafia-card';
  card.appendChild(headingEl('Night view'));

  // Mafia votes
  const mafiaVotes = r.mafiaVotes || {};
  const mafiaVoteEntries = Object.entries(mafiaVotes);
  if (mafiaVoteEntries.length) {
    const sub = document.createElement('p');
    sub.className = 'mafia-card-sub';
    sub.textContent = 'Mafia votes';
    card.appendChild(sub);
    const list = document.createElement('ul');
    list.className = 'mafia-spectate-list';
    for (const [voterId, targetId] of mafiaVoteEntries) {
      const voter = (r.players || []).find((p) => p.id === voterId);
      const target = (r.players || []).find((p) => p.id === targetId);
      const li = document.createElement('li');
      li.innerHTML = `<span class="is-color-mafia">${voter ? voter.name : '?'}</span> → ${target ? target.name : '?'}`;
      list.appendChild(li);
    }
    card.appendChild(list);
  }

  if (r.detectiveResult && r.detectiveResult.round === r.round) {
    const det = document.createElement('p');
    det.className = 'mafia-card-sub';
    const target = (r.players || []).find((p) => p.id === r.detectiveResult.targetId);
    det.innerHTML = `Detective investigated <strong>${target ? target.name : '?'}</strong> → ${r.detectiveResult.isMafia ? 'Mafia' : 'not Mafia'}`;
    card.appendChild(det);
  }
  return card;
}

function nightProgress(r) {
  const div = document.createElement('div');
  div.className = 'mafia-progress';
  // Mafia see only their own coordination — telling them whether
  // the detective has acted leaks info they shouldn't have.
  // Civilians and detective just see a generic "waiting" line.
  if (r.myRole === 'mafia') {
    const aliveMafia = (r.players || []).filter(
      (p) => (r.alive || {})[p.id] && (r.visibleRoles || {})[p.id] === 'mafia'
    );
    const mafiaDone = aliveMafia.filter((p) => (r.mafiaVotes || {})[p.id]).length;
    div.textContent = `Mafia votes: ${mafiaDone}/${aliveMafia.length}`;
  } else {
    div.textContent = 'Waiting on night actions…';
  }
  return div;
}

function renderMafiaDay(r) {
  const wrap = document.createElement('div');
  wrap.className = 'mafia-day';

  // Last night announcement
  if (r.lastNightKill) {
    const target = (r.players || []).find((p) => p.id === r.lastNightKill.targetId);
    const banner = document.createElement('div');
    banner.className = 'mafia-day-killed';
    banner.innerHTML = `<strong>${target ? target.name : '?'}</strong> was killed in the night — they were a <strong class="is-color-mafia">${r.lastNightKill.role}</strong>.`;
    wrap.appendChild(banner);
  }

  // "Town just voted" banner — only shows during the pause after a
  // vote resolves (server holds for ~3.5s before flipping to night).
  // Detected by looking for a day elimination matching the current
  // round, or by all-alive having voted with no resulting eliminate.
  const todayDayElim = (r.eliminations || []).find((e) => e.phase === 'day' && e.round === r.round);
  const allVoted = mafiaAllAliveDayVoted(r);
  if (todayDayElim) {
    const target = (r.players || []).find((p) => p.id === todayDayElim.targetId);
    const note = document.createElement('div');
    note.className = 'mafia-day-resolved';
    note.innerHTML = `Town voted: <strong>${target ? target.name : '?'}</strong> was eliminated — they were a <strong class="is-role-${todayDayElim.role}">${todayDayElim.role.toUpperCase()}</strong>.`;
    wrap.appendChild(note);
  } else if (allVoted) {
    const note = document.createElement('div');
    note.className = 'mafia-day-resolved';
    note.textContent = 'No consensus — no one was eliminated.';
    wrap.appendChild(note);
  }

  // Detective recap — shows the latest investigation result during
  // day so the detective can refer back to it during discussion.
  // Only the detective sees it (server filters detectiveResult to
  // them). Hidden after they die — there's no point in giving an
  // eliminated player extra UI.
  if (r.myRole === 'detective' && (r.alive || {})[state.playerId] && r.detectiveResult) {
    const target = (r.players || []).find((p) => p.id === r.detectiveResult.targetId);
    const card = document.createElement('div');
    card.className = 'mafia-detective-recap';
    card.innerHTML =
      `<span class="mafia-detective-recap-label">Your last investigation</span>` +
      `<span class="mafia-detective-recap-body">` +
        `<strong>${target ? target.name : '?'}</strong> ` +
        `is <strong class="${r.detectiveResult.isMafia ? 'is-color-mafia' : 'accent'}">` +
        `${r.detectiveResult.isMafia ? 'Mafia' : 'NOT Mafia'}</strong>` +
        `<span class="dim"> · round ${r.detectiveResult.round}</span>` +
      `</span>`;
    wrap.appendChild(card);
  }

  // Vote section (alive players only)
  const isAlive = (r.alive || {})[state.playerId];
  const role = r.myRole;
  const isSpectator = state.role === 'spectator' || !role || !isAlive;

  const card = document.createElement('div');
  card.className = 'mafia-card';
  if (!isSpectator) {
    card.appendChild(headingEl('Vote to eliminate'));
    const sub = document.createElement('p');
    sub.className = 'mafia-card-sub';
    sub.textContent = 'Discuss on voice. When everyone has voted, the most-voted player is eliminated. Tie → no elimination.';
    card.appendChild(sub);

    const myVote = (r.dayVotes || {})[state.playerId];
    const list = document.createElement('div');
    list.className = 'mafia-vote-list';
    const targets = (r.players || []).filter((p) => (r.alive || {})[p.id] && p.id !== state.playerId);
    for (const p of targets) {
      const btn = mafiaVoteButton(p, myVote === p.id, r.dayVotes || {});
      btn.addEventListener('click', () => {
        send({ type: 'game_action', action: { kind: 'day_vote', targetId: p.id } });
      });
      list.appendChild(btn);
    }
    // Skip option
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'mafia-vote-btn mafia-vote-skip' + (myVote === 'skip' ? ' is-mine' : '');
    skip.innerHTML = '<span class="mafia-vote-name">Skip</span>';
    skip.addEventListener('click', () => {
      send({ type: 'game_action', action: { kind: 'day_vote', targetId: 'skip' } });
    });
    list.appendChild(skip);
    card.appendChild(list);
  } else {
    card.appendChild(headingEl('Day votes'));
    const list = document.createElement('div');
    list.className = 'mafia-vote-list';
    const alive = (r.players || []).filter((p) => (r.alive || {})[p.id]);
    for (const p of alive) {
      const tally = countVotesFor(r.dayVotes || {}, p.id);
      const top = mafiaTopVoteCount(r.dayVotes || {});
      const div = document.createElement('div');
      div.className = 'mafia-vote-btn is-static';
      const countCls = 'mafia-vote-count'
        + (tally > 0 ? ' has-votes' : '')
        + (tally > 0 && tally === top ? ' is-leader' : '');
      div.innerHTML = `<span class="mafia-vote-name">${p.name}</span><span class="${countCls}">${tally}</span>`;
      list.appendChild(div);
    }
    card.appendChild(list);
  }
  wrap.appendChild(card);
  return wrap;
}

function mafiaVoteButton(targetPlayer, isMine, voteMap) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mafia-vote-btn' + (isMine ? ' is-mine' : '');
  const tally = countVotesFor(voteMap, targetPlayer.id);
  const top = mafiaTopVoteCount(voteMap);
  const countCls = 'mafia-vote-count'
    + (tally > 0 ? ' has-votes' : '')
    + (tally > 0 && tally === top ? ' is-leader' : '');
  btn.innerHTML =
    `<span class="mafia-vote-name">${targetPlayer.name}</span>` +
    `<span class="${countCls}">${tally}</span>`;
  return btn;
}

function mafiaTopVoteCount(voteMap) {
  let top = 0;
  const counts = {};
  for (const v of Object.values(voteMap)) {
    if (v === 'skip' || v === undefined) continue;
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > top) top = counts[v];
  }
  return top;
}

function countVotesFor(voteMap, targetId) {
  let n = 0;
  for (const v of Object.values(voteMap)) if (v === targetId) n++;
  return n;
}

function mafiaAllAliveDayVoted(r) {
  const aliveIds = (r.players || []).filter((p) => (r.alive || {})[p.id]).map((p) => p.id);
  if (aliveIds.length === 0) return false;
  const votes = r.dayVotes || {};
  return aliveIds.every((id) => votes[id] !== undefined);
}

function renderMafiaPlayers(r) {
  const list = document.createElement('div');
  list.className = 'mafia-players';
  for (const p of r.players || []) {
    const row = document.createElement('div');
    row.className = 'mafia-player' + ((r.alive || {})[p.id] ? '' : ' is-out');
    if (p.id === state.playerId) row.classList.add('is-self');

    const name = document.createElement('span');
    name.className = 'mafia-player-name';
    name.textContent = p.name + (p.id === state.playerId ? ' (you)' : '');
    row.appendChild(name);

    // Show role tag if visible to this viewer (own role / mafia
    // teammate / eliminated / spectator / finished — server filters
    // this). Special case for the reveal phase: hide your *own* role
    // badge until you've tapped the card. Otherwise the role is
    // spoiled in the players list before the reveal animation runs.
    const visibleRole = (r.visibleRoles || {})[p.id];
    const hideOwnDuringReveal =
      r.phase === 'reveal' &&
      p.id === state.playerId &&
      !state.mafiaLocallyRevealed;
    if (visibleRole && !hideOwnDuringReveal) {
      row.appendChild(roleBadge(visibleRole));
    } else if (!(r.alive || {})[p.id]) {
      const tag = document.createElement('span');
      tag.className = 'mafia-role-badge is-out';
      tag.textContent = 'OUT';
      row.appendChild(tag);
    }
    list.appendChild(row);
  }
  return list;
}

function textCard(title, sub) {
  const card = document.createElement('div');
  card.className = 'mafia-card mafia-card-quiet';
  card.appendChild(headingEl(title));
  if (sub) {
    const p = document.createElement('p');
    p.className = 'mafia-card-sub';
    p.textContent = sub;
    card.appendChild(p);
  }
  return card;
}

function headingEl(text) {
  const h = document.createElement('h3');
  h.className = 'mafia-card-heading';
  h.textContent = text;
  return h;
}

// Renders a winning-line SVG sized to the board's actual pixel
// dimensions. Coordinates are read via getBoundingClientRect so the
// line lands exactly on cell centers regardless of board size, gap,
// or padding — the previous "0..3 unit" coordinate space ignored
// the board padding/gap and produced a too-short, off-center line
// on wider viewports. We measure inside a rAF so the cells are
// guaranteed to be laid out.
function buildWinLineSvg(line, board) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ttt-winline');
  svg.setAttribute('preserveAspectRatio', 'none');

  const lineEl = document.createElementNS(NS, 'line');
  lineEl.setAttribute('class', 'ttt-winline-stroke');
  svg.appendChild(lineEl);

  requestAnimationFrame(() => {
    const cells = board.querySelectorAll('.ttt-cell');
    if (cells.length !== 9) return;
    const boardRect = board.getBoundingClientRect();
    const c1 = cells[line[0]].getBoundingClientRect();
    const c2 = cells[line[2]].getBoundingClientRect();

    const x1 = c1.left + c1.width  / 2 - boardRect.left;
    const y1 = c1.top  + c1.height / 2 - boardRect.top;
    const x2 = c2.left + c2.width  / 2 - boardRect.left;
    const y2 = c2.top  + c2.height / 2 - boardRect.top;

    svg.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);

    lineEl.setAttribute('x1', x1);
    lineEl.setAttribute('y1', y1);
    lineEl.setAttribute('x2', x2);
    lineEl.setAttribute('y2', y2);
    lineEl.style.strokeWidth = Math.max(7, boardRect.width * 0.022) + 'px';

    const len = Math.hypot(x2 - x1, y2 - y1);
    lineEl.style.setProperty('--len', len);
  });

  return svg;
}

function renderScoreboard(el, r) {
  el.innerHTML = '';
  if (!r.players) return;
  // Compare incoming wins to last seen so we can pulse the card of
  // whoever just got a point. Reset detection on a new room.
  const prev = state.lastWins || {};
  const curr = r.wins || {};
  for (const p of r.players) {
    const card = document.createElement('div');
    card.className = 'score-card';
    if (p.id === r.currentTurn && r.status === 'playing') card.classList.add('is-active');
    if ((curr[p.id] || 0) > (prev[p.id] || 0)) card.classList.add('is-celebrating');

    const name = document.createElement('span');
    name.className = 'score-card-name';
    name.textContent = p.id === state.playerId ? `${p.name} (you)` : p.name;
    card.appendChild(name);

    const wins = document.createElement('span');
    wins.className = 'score-card-wins';
    const mark = (r.marks && r.marks[p.id]) || '';
    // FIAR / D&B render the mark as a colored disc instead of the
    // bare 'A' / 'B' letter — the color carries the meaning.
    const isDisc = r.gameType === 'fourinarow' || r.gameType === 'dotsandboxes';
    const markEl = isDisc
      ? `<span class="score-card-mark fr-disc ${markClass(mark)}"></span>`
      : `<span class="score-card-mark">${mark}</span>`;
    // Dots & Boxes uses the within-round box count as the live score
    // while playing; the cross-round win tally lives on the game-
    // over screen. Other games just show the win tally.
    const liveScore = r.gameType === 'dotsandboxes' && r.status === 'playing'
      ? (r.scores && r.scores[p.id]) || 0
      : (r.wins && r.wins[p.id]) || 0;
    wins.innerHTML = `${markEl}${liveScore}`;
    card.appendChild(wins);

    el.appendChild(card);
  }
  state.lastWins = { ...curr };
}

/* ─── Render: Game over ────────────────────────────────────────── */

function renderGameOver() {
  const r = state.room;
  $('gameover-game-name').textContent = r.gameName || '';

  const title = $('gameover-title');
  const sub = $('gameover-sub');
  const scores = $('gameover-scores');
  scores.innerHTML = '';

  if (r.gameType === 'mafia' && r.result && r.result.kind === 'win') {
    // Mafia: winner is a *side*, not a person. Show side + the
    // event that ended the game + per-round history + roles.
    const side = r.result.winner;
    const onWinningSide = side === 'mafia'
      ? r.myRole === 'mafia'
      : r.myRole && r.myRole !== 'mafia';
    title.textContent = side === 'mafia' ? 'Mafia win' : 'Civilians win';
    if (state.role === 'spectator' || !r.myRole) {
      sub.textContent = side === 'mafia' ? 'The town fell.' : 'The town held.';
    } else {
      sub.textContent = onWinningSide ? 'Your side won.' : 'Your side lost.';
    }
    // Trigger event — what happened on the final action.
    const lastElim = (r.eliminations || [])[(r.eliminations || []).length - 1];
    if (lastElim) scores.appendChild(renderMafiaTriggerEvent(r, lastElim));
    scores.appendChild(renderMafiaRolesReveal(r));
    if ((r.eliminations || []).length > 0) {
      scores.appendChild(renderMafiaHistory(r));
    }
  } else if (r.result && r.result.kind === 'win') {
    const winner = (r.players || []).find((p) => p.id === r.result.winnerId);
    if (winner) {
      const isYou = winner.id === state.playerId;
      title.textContent = isYou ? 'You win' : `${winner.name} wins`;
      sub.textContent = isYou ? 'Nice one.' : 'Better luck next round.';
    } else {
      title.textContent = 'Winner';
      sub.textContent = '';
    }
    renderScoreboard(scores, r);
  } else if (r.result && r.result.kind === 'draw') {
    title.textContent = 'Draw';
    sub.textContent = 'Even game.';
    renderScoreboard(scores, r);
  } else {
    title.textContent = 'Game over';
    sub.textContent = '';
    renderScoreboard(scores, r);
  }

  const isHost = r.hostId === state.playerId;
  $('play-again-btn').classList.toggle('hidden', !isHost || state.role === 'spectator');
  $('play-again-waiting').classList.toggle('hidden', isHost && state.role !== 'spectator');
}

function renderMafiaRolesReveal(r) {
  const wrap = document.createElement('div');
  wrap.className = 'mafia-roles-reveal';
  for (const p of r.players || []) {
    const role = (r.visibleRoles || {})[p.id] || '?';
    const row = document.createElement('div');
    row.className = `mafia-roles-row is-role-${role}`;
    row.innerHTML = `<span class="mafia-roles-name">${p.name}</span>` +
      `<span class="mafia-role-badge is-role-${role}">${role.toUpperCase()}</span>`;
    wrap.appendChild(row);
  }
  return wrap;
}

function renderMafiaTriggerEvent(r, lastElim) {
  const target = (r.players || []).find((p) => p.id === lastElim.targetId);
  const div = document.createElement('div');
  div.className = 'mafia-trigger';
  const name = target ? target.name : '?';
  const phrase = lastElim.by === 'mafia'
    ? `<strong>${name}</strong> was killed in the night`
    : `<strong>${name}</strong> was voted out`;
  div.innerHTML = `${phrase} — they were a <strong class="is-role-${lastElim.role}">${lastElim.role.toUpperCase()}</strong>.`;
  return div;
}

// Per-round summary of what happened — kills + lynchings, in order.
// Helpful at the gameover screen for "wait who got voted out in
// round 2 again?" recap.
function renderMafiaHistory(r) {
  const wrap = document.createElement('details');
  wrap.className = 'mafia-history';
  const summary = document.createElement('summary');
  summary.className = 'mafia-history-summary';
  summary.textContent = 'Round-by-round history';
  wrap.appendChild(summary);

  const byRound = new Map();
  for (const e of r.eliminations || []) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  for (const round of rounds) {
    const block = document.createElement('div');
    block.className = 'mafia-history-round';
    const head = document.createElement('div');
    head.className = 'mafia-history-round-head';
    head.textContent = `Round ${round}`;
    block.appendChild(head);
    for (const e of byRound.get(round)) {
      const target = (r.players || []).find((p) => p.id === e.targetId);
      const line = document.createElement('div');
      line.className = 'mafia-history-line';
      const phrase = e.phase === 'night'
        ? `Night: <strong>${target ? target.name : '?'}</strong> was killed by the Mafia`
        : `Day: <strong>${target ? target.name : '?'}</strong> was voted out`;
      line.innerHTML = `${phrase} — <span class="mafia-role-badge is-role-${e.role}">${e.role.toUpperCase()}</span>`;
      block.appendChild(line);
    }
    wrap.appendChild(block);
  }
  return wrap;
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
  // Toggle the right-edge fade gradient based on whether the row
  // actually overflows. Done after layout via rAF.
  requestAnimationFrame(() => {
    const overflowing = list.scrollWidth > list.clientWidth + 1;
    const wrap = list.parentElement;
    if (wrap) wrap.classList.toggle('has-overflow', overflowing);
  });
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

  // Auto-focus the name input on first load, but skip when we
  // resumed a session so we don't yank the keyboard up after
  // a refresh into an active room.
  if (!loadSession()) {
    setTimeout(() => $('player-name').focus({ preventScroll: true }), 0);
  }

  const tryJoin = () => {
    const name = $('player-name').value.trim();
    const code = $('room-code-input').value.trim().toUpperCase();
    if (!name) { toast('Enter your name first'); $('player-name').focus(); return; }
    if (!/^[A-Z]{4}$/.test(code)) { toast('Enter a 4-letter code'); return; }
    state.myName = name;
    send({ type: 'join_room', roomCode: code, playerName: name });
  };
  $('join-btn').addEventListener('click', tryJoin);
  $('room-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryJoin(); }
  });

  $('room-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('room-leave-btn').addEventListener('click', () => send({ type: 'leave_room' }));
  $('game-leave-btn').addEventListener('click', () => {
    if (confirm('Leave the game?')) send({ type: 'leave_room' });
  });
  $('gameover-leave-btn').addEventListener('click', () => send({ type: 'leave_room' }));

  // Tap the code itself to copy — just the 4-letter code, no URL or
  // pre-canned message. Matches Auction's behaviour.
  $('room-code').addEventListener('click', () => {
    const code = state.room && state.room.roomCode;
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => toast(`Copied ${code}`));
    } else {
      toast(`Code: ${code}`);
    }
  });

  $('start-btn').addEventListener('click', () => send({ type: 'start_game' }));
  $('add-bot-btn').addEventListener('click', () => send({ type: 'add_bot' }));
  $('play-again-btn').addEventListener('click', () => send({ type: 'play_again' }));
}

document.addEventListener('DOMContentLoaded', init);
