// Dots and Boxes — classic pencil game.
// 5×5 boxes (6×6 dots). Players take turns drawing a single line
// between two adjacent dots. Completing the 4th side of a box claims
// it (your color) AND grants another turn. Game ends when every line
// is drawn; most boxes wins.
//
// Indexing (size = N):
//   hLines: horizontal segments. row r ∈ [0, N], col c ∈ [0, N).
//           Index = r * N + c. There are (N+1) * N entries.
//           A horizontal at (r, c) connects dot (r, c) to dot (r, c+1).
//   vLines: vertical segments. row r ∈ [0, N), col c ∈ [0, N].
//           Index = r * (N+1) + c. There are N * (N+1) entries.
//           A vertical at (r, c) connects dot (r, c) to dot (r+1, c).
//   boxes:  N × N. Index = r * N + c. Sides are
//           top    = hLines[r*N + c]
//           bottom = hLines[(r+1)*N + c]
//           left   = vLines[r*(N+1) + c]
//           right  = vLines[r*(N+1) + (c+1)]
//
// Marks (player labels) are 'A' / 'B'; the client maps to gold / rust.

const SIZE = 5;

class DotsAndBoxes {
  constructor(players, broadcast, onEnd, opts = {}) {
    this.players = players;
    this.broadcast = broadcast;
    this.onEnd = onEnd;
    this.size = SIZE;

    this.order = players.map((p) => p.id);
    this.marks = {};

    const prevWins = opts.wins || {};
    this.wins = {};
    for (const p of players) this.wins[p.id] = prevWins[p.id] || 0;

    this.hLines = Array(this.size * (this.size + 1)).fill(null);
    this.vLines = Array((this.size + 1) * this.size).fill(null);
    this.boxes = Array(this.size * this.size).fill(null);
    this.scores = {};
    for (const p of players) this.scores[p.id] = 0;

    this.currentIdx = 0;
    this.moves = [];
    this.status = 'playing';
    this.result = null;
  }

  assignMarks() {
    const ids = [...this.order];
    if (Math.random() < 0.5) ids.reverse();
    this.marks[ids[0]] = 'A';
    this.marks[ids[1]] = 'B';
    this.currentIdx = this.order.indexOf(ids[0]);
  }

  start() {
    const N = this.size;
    this.hLines = Array(N * (N + 1)).fill(null);
    this.vLines = Array((N + 1) * N).fill(null);
    this.boxes = Array(N * N).fill(null);
    for (const p of this.players) this.scores[p.id] = 0;
    this.moves = [];
    this.status = 'playing';
    this.result = null;
    this.assignMarks();

    this.broadcast({
      type: 'game_started',
      gameType: 'dotsandboxes',
      ...this.getFullState(),
    });

    this.maybeTriggerBot();
  }

  currentPlayerId() {
    return this.order[this.currentIdx];
  }

  handleAction(playerId, action) {
    if (!action || action.kind !== 'line') {
      return { success: false, error: 'Unknown action' };
    }
    if (this.status !== 'playing') {
      return { success: false, error: 'Game is over' };
    }
    if (playerId !== this.currentPlayerId()) {
      return { success: false, error: 'Not your turn' };
    }

    const N = this.size;
    const orient = action.orientation;
    const row = Number(action.row);
    const col = Number(action.col);

    let lines, idx;
    if (orient === 'h') {
      if (!Number.isInteger(row) || row < 0 || row > N) return { success: false, error: 'Invalid row' };
      if (!Number.isInteger(col) || col < 0 || col >= N) return { success: false, error: 'Invalid col' };
      lines = this.hLines;
      idx = row * N + col;
    } else if (orient === 'v') {
      if (!Number.isInteger(row) || row < 0 || row >= N) return { success: false, error: 'Invalid row' };
      if (!Number.isInteger(col) || col < 0 || col > N) return { success: false, error: 'Invalid col' };
      lines = this.vLines;
      idx = row * (N + 1) + col;
    } else {
      return { success: false, error: 'Invalid orientation' };
    }

    if (lines[idx] !== null) {
      return { success: false, error: 'Line already drawn' };
    }

    const mark = this.marks[playerId];
    lines[idx] = mark;
    this.moves.push({ playerId, orientation: orient, row, col, mark });

    // Adjacent boxes that might have just been completed.
    const claimed = [];
    const adj = adjacentBoxes(orient, row, col, N);
    for (const [br, bc] of adj) {
      const bIdx = br * N + bc;
      if (this.boxes[bIdx] === null && this.isBoxComplete(br, bc)) {
        this.boxes[bIdx] = mark;
        this.scores[playerId] = (this.scores[playerId] || 0) + 1;
        claimed.push(bIdx);
      }
    }

    // End-of-game check (all boxes claimed).
    const totalBoxes = N * N;
    const claimedTotal = this.boxes.reduce((n, b) => n + (b !== null ? 1 : 0), 0);
    if (claimedTotal === totalBoxes) {
      this.status = 'finished';
      this.result = this.computeResult();
      if (this.result.kind === 'win') {
        this.wins[this.result.winnerId] = (this.wins[this.result.winnerId] || 0) + 1;
      }
    } else if (claimed.length === 0) {
      // No box claimed → turn passes.
      this.currentIdx = (this.currentIdx + 1) % this.order.length;
    }
    // claimed.length > 0 → same player goes again.

    this.broadcast({
      type: 'game_update',
      lastMove: { playerId, orientation: orient, row, col, mark },
      claimed,
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

  isBoxComplete(r, c) {
    const N = this.size;
    return this.hLines[r * N + c] !== null
      && this.hLines[(r + 1) * N + c] !== null
      && this.vLines[r * (N + 1) + c] !== null
      && this.vLines[r * (N + 1) + (c + 1)] !== null;
  }

  boxSideCount(r, c) {
    const N = this.size;
    let n = 0;
    if (this.hLines[r * N + c] !== null) n++;
    if (this.hLines[(r + 1) * N + c] !== null) n++;
    if (this.vLines[r * (N + 1) + c] !== null) n++;
    if (this.vLines[r * (N + 1) + (c + 1)] !== null) n++;
    return n;
  }

  computeResult() {
    const ids = Object.keys(this.scores);
    const top = Math.max(...ids.map((id) => this.scores[id]));
    const tied = ids.filter((id) => this.scores[id] === top);
    if (tied.length === 1) {
      return { kind: 'win', winnerId: tied[0], scores: { ...this.scores } };
    }
    return { kind: 'draw', scores: { ...this.scores } };
  }

  // ── Bot ──────────────────────────────────────────────────────────
  // 1. If any move completes a box, take it (greedy).
  // 2. Otherwise prefer a move that doesn't bring any box to 3 sides
  //    (since that hands the opponent a box next turn).
  // 3. Otherwise pick at random — there are no safe moves left.

  maybeTriggerBot() {
    const currentId = this.currentPlayerId();
    const current = this.players.find((p) => p.id === currentId);
    if (!current || !current.isBot || this.status !== 'playing') return;
    if (this.botTimer) clearTimeout(this.botTimer);
    const delay = this.moves.length === 0 ? 350 : 750;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.status !== 'playing') return;
      const move = this.botPickMove();
      if (move) this.handleAction(currentId, { kind: 'line', ...move });
    }, delay);
  }

