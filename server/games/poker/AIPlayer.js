// Heuristic poker bot.
//
// The bot's read on its own hand comes from Monte Carlo simulation
// rather than a lookup table: it deals out the rest of the board and
// random hands for each live opponent a few hundred times and counts
// how often it ends up in front. That gives a real equity number on
// every street, and it costs well under a millisecond because the hand
// evaluator works on packed integers.
//
// Equity alone isn't a strategy, though. The decision layer folds in:
//
//   - pot odds (is the price right for the equity I hold?)
//   - bet pressure (a big bet means a stronger-than-random range, so
//     charge more equity to continue against one)
//   - position (last to speak is worth extra)
//   - stack depth (under ~10 big blinds the correct game is push/fold)
//   - a personality profile, so a table of bots doesn't play as one
//
// Thresholds for aggression are expressed as a share of the pot rather
// than raw equity. 35% equity is a monster nine-handed and a fold
// heads-up; `equity x players` normalizes that, where 1.0 is exactly a
// break-even share of the pot.

const { evaluate } = require('./HandEvaluator');

// Solo opponents. Playing alone, the table *is* the game, so these are
// deliberately exaggerated and pushed apart far enough that you can
// learn to read them across a tournament: the Rock's bluff frequency is
// literally zero, the Station's fold-to-a-bet is near zero, the Maniac
// raises with almost anything. A player who notices that has an edge,
// which is the thing that makes a solo table worth beating.
const SOLO_PROFILES = [
  { label: 'Shark',   hint: 'balanced and dangerous',   betShare: 1.25, raiseShare: 1.60, aggression: 0.65, bluff: 0.14, caution: 0.42, sizing: 1.05 },
  { label: 'Rock',    hint: 'premium hands only',       betShare: 1.90, raiseShare: 2.50, aggression: 0.30, bluff: 0.00, caution: 0.75, sizing: 0.80 },
  { label: 'Maniac',  hint: 'raises with anything',     betShare: 0.80, raiseShare: 1.05, aggression: 0.95, bluff: 0.45, caution: 0.08, sizing: 1.50 },
  { label: 'Station', hint: 'calls, almost never folds', betShare: 1.70, raiseShare: 2.60, aggression: 0.10, bluff: 0.00, caution: 0.02, sizing: 0.80 },
  { label: 'Bully',   hint: 'punishes weakness',        betShare: 1.00, raiseShare: 1.35, aggression: 0.85, bluff: 0.32, caution: 0.18, sizing: 1.35 },
  { label: 'Grinder', hint: 'tight and textbook',       betShare: 1.38, raiseShare: 1.78, aggression: 0.55, bluff: 0.07, caution: 0.48, sizing: 0.95 },
];

// Filler seats, used when two or more humans are at the table. There
// the game is the people, not the bots — so every filler seat plays the
// same quiet, slightly tight game. It folds a lot, rarely bluffs and
// rarely builds a big pot, which keeps it out of the way of the hand
// the humans are actually playing. It still plays correctly, so nobody
// wins a pot off a bot that simply gave up.
const FILLER_PROFILE = {
  label: null, hint: null,
  betShare: 1.45, raiseShare: 1.95, aggression: 0.40, bluff: 0.04, caution: 0.50, sizing: 0.90,
};

// More simulations where the decision is closest and the branching is
// smallest. Preflop nine-handed is the most expensive case and also the
// one where extra precision matters least.
const ITERATIONS = { preflop: 320, flop: 480, turn: 560, river: 700 };

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Deal out the solo archetypes so the first six seats are all
// different — a table of nine repeats two, which jitter then separates.
function soloProfileOrder(count) {
  const shuffled = SOLO_PROFILES.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(shuffled[i % shuffled.length]);
  return out;
}

