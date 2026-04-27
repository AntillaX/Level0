const TicTacToe = require('./TicTacToe');
const FourInARow = require('./FourInARow');

// Registry of game types. `available: false` keeps a tile visible in
// the picker but disabled — useful for "coming soon" before we ship a
// game. The Room looks up a game class by `type` and instantiates it
// with (players, broadcast).
const GAMES = {
  tictactoe: {
    type: 'tictactoe',
    name: 'Tic-Tac-Toe',
    tagline: 'Three in a row.',
    minPlayers: 2,
    maxPlayers: 2,
    available: true,
    GameClass: TicTacToe,
  },
  fourinarow: {
    type: 'fourinarow',
    name: 'Four in a Row',
    tagline: 'Drop, stack, connect four.',
    minPlayers: 2,
    maxPlayers: 2,
    available: true,
    GameClass: FourInARow,
  },
};

function isValidGameType(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(GAMES, t);
}

module.exports = { GAMES, isValidGameType };