  botPickMove() {
    const N = this.size;
    const allMoves = [];
    for (let r = 0; r <= N; r++) {
      for (let c = 0; c < N; c++) {
        if (this.hLines[r * N + c] === null) allMoves.push({ orientation: 'h', row: r, col: c });
      }
    }
    for (let r = 0; r < N; r++) {
      for (let c = 0; c <= N; c++) {
        if (this.vLines[r * (N + 1) + c] === null) allMoves.push({ orientation: 'v', row: r, col: c });
      }
    }
    if (allMoves.length === 0) return null;

    // 1. Take any move that completes a box.
    for (const m of allMoves) {
      if (this.moveCompletesBox(m)) return m;
    }
    // 2. Prefer moves that don't bring any adjacent box to 3 sides.
    const safe = allMoves.filter((m) => !this.moveSetsUpOpponent(m));
    if (safe.length) return safe[Math.floor(Math.random() * safe.length)];
    // 3. Pick anything — we're forced to give a box away.
    return allMoves[Math.floor(Math.random() * allMoves.length)];
  }

  moveCompletesBox(m) {
    const N = this.size;
    return this._withProvisionalLine(m, () => {
      for (const [br, bc] of adjacentBoxes(m.orientation, m.row, m.col, N)) {
        if (this.isBoxComplete(br, bc)) return true;
      }
      return false;
    });
  }

  moveSetsUpOpponent(m) {
    const N = this.size;
    return this._withProvisionalLine(m, () => {
      for (const [br, bc] of adjacentBoxes(m.orientation, m.row, m.col, N)) {
        if (this.boxSideCount(br, bc) === 3) return true;
      }
      return false;
    });
  }

  _withProvisionalLine(m, fn) {
    const N = this.size;
    const lines = m.orientation === 'h' ? this.hLines : this.vLines;
    const idx = m.orientation === 'h' ? m.row * N + m.col : m.row * (N + 1) + m.col;
    const orig = lines[idx];
    lines[idx] = 'TEMP';
    try { return fn(); } finally { lines[idx] = orig; }
  }

  getFullState() {
    return {
      gameType: 'dotsandboxes',
      size: this.size,
      hLines: this.hLines,
      vLines: this.vLines,
      boxes: this.boxes,
      scores: this.scores,
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

// Returns the [row, col] of boxes a horizontal/vertical line touches.
// h at (r, c) touches box (r-1, c) above and (r, c) below (if in range).
// v at (r, c) touches box (r, c-1) left  and (r, c) right (if in range).
function adjacentBoxes(orient, row, col, N) {
  const out = [];
  if (orient === 'h') {
    if (row > 0) out.push([row - 1, col]);
    if (row < N) out.push([row, col]);
  } else {
    if (col > 0) out.push([row, col - 1]);
    if (col < N) out.push([row, col]);
  }
  return out;
}

module.exports = DotsAndBoxes;