class AIPlayer {
  // `mode` is 'solo' (one human, so the bots are the opposition and
  // each is a distinct character) or 'filler' (several humans, so the
  // bots stay deliberately anonymous and out of the way).
  constructor(id, base, mode = 'solo') {
    this.id = id;
    this.mode = mode;

    // Jitter separates two seats sharing an archetype without blurring
    // what makes the archetype recognizable — the traits that define a
    // character (a Rock that never bluffs) are left exactly alone.
    const spread = mode === 'filler' ? 0.10 : 0.05;
    const j = () => 1 + (Math.random() - 0.5) * spread;

    this.profile = {
      label: base.label,
      hint: base.hint,
      betShare: base.betShare * j(),
      raiseShare: base.raiseShare * j(),
      aggression: clamp(base.aggression * j(), 0.05, 0.95),
      // A zero stays zero: "never bluffs" has to actually mean never.
      bluff: base.bluff === 0 ? 0 : clamp(base.bluff * j(), 0.01, 0.5),
      caution: clamp(base.caution * j(), 0.02, 0.85),
      sizing: base.sizing * j(),
    };
  }

  // Shown on the seat in solo play so the table is readable; null in
  // filler mode, where the bots aren't meant to draw attention.
  get style() {
    return this.profile.label;
  }

  get styleHint() {
    return this.profile.hint;
  }

  // ── equity ───────────────────────────────────────────────────────

  equity(view) {
    const hole = view.holeCards;
    const board = view.board;
    const oppCount = Math.max(1, view.activeCount - 1);
    const iterations = ITERATIONS[view.street] || 400;

    const known = new Uint8Array(52);
    for (const c of hole) known[c] = 1;
    for (const c of board) known[c] = 1;

    const avail = [];
    for (let c = 0; c < 52; c++) if (!known[c]) avail.push(c);

    const boardNeeded = 5 - board.length;
    const need = boardNeeded + oppCount * 2;
    if (need > avail.length) return 0.5;

    const full = new Array(7);
    const oppHand = new Array(7);
    let score = 0;

    for (let it = 0; it < iterations; it++) {
      // Partial Fisher-Yates: we only need the first `need` cards to be
      // properly randomized, so we don't shuffle the whole deck.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (avail.length - i));
        const t = avail[i]; avail[i] = avail[j]; avail[j] = t;
      }

      let k = 0;
      for (const c of board) full[k++] = c;
      for (let i = 0; i < boardNeeded; i++) full[k++] = avail[i];
      const boardLen = k;
      full[k++] = hole[0];
      full[k++] = hole[1];

      const mine = evaluate(full);

      let beaten = false;
      let ties = 0;
      let p = boardNeeded;
      for (let o = 0; o < oppCount; o++) {
        for (let i = 0; i < boardLen; i++) oppHand[i] = full[i];
        oppHand[boardLen] = avail[p++];
        oppHand[boardLen + 1] = avail[p++];
        const theirs = evaluate(oppHand);
        if (theirs > mine) { beaten = true; break; }
        if (theirs === mine) ties++;
      }

      if (!beaten) score += ties > 0 ? 1 / (ties + 1) : 1;
    }

