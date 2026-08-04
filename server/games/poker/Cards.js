// Card representation and deck handling.
//
// A card is an integer 0-51 so the evaluator and the Monte Carlo
// simulator can work on plain numbers without allocating objects in
// hot loops. Encoding:
//
//   rank = card >> 2   (0 = deuce … 12 = ace)
//   suit = card & 3    (0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades)
//
// `toCode` turns one back into the wire format the client renders,
// e.g. 'As', 'Td', '2c'.

const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUIT_CHARS = ['c', 'd', 'h', 's'];

const RANK_NAMES = [
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace',
];

const RANK_NAMES_PLURAL = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

function rankOf(card) {
  return card >> 2;
}

function suitOf(card) {
  return card & 3;
}

function toCode(card) {
  return RANK_CHARS[card >> 2] + SUIT_CHARS[card & 3];
}

function fromCode(code) {
  const r = RANK_CHARS.indexOf(code[0].toUpperCase());
  const s = SUIT_CHARS.indexOf(code[1].toLowerCase());
  if (r < 0 || s < 0) return -1;
  return (r << 2) | s;
}

function freshDeck() {
  const deck = new Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  return deck;
}

// Fisher-Yates using crypto-grade randomness. Poker with play money
// still deserves a shuffle nobody can predict from prior hands —
// Math.random() is seeded per-process and observable in principle.
const crypto = require('crypto');

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

module.exports = {
  RANK_CHARS,
  SUIT_CHARS,
  RANK_NAMES,
  RANK_NAMES_PLURAL,
  rankOf,
  suitOf,
  toCode,
  fromCode,
  freshDeck,
  shuffle,
};
