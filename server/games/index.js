const TicTacToe = require('./TicTacToe');
const FourInARow = require('./FourInARow');
const DotsAndBoxes = require('./DotsAndBoxes');
const Mafia = require('./Mafia');
const TexasHoldem = require('./poker/TexasHoldem');

// Registry of game types. `available: false` keeps a tile visible in
// the picker but disabled — useful for "coming soon" before we ship a
// game. The Room looks up a game class by `type` and instantiates it
// with (players, broadcast, onEnd, opts).
//
// Optional keys:
//   noBots         – the game can't be played with bots at all.
//   handlesDisconnect – mid-game drops get a reconnect grace window.
//   options        – host-chosen room settings. Each entry declares its
//                    allowed `choices` and a `default`; the Room
//                    validates against this, so nothing a client sends
//                    can widen it. `tableSize` also drives seat count.
//   fillWithBots   – empty seats are topped up with bots when the host
//                    starts, instead of being added one at a time.
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
  holdem: {
    type: 'holdem',
    name: "Texas Hold'em",
    tagline: 'Tournament poker. Everyone starts with $1M.',
    // One real player is enough — the rest of the table fills with AI.
    minPlayers: 1,
    maxPlayers: 9,
    available: true,
    options: {
      tableSize: { label: 'Table size', choices: [5, 9], default: 9, suffix: 'seats' },
    },
    fillWithBots: true,
    GameClass: TexasHoldem,
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
