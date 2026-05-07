const TicTacToe = require('./TicTacToe');
const FourInARow = require('./FourInARow');
const DotsAndBoxes = require('./DotsAndBoxes');
const Mafia = require('./Mafia');

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
  dotsandboxes: {
    type: 'dotsandboxes',
    name: 'Dots & Boxes',
    tagline: 'Close more squares than your opponent.',
    minPlayers: 2,
    maxPlayers: 2,
    available: true,
    GameClass: DotsAndBoxes,
  },
  mafia: {
    type: 'mafia',
    name: 'Mafia',
    tagline: 'Hidden roles. Discuss, accuse, vote.',
    minPlayers: 5,
    maxPlayers: 10,
    available: true,
    // No bots — Mafia is fundamentally a social game. Bots can't bluff
    // or read tells, so a bot-filled Mafia game would be broken.
    noBots: true,
    // Mid-game disconnects don't end the round immediately — the
    // Room gives the player a 20s grace window to reconnect (a tab
    // refresh is the common case). After grace, the round abandons
    // like any other game.
    handlesDisconnect: true,
    GameClass: Mafia,
  },
};

function isValidGameType(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(GAMES, t);
}

module.exports = { GAMES, isValidGameType };
