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
  constructor(players, broadcast, onEnd) {
    this.players = players;
    this.broadcast = broadcast;
    this.onEnd = onEnd;

    this.order = players.map((p) => p.id);
    this.marks = {};
    this.wins = {};
    for (const p of players) this.wins[p.id] = 0;

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
    }

    return { success: true };
  }

  findWinLine(mark) {
    for (const line of WIN_LINES) {
      if (line.every((i) => this.board[i] === mark)) return line;
    }
    return null;
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
    // No timers/intervals to clean up; method exists for the Room
    // contract so future games (timed turns, etc.) can hook in.
  }
}

module.exports = TicTacToe;
