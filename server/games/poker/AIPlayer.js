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

const PROFILES = [
  { label: 'tight-aggressive', betShare: 1.30, raiseShare: 1.70, aggression: 0.60, bluff: 0.10, caution: 0.40, sizing: 1.00 },
  { label: 'loose-aggressive', betShare: 1.12, raiseShare: 1.45, aggression: 0.75, bluff: 0.20, caution: 0.25, sizing: 1.15 },
  { label: 'rock',             betShare: 1.55, raiseShare: 2.00, aggression: 0.35, bluff: 0.03, caution: 0.55, sizing: 0.90 },
  { label: 'calling station',  betShare: 1.40, raiseShare: 2.10, aggression: 0.20, bluff: 0.02, caution: 0.10, sizing: 0.85 },
  { label: 'grinder',          betShare: 1.35, raiseShare: 1.75, aggression: 0.50, bluff: 0.08, caution: 0.45, sizing: 0.95 },
  { label: 'maniac',           betShare: 0.95, raiseShare: 1.25, aggression: 0.85, bluff: 0.30, caution: 0.15, sizing: 1.30 },
];

// More simulations where the decision is closest and the branching is
// smallest. Preflop nine-handed is the most expensive case and also the
// one where extra precision matters least.
const ITERATIONS = { preflop: 320, flop: 480, turn: 560, river: 700 };

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

class AIPlayer {
  constructor(id, index) {
    this.id = id;
    const base = PROFILES[index % PROFILES.length];
    // Jitter so two bots sharing an archetype still differ.
    const j = () => 1 + (Math.random() - 0.5) * 0.12;
    this.profile = {
      label: base.label,
      betShare: base.betShare * j(),
      raiseShare: base.raiseShare * j(),
      aggression: clamp(base.aggression * j(), 0.05, 0.95),
      bluff: clamp(base.bluff * j(), 0, 0.4),
      caution: clamp(base.caution * j(), 0.05, 0.8),
      sizing: base.sizing * j(),
    };
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

module.exports = AIPlayer;