    return score / iterations;
  }

  // ── decision ─────────────────────────────────────────────────────

  decide(view, legal) {
    const p = this.profile;
    const bb = view.bigBlind;
    const pot = Math.max(1, view.pot);
    const toCall = view.toCall;
    const stackBB = view.chips / bb;

    const eq = this.equity(view);

    // Position is worth real equity — acting last means seeing everyone
    // else first.
    const positionEdge = view.toActBehind === 0 ? 0.035 : (view.toActBehind <= 1 ? 0.015 : 0);
    const effEq = clamp(eq + positionEdge, 0, 1);

    // Relative strength: 1.0 is a break-even share of the pot.
    const share = effEq * view.activeCount;

    // Short stacks play push/fold — with this little behind there's no
    // room to bet and fold, so the only real choices are all-in or out.
    if (stackBB <= 10) {
      return this.pushFold(view, legal, share, effEq, pot, toCall);
    }

    // A large bet represents a narrower, stronger range than the random
    // hands the simulation assumed, so we demand more than raw pot odds.
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const betPressure = clamp(toCall / pot, 0, 2);
    // Two corrections to raw pot odds, both compensating for the same
    // blind spot: the simulation dealt opponents random hands, and real
    // opponents putting in money do not hold random hands.
    //
    //   - bet pressure: a big bet relative to the pot means strength
    //   - raises: someone who raised has a genuinely narrow range, and
    //     each re-raise on top narrows it further
    //
    // Without the second term the bot defends its big blind with almost
    // anything, because getting 3-to-1 against a *random* hand really is
    // a call — it just isn't a call against a raising range.
    const rangeAdj = 1 + Math.min(view.raisesThisStreet || 0, 3) * 0.34 * (0.5 + p.caution);
    const required = potOdds * (1 + p.caution * betPressure * 1.6) * rangeAdj;

    if (toCall === 0) {
      const value = share >= p.betShare;
      const bluffing = !value
        && view.activeCount <= 3
        && view.street !== 'preflop'
        && Math.random() < p.bluff;

      if ((value || bluffing) && legal.canRaise) {
        return { kind: 'raise', to: this.sizeBet(view, legal, share, bluffing) };
      }
      return { kind: 'check' };
    }

    // Facing a bet. Slowplaying is a postflop tool — preflop, a hand
    // worth continuing with is a hand worth raising, so the aggression
    // gate all but disappears before the flop.
    const gate = view.street === 'preflop' ? Math.max(p.aggression, 0.92) : p.aggression;
    if (share >= p.raiseShare && legal.canRaise && Math.random() < gate) {
      return { kind: 'raise', to: this.sizeBet(view, legal, share, false) };
    }

    if (effEq >= required) {
      return legal.canCall ? { kind: 'call' } : { kind: 'check' };
    }

    // Occasional heads-up bluff-raise so the bot isn't purely
    // face-up when it does put money in.
    if (legal.canRaise
        && view.activeCount === 2
        && view.street !== 'preflop'
        && betPressure < 0.75
        && Math.random() < p.bluff * 0.5) {
      return { kind: 'raise', to: this.sizeBet(view, legal, share, true) };
    }

    return legal.canCheck ? { kind: 'check' } : { kind: 'fold' };
  }

  pushFold(view, legal, share, effEq, pot, toCall) {
    const p = this.profile;
    // Fewer players left to get through means a wider shove is correct.
    const need = 1.05 + Math.max(0, view.toActBehind) * 0.06 - p.aggression * 0.15;

    if (share >= need && legal.canRaise) {
      return { kind: 'raise', to: legal.maxRaiseTo };
    }
    if (toCall === 0) return { kind: 'check' };

    const potOdds = toCall / (pot + toCall);
    if (effEq >= potOdds * 1.05) {
      return legal.canCall ? { kind: 'call' } : { kind: 'check' };
    }
    return legal.canCheck ? { kind: 'check' } : { kind: 'fold' };
  }

  sizeBet(view, legal, share, bluffing) {
    const p = this.profile;
    const bb = view.bigBlind;
    const pot = Math.max(bb, view.pot);

    let to;
    if (view.street === 'preflop' && view.currentBet <= bb) {
      // Standard opening raise.
      to = Math.round(bb * (2.2 + p.aggression));
    } else {
      const frac = (bluffing ? 0.55 : (share >= 2.2 ? 0.8 : 0.62)) * p.sizing;
      to = view.currentBet + Math.round(pot * frac);
    }

    // Round to a readable increment rather than an odd chip count.
    const step = Math.max(1, Math.round(bb / 2));
    to = Math.round(to / step) * step;

    // If the bet would commit most of the stack anyway, just move in.
    if (to > legal.maxRaiseTo * 0.72) to = legal.maxRaiseTo;

    return clamp(to, legal.minRaiseTo, legal.maxRaiseTo);
  }
}

AIPlayer.SOLO_PROFILES = SOLO_PROFILES;
AIPlayer.FILLER_PROFILE = FILLER_PROFILE;
AIPlayer.soloProfileOrder = soloProfileOrder;

module.exports = AIPlayer;
