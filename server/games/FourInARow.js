// Four in a Row (a.k.a. Connect Four) — 7 columns × 6 rows. Two
// players take turns dropping a token into a column; tokens fall
// to the lowest empty row. First to make four in a row horizontally,
// vertically, or diagonally wins.
//
// Board indexing: 42-cell flat array, row * COLS + col, with row 0
// at the top and row 5 at the bottom. Dropping into column c finds
// the highest row index that's still empty in that column.
//
// Marks: 'A' / 'B'. The client maps these to gold / rust tokens.

const COLS = 7;
const ROWS = 6;
const TOTAL = COLS * ROWS;

class FourInARow {
  constructor(players, broadcast, onEnd, opts = {}) {
    this.players = players;
    this.broadcast = broadcast;
    this.onEnd = onEnd;

    this.order = players.map((p) => p.id);
    this.marks = {};

    // Carry the win tally across replays in the same room (handed in
    // by Room.persistentWins).
    const prevWins = opts.wins || {};
    this.wins = {};
    for (const p of players) this.wins[p.id] = prevWins[p.id] || 0;

    this.board = Array(TOTAL).fill(null);
    this.currentIdx = 0;
    this.moves = [];
    this.status = 'playing';
    this.result = null;
  }

  // Random A/B assignment so the host doesn't always drop first.
  // 'A' moves first by convention.
  assignMarks() {
    const ids = [...this.order];
    if (Math.random() < 0.5) ids.reverse();
    this.marks[ids[0]] = 'A';
    this.marks[ids[1]] = 'B';
    this.currentIdx = this.order.indexOf(ids[0]);
  }

  start() {
    this.board = Array(TOTAL).fill(null);
    this.moves = [];
    this.status = 'playing';
    this.result = null;
    this.assignMarks();

    this.broadcast({
      type: 'game_started',
      gameType: 'fourinarow',
      ...this.getFullState(),
    });

    this.maybeTriggerBot();
  }

  currentPlayerId() {
    return this.order[this.currentIdx];
  }

  // Returns the row a token would land in for `col`, or -1 if full.
  // Scan from the bottom row upward — the first empty row is the
  // landing slot.
  landingRow(col) {
    for (let row = ROWS - 1; row >= 0; row--) {
      if (this.board[row * COLS + col] === null) return row;
    }
    return -1;
  }

  handleAction(playerId, action) {
    if (!action || action.kind !== 'drop') {
      return { success: false, error: 'Unknown action' };
    }
    if (this.status !== 'playing') {
      return { success: false, error: 'Game is over' };
    }
    if (playerId !== this.currentPlayerId()) {
      return { success: false, error: 'Not your turn' };
    }
    const col = Number(action.col);
    if (!Number.isInteger(col) || col < 0 || col >= COLS) {
      return { success: false, error: 'Invalid column' };
    }
    const row = this.landingRow(col);
    if (row === -1) {
      return { success: false, error: 'Column is full' };
    }

    const mark = this.marks[playerId];
    const cell = row * COLS + col;
    this.board[cell] = mark;
    this.moves.push({ playerId, cell, row, col, mark });

    const winLine = findWinAt(this.board, row, col, mark);
    if (winLine) {
      this.status = 'finished';
      this.result = { kind: 'win', winnerId: playerId, line: winLine };
      this.wins[playerId] = (this.wins[playerId] || 0) + 1;
    } else if (this.board.every((c) => c !== null)) {
      this.status = 'finished';
      this.result = { kind: 'draw' };
    } else {
      this.currentIdx = (this.currentIdx + 1) % this.order.length;
    }

    this.broadcast({
      type: 'game_update',
      lastMove: { playerId, cell, row, col, mark },
      ...this.getFullState(),
    });

    if (this.status === 'finished') {
      this.broadcast({
        type: 'game_over',
        result: this.result,
        wins: this.wins,
      });
      if (this.onEnd) this.onEnd();
    } else {
      this.maybeTriggerBot();
    }

    return { success: true };
  }

  // ── Bot ──────────────────────────────────────────────────────────
  // Same shape as TTT's bot: take a winning drop, block opponent's
  // winning drop, prefer the centre column, then random valid column.
  // No deeper lookahead — the game stays beatable for a thoughtful
  // human.

  maybeTriggerBot() {
    const currentId = this.currentPlayerId();
    const current = this.players.find((p) => p.id === currentId);
    if (!current || !current.isBot || this.status !== 'playing') return;
    if (this.botTimer) clearTimeout(this.botTimer);
    const delay = this.moves.length === 0 ? 350 : 750;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.status !== 'playing') return;
      const col = this.botPickCol(currentId);
      if (col !== -1) this.handleAction(currentId, { kind: 'drop', col });
    }, delay);
  }

  botPickCol(botId) {
    const myMark = this.marks[botId];
    const oppMark = myMark === 'A' ? 'B' : 'A';
    const validCols = [];
    for (let c = 0; c < COLS; c++) if (this.landingRow(c) !== -1) validCols.push(c);
    if (validCols.length === 0) return -1;

    // 1. Win this turn.
    for (const c of validCols) {
      const r = this.landingRow(c);
      this.board[r * COLS + c] = myMark;
      const wins = !!findWinAt(this.board, r, c, myMark);
      this.board[r * COLS + c] = null;
      if (wins) return c;
    }
    // 2. Block opponent's winning drop.
    for (const c of validCols) {
      const r = this.landingRow(c);
      this.board[r * COLS + c] = oppMark;
      const wins = !!findWinAt(this.board, r, c, oppMark);
      this.board[r * COLS + c] = null;
      if (wins) return c;
    }
    // 3. Prefer centre, then 2/4, then 1/5, then 0/6 — same intuition
    //    as a casual player. Within a tier, pick at random.
    const tiers = [[3], [2, 4], [1, 5], [0, 6]];
    for (const tier of tiers) {
      const open = tier.filter((c) => validCols.includes(c));
      if (open.length) return open[Math.floor(Math.random() * open.length)];
    }
    return validCols[Math.floor(Math.random() * validCols.length)];
  }

  getFullState() {
    return {
      gameType: 'fourinarow',
      cols: COLS,
      rows: ROWS,
      board: this.board,
      marks: this.marks,
      order: this.order,
      currentTurn: this.currentPlayerId(),
      status: this.status,
      result: this.result,
      wins: this.wins,
      moveCount: this.moves.length,
    };
  }

  destroy() {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }
}

// Walk the four directions through (row, col). For each direction,
// extend forward and backward as long as cells match the same mark,
// and return the first 4 cells of the run if the total is ≥ 4.
function findWinAt(board, row, col, mark) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells = [row * COLS + col];
    for (let k = 1; k < 4; k++) {
      const r = row + dr * k, c = col + dc * k;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[r * COLS + c] !== mark) break;
      cells.push(r * COLS + c);
    }
    for (let k = 1; k < 4; k++) {
      const r = row - dr * k, c = col - dc * k;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[r * COLS + c] !== mark) break;
      cells.unshift(r * COLS + c);
    }
    if (cells.length >= 4) return cells.slice(0, 4);
  }
  return null;
}

module.exports = FourInARow;
