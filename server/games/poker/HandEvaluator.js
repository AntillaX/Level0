// Poker hand evaluation for 5-, 6-, or 7-card sets.
//
// `evaluate` returns a single integer where a bigger number is a better
// hand, so comparing hands is just `>`. That matters because the AI's
// Monte Carlo simulator calls this tens of thousands of times per
// decision — no objects, no strings, no allocation in the hot path.
//
// Score layout (24 bits):
//
//   [category:4][k1:4][k2:4][k3:4][k4:4][k5:4]
//
// The kickers are rank indices (0 = deuce … 12 = ace) ordered by
// significance, which makes tie-breaks fall out of the integer compare
// for free.

const { RANK_NAMES, RANK_NAMES_PLURAL } = require('./Cards');

const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

function pack(cat, a = 0, b = 0, c = 0, d = 0, e = 0) {
  return (cat << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;
}

// Highest card of a straight present in `mask`, or -1. The wheel
// (A-2-3-4-5) is checked last and reports 3 (the five) as its high
// card, which is what makes it lose to every other straight.
function straightHigh(mask) {
  for (let top = 12; top >= 4; top--) {
    if (((mask >> (top - 4)) & 0x1f) === 0x1f) return top;
  }
  if ((mask & 0x100f) === 0x100f) return 3;
  return -1;
}

// The `count` highest ranks set in `mask`, high to low.
function topRanks(mask, count) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < count; r--) {
    if (mask & (1 << r)) out.push(r);
  }
  while (out.length < count) out.push(0);
  return out;
}

function evaluate(cards) {
  const n = cards.length;
  const rankCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  const suitMask = [0, 0, 0, 0];
  let mask = 0;

  for (let i = 0; i < n; i++) {
    const card = cards[i];
    const r = card >> 2;
    const s = card & 3;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    mask |= 1 << r;
  }

  // Flush first. With only 7 cards a flush cannot coexist with quads or
  // a full house (both would need more cards than we hold), so nothing
  // stronger can be hiding behind this early return.
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) {
      const fm = suitMask[s];
      const sf = straightHigh(fm);
      if (sf >= 0) return pack(CATEGORY.STRAIGHT_FLUSH, sf);
      const t = topRanks(fm, 5);
      return pack(CATEGORY.FLUSH, t[0], t[1], t[2], t[3], t[4]);
    }
  }

  // Group ranks by how many times they appear. Descending loop means
  // each bucket comes out already sorted high to low.
  let quad = -1;
  const trips = [];
  const pairs = [];
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c === 4) quad = r;
    else if (c === 3) trips.push(r);
    else if (c === 2) pairs.push(r);
  }

  if (quad >= 0) {
    const kicker = topRanks(mask & ~(1 << quad), 1)[0];
    return pack(CATEGORY.QUADS, quad, kicker);
  }

  // Two sets of trips is a full house using the higher as the trips and
  // the lower as the pair — a case that only shows up with 6+ cards.
  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    const tripRank = trips[0];
    const pairRank = trips.length > 1 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0];
    return pack(CATEGORY.FULL_HOUSE, tripRank, pairRank);
  }

  const st = straightHigh(mask);
  if (st >= 0) return pack(CATEGORY.STRAIGHT, st);

  if (trips.length > 0) {
    const t = trips[0];
    const k = topRanks(mask & ~(1 << t), 2);
    return pack(CATEGORY.TRIPS, t, k[0], k[1]);
  }

  if (pairs.length >= 2) {
    const hi = pairs[0];
    const lo = pairs[1];
    const kicker = topRanks(mask & ~(1 << hi) & ~(1 << lo), 1)[0];
    return pack(CATEGORY.TWO_PAIR, hi, lo, kicker);
  }

  if (pairs.length === 1) {
    const p = pairs[0];
    const k = topRanks(mask & ~(1 << p), 3);
    return pack(CATEGORY.PAIR, p, k[0], k[1], k[2]);
  }

  const t = topRanks(mask, 5);
  return pack(CATEGORY.HIGH_CARD, t[0], t[1], t[2], t[3], t[4]);
}

function categoryOf(score) {
  return score >> 20;
}

// Human-readable name for a score, shown at showdown.
function describe(score) {
  const cat = score >> 20;
  const a = (score >> 16) & 0xf;
  const b = (score >> 12) & 0xf;

  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return a === 12 ? 'Royal Flush' : `${RANK_NAMES[a]}-high Straight Flush`;
    case CATEGORY.QUADS:
      return `Four of a Kind, ${RANK_NAMES_PLURAL[a]}`;
    case CATEGORY.FULL_HOUSE:
      return `Full House, ${RANK_NAMES_PLURAL[a]} over ${RANK_NAMES_PLURAL[b]}`;
    case CATEGORY.FLUSH:
      return `${RANK_NAMES[a]}-high Flush`;
    case CATEGORY.STRAIGHT:
      return `${RANK_NAMES[a]}-high Straight`;
    case CATEGORY.TRIPS:
      return `Three of a Kind, ${RANK_NAMES_PLURAL[a]}`;
    case CATEGORY.TWO_PAIR:
      return `Two Pair, ${RANK_NAMES_PLURAL[a]} and ${RANK_NAMES_PLURAL[b]}`;
    case CATEGORY.PAIR:
      return `Pair of ${RANK_NAMES_PLURAL[a]}`;
    default:
      return `${RANK_NAMES[a]} High`;
  }
}

// Which 5 of the given cards actually make the hand — used to highlight
// the winning cards at showdown. Brute force over the 21 combinations
// of 7; only ever runs once per pot, so clarity beats cleverness.
function bestFive(cards) {
  if (cards.length <= 5) return { cards: cards.slice(), score: evaluate(cards) };
  let bestScore = -1;
  let best = null;
  const n = cards.length;
  const combo = [0, 0, 0, 0, 0];
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            combo[0] = cards[a]; combo[1] = cards[b]; combo[2] = cards[c];
            combo[3] = cards[d]; combo[4] = cards[e];
            const score = evaluate(combo);
            if (score > bestScore) {
              bestScore = score;
              best = combo.slice();
            }
          }
        }
      }
    }
  }
  return { cards: best, score: bestScore };
}

module.exports = { evaluate, describe, bestFive, categoryOf, CATEGORY };
