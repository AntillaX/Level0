// Standard 3×3 tic-tac-toe.
//
// State:
//   board       – array of 9 cells, each null | 'X' | 'O'
//   marks       – { [playerId]: 'X' | 'O' } assigned at start()
//   order       – playerIds in seating order (matches lobby order)
//   currentIdx  – whose turn it is, indexed into `order`
//   moves       – appended history of { playerId, cell, mark }
//   status      – 'playing' | 'finished'
//   result      – { kind: 'win', winnerId, line } | { kind: 'draw' } | null
//   wins        – { [playerId]: count } persists across replays in same room

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

class TicTacToe {
  constructor(players, broadcast, onEnd, opts = {}) {
    this.players = players;
    this.broadcast = broadcast;
    this.onEnd = onEnd;

    this.order = players.map((p) => p.id);
    this.marks = {};
    // Carry a running win tally across replays in the same room.
    // The Room owns the canonical map (this.persistentWins) and
    // hands it to each new Game instance so Play Again doesn't
    // reset the scoreboard.
    const prevWins = opts.wins || {};
    this.wins = {};
    for (const p of players) this.wins[p.id] = prevWins[p.id] || 0;

    this.board = Array(9).fill(null);
    this.currentIdx = 0;
    this.moves = [];
    this.status = 'playing';
    this.result = null;
  }

  // Randomly assign X/O so it isn't always the host on X. X moves first
  // by convention, so this also decides who starts.
  assignMarks() {
    const ids = [...this.order];
    if (Math.random() < 0.5) ids.reverse();
    this.marks[ids[0]] = 'X';
    this.marks[ids[1]] = 'O';
    // currentIdx points at whoever has 'X'
    this.currentIdx = this.order.indexOf(ids[0]);
  }

  start() {
    this.board = Array(9).fill(null);
    this.moves = [];
    this.status = 'playing';
    this.result = null;
    this.assignMarks();

    this.broadcast({
      type: 'game_started',
      gameType: 'tictactoe',
      ...this.getFullState(),
    });

    this.maybeTriggerBot();
  }

  currentPlayerId() {
    return this.order[this.currentIdx];
  }

  handleAction(playerId, action) {
    if (!action || action.kind !== 'place') {
      return { success: false, error: 'Unknown action' };
    }
    if (this.status !== 'playing') {
      return { success: false, error: 'Game is over' };
    }
    if (playerId !== this.currentPlayerId()) {
      return { success: false, error: 'Not your turn' };
    }
    const cell = Number(action.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      return { success: false, error: 'Invalid cell' };
    }
    if (this.board[cell] !== null) {
      return { success: false, error: 'Cell taken' };
    }

    const mark = this.marks[playerId];
    this.board[cell] = mark;
    this.moves.push({ playerId, cell, mark });

    const winLine = this.findWinLine(mark);
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
      lastMove: { playerId, cell, mark },
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

  findWinLine(mark) {
    for (const line of WIN_LINES) {
      if (line.every((i) => this.board[i] === mark)) return line;
    }
    return null;
  }

  // ── Bot ──────────────────────────────────────────────────────────
  // Smart-but-beatable: take a winning move, block an opponent
  // winning move, prefer center, then a random corner, then
  // anything else. No deep lookahead, so it can be set up with
  // forks — feels chill rather than impossible.

  maybeTriggerBot() {
    const currentId = this.currentPlayerId();
    const current = this.players.find((p) => p.id === currentId);
    if (!current || !current.isBot || this.status !== 'playing') return;
    if (this.botTimer) clearTimeout(this.botTimer);
    // The first move feels like a hang if the bot waits its full
    // beat — play snappier when the board is empty, then slow to
    // a "thinking" pace once there's something to react to.
    const delay = this.moves.length === 0 ? 350 : 750;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.status !== 'playing') return;
      const cell = this.botPickCell(currentId);
      if (cell !== -1) this.handleAction(currentId, { kind: 'place', cell });
    }, delay);
  }

  // External end (forfeit / opponent left). winnerId may be null
  // for an abandoned round.
  endGame(reason, winnerId) {
    if (this.status === 'finished') return;
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.status = 'finished';
    if (winnerId) {
      this.result = { kind: 'win', winnerId, line: null, by: reason };
      this.wins[winnerId] = (this.wins[winnerId] || 0) + 1;
    } else {
      this.result = { kind: 'abandoned', by: reason };
    }
    this.broadcast({
      type: 'game_update',
      lastMove: null,
      ...this.getFullState(),
    });
    this.broadcast({
      type: 'game_over',
      result: this.result,
      wins: this.wins,
    });
    if (this.onEnd) this.onEnd();
  }

  botPickCell(botId) {
    const myMark = this.marks[botId];
    const oppMark = myMark === 'X' ? 'O' : 'X';
    const empties = [];
    for (let i = 0; i < 9; i++) if (this.board[i] === null) empties.push(i);
    if (empties.length === 0) return -1;

    // 1. Win this turn.
    for (const i of empties) {
      this.board[i] = myMark;
      const wins = !!this.findWinLine(myMark);
      this.board[i] = null;
      if (wins) return i;
    }
    // 2. Block opponent's winning move.
    for (const i of empties) {
      this.board[i] = oppMark;
      const wins = !!this.findWinLine(oppMark);
      this.board[i] = null;
      if (wins) return i;
    }
    // 3. Center.
    if (this.board[4] === null) return 4;
    // 4. A random open corner.
    const corners = [0, 2, 6, 8].filter((i) => this.board[i] === null);
    if (corners.length) return corners[Math.floor(Math.random() * corners.length)];
    // 5. Anything else.
    return empties[Math.floor(Math.random() * empties.length)];
  }

  getFullState() {
    return {
      gameType: 'tictactoe',
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

module.exports = TicTacToe;
