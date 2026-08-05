// No-limit Texas Hold'em — tournament format.
//
// Implements the Level 0 game contract: start(), handleAction(),
// getFullState(viewerId, occupant), destroy(). Two things make poker
// different from the other games here:
//
//   1. State is per-viewer. Hole cards belong to one player, so this
//      game emits through `opts.broadcastPerViewer` rather than
//      `broadcast` — same mechanism Mafia uses for hidden roles.
//   2. Seats can be bots. Bot seats arrive in `players` like anyone
//      else (the Room seats them, and fills the table on start), and
//      this class attaches a decision engine to each one.

const { freshDeck, shuffle, toCode } = require('./Cards');
const { evaluate, describe, bestFive } = require('./HandEvaluator');
const { buildPots, splitPot } = require('./Pots');
const { STARTING_CHIPS, HANDS_PER_LEVEL, levelAt, levelForHand } = require('./Tournament');
const AIPlayer = require('./AIPlayer');

// Default pacing. Tests override these through `ctx.timing` to run
// tournaments headlessly at full speed.
const TIMING = {
  turn: 30000,        // clock for a connected human
  absentTurn: 4000,   // shorter clock when they've dropped their connection
  aiMin: 600,         // bots "think" for a beat so the table reads naturally
  aiMax: 1500,
  streetPause: 1300,  // between board cards on an all-in runout
  showdown: 5000,     // how long a showdown stays on screen
  handPause: 2600,    // between hands otherwise
};

const LOG_LIMIT = 60;

const STREETS = ['preflop', 'flop', 'turn', 'river'];

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

class TexasHoldem {
  constructor(players, broadcast, onEnd, opts = {}) {
    this.broadcast = broadcast;
    this.onEnd = onEnd;
    this.broadcastPerViewer = opts.broadcastPerViewer || null;

    const options = opts.options || {};
    this.tableSize = options.tableSize === 5 ? 5 : 9;
    this.timing = Object.assign({}, TIMING, opts.timing || {});

    // Everyone at the table arrives in `players`, bots included — the
    // Room seats them and tops the table up before we start.
    const seated = players.slice(0, this.tableSize);
    const humanCount = seated.filter((p) => !p.isBot).length;
    const botCount = seated.length - humanCount;

    // Who the bots are depends on who else is at the table. Alone, they
    // *are* the game, so each one is a distinct character you can learn
    // to read. With friends at the table the game is the people — the
    // bots drop back to a single quiet profile, play tight, and stay
    // out of the hand the humans are actually playing.
    this.aiMode = humanCount >= 2 ? 'filler' : 'solo';
    const profiles = this.aiMode === 'solo'
      ? AIPlayer.soloProfileOrder(botCount)
      : new Array(botCount).fill(AIPlayer.FILLER_PROFILE);

    this.seats = [];
    let botIndex = 0;
    for (const p of seated) {
      const seat = this.makeSeat(p.id, p.name, !!p.isBot, p);
      if (seat.isAI) seat.ai = new AIPlayer(p.id, profiles[botIndex++], this.aiMode);
      this.seats.push(seat);
    }

    this.handNumber = 0;
    this.levelIndex = 0;
    this.buttonIdx = -1;
    this.street = null;
    this.stage = 'idle'; // idle | betting | dealing | runout | showdown | handover | complete
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.raiseCapped = false;
    this.actingIdx = -1;
    this.actingDeadline = null;
    this.pots = [];
    this.log = [];
    this.status = 'playing';
    this.result = null;
    this.handResult = null;
    this.timers = new Set();
    this.destroyed = false;
  }

  makeSeat(id, name, isAI, player) {
    return {
      id,
      name,
      isAI,
      player,
      ai: null,
      chips: STARTING_CHIPS,
      holeCards: [],
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      eliminated: false,
      place: null,
      chipsAtHandStart: STARTING_CHIPS,
      lastAction: null,
      handScore: -1,
      handName: null,
      showCards: false,
      winning: false,
    };
  }

  // ── timers ───────────────────────────────────────────────────────
  // Every timeout is tracked so destroy() can cancel the lot; a room
  // that gets reaped mid-hand must not keep firing callbacks.

  later(fn, ms) {
    if (this.destroyed) return null;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.timers.delete(this.turnTimer);
      this.turnTimer = null;
    }
    this.actingDeadline = null;
  }

  // ── seat helpers ─────────────────────────────────────────────────

  live() {
    return this.seats.filter((s) => !s.eliminated);
  }

  // Still holding cards this hand.
  contenders() {
    return this.seats.filter((s) => !s.eliminated && !s.folded && s.inHand);
  }

  // Contenders who still have chips behind, i.e. can still bet.
  actionable() {
    return this.contenders().filter((s) => !s.allIn);
  }

  nextIdx(from, predicate) {
    const n = this.seats.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + step) % n;
      if (predicate(this.seats[idx])) return idx;
    }
    return -1;
  }

  seatById(id) {
    return this.seats.find((s) => s.id === id) || null;
  }

  // Entries carry a monotonic sequence number so the client can append
  // only what it hasn't shown yet — the log it receives is a sliding
  // window, and matching on text alone would duplicate repeated lines
  // like "Atlas folds."
  addLog(text) {
    this.logSeq = (this.logSeq || 0) + 1;
    this.log.push({ seq: this.logSeq, text, hand: this.handNumber });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  // ── lifecycle ────────────────────────────────────────────────────

  start() {
    this.addLog(`Tournament started — ${this.live().length} players, ${money(STARTING_CHIPS)} each.`);
    this.startHand();
  }

  startHand() {
    if (this.destroyed) return;

    const live = this.live();
    if (live.length <= 1) return this.finishTournament();

    this.handNumber++;
    const newLevel = levelForHand(this.handNumber);
    if (newLevel !== this.levelIndex) {
      this.levelIndex = newLevel;
      const l = levelAt(this.levelIndex);
      this.addLog(`Blinds up — ${money(l.sb)} / ${money(l.bb)}${l.ante ? ` (ante ${money(l.ante)})` : ''}.`);
    }

    // Reset per-hand seat state.
    for (const s of this.seats) {
      s.holeCards = [];
      s.bet = 0;
      s.committed = 0;
      s.folded = false;
      s.allIn = false;
      s.hasActed = false;
      s.lastAction = null;
      s.handScore = -1;
      s.handName = null;
      s.showCards = false;
      s.winning = false;
      s.chipsAtHandStart = s.chips;
      s.inHand = !s.eliminated;
    }

    this.board = [];
    this.pots = [];
    this.handResult = null;
    this.deck = shuffle(freshDeck());
    this.buttonIdx = this.nextIdx(this.buttonIdx < 0 ? this.seats.length - 1 : this.buttonIdx, (s) => !s.eliminated);

    this.postBlinds();
    this.dealHole();
    this.beginBetting('preflop');
  }

  postBlinds() {
    const level = levelAt(this.levelIndex);
    const live = this.live();
    const headsUp = live.length === 2;

    // Heads-up: the button posts the small blind. Otherwise blinds sit
    // in the two seats to the button's left.
    const sbIdx = headsUp ? this.buttonIdx : this.nextIdx(this.buttonIdx, (s) => !s.eliminated);
    const bbIdx = this.nextIdx(sbIdx, (s) => !s.eliminated);

    this.sbIdx = sbIdx;
    this.bbIdx = bbIdx;

    const sb = this.seats[sbIdx];
    const bb = this.seats[bbIdx];

    this.commit(sb, level.sb);
    this.commit(bb, level.bb);

    // Big-blind ante: one ante per hand, posted by the big blind, taken
    // from whatever is left after their blind.
    if (level.ante > 0) {
      this.commit(bb, level.ante);
    }

    this.currentBet = level.bb;
    this.minRaise = level.bb;
  }

  dealHole() {
    // Two rounds of one card each, starting left of the button — the
    // order doesn't change the maths but it's how the game is dealt.
    for (let round = 0; round < 2; round++) {
      let idx = this.buttonIdx;
      for (let i = 0; i < this.seats.length; i++) {
        idx = this.nextIdx(idx, (s) => !s.eliminated);
        this.seats[idx].holeCards.push(this.deck.pop());
        if (idx === this.buttonIdx) break;
      }
    }
  }

  commit(seat, amount) {
    const amt = Math.max(0, Math.min(amount, seat.chips));
    seat.chips -= amt;
    seat.bet += amt;
    seat.committed += amt;
    if (seat.chips === 0) seat.allIn = true;
    return amt;
  }

  // ── betting ──────────────────────────────────────────────────────

  beginBetting(street) {
    this.street = street;
    this.stage = 'betting';
    this.raiseCapped = false;
    // Preflop the blind is already a bet, so the first re-raise over it
    // is what counts as aggression; postflop the count starts clean.
    this.raisesThisStreet = 0;

    if (street !== 'preflop') {
      for (const s of this.seats) {
        s.bet = 0;
        s.hasActed = false;
        s.lastAction = null;
      }
      this.currentBet = 0;
      this.minRaise = levelAt(this.levelIndex).bb;
    }

    // Preflop the action starts left of the big blind; on every later
    // street it starts left of the button. Heads-up falls out of the
    // same rule because the button is the small blind.
    const anchor = street === 'preflop' ? this.bbIdx : this.buttonIdx;
    const first = this.nextIdx(anchor, (s) => !s.eliminated && !s.folded && s.inHand && !s.allIn);

    if (this.actionable().length <= 1) {
      // Nobody left to bet — either one player took it down or the rest
      // are all-in and we just need to run the board out.
      return this.finishBetting();
    }

    this.actingIdx = first;
    this.startTurn();
  }

  startTurn() {
    if (this.destroyed) return;
    this.clearTurnTimer();

    const seat = this.seats[this.actingIdx];
    if (!seat) return this.finishBetting();

    if (seat.isAI) {
      this.emit('game_update');
      const t = this.timing;
      // Filler bots think at half speed — with friends waiting, a bot
      // pondering is just dead air between the hands that matter.
      const scale = this.aiMode === 'filler' ? 0.5 : 1;
      const delay = (t.aiMin + Math.random() * Math.max(0, t.aiMax - t.aiMin)) * scale;
      this.turnTimer = this.later(() => this.runAI(seat), delay);
      return;
    }

    // A human who has dropped their connection gets a much shorter
    // clock — otherwise one person closing their laptop stalls the
    // table for 30 seconds every single hand.
    const connected = seat.player ? seat.player.connected !== false : false;
    const ms = connected ? this.timing.turn : this.timing.absentTurn;
    this.actingDeadline = Date.now() + ms;
    this.emit('game_update');

    this.turnTimer = this.later(() => {
      const legal = this.legalFor(seat);
      // Time-out defaults to the free option: check if it costs
      // nothing, fold if it doesn't.
      this.applyAction(seat, legal.canCheck ? { kind: 'check' } : { kind: 'fold' }, true);
    }, ms);
  }

  runAI(seat) {
    if (this.destroyed || this.stage !== 'betting') return;
    if (this.seats[this.actingIdx] !== seat) return;
    const action = seat.ai.decide(this.aiView(seat), this.legalFor(seat));
    this.applyAction(seat, action, false);
  }

  // What an AI seat is allowed to know: its own cards, the board, the
  // betting state, and public chip counts. Never another seat's cards.
  aiView(seat) {
    return {
      holeCards: seat.holeCards,
      board: this.board,
      street: this.street,
      pot: this.totalPot(),
      toCall: Math.max(0, this.currentBet - seat.bet),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      bigBlind: levelAt(this.levelIndex).bb,
      chips: seat.chips,
      bet: seat.bet,
      committed: seat.committed,
      opponents: this.contenders()
        .filter((s) => s.id !== seat.id)
        .map((s) => ({ chips: s.chips, bet: s.bet, allIn: s.allIn, committed: s.committed })),
      activeCount: this.contenders().length,
      // How much aggression has already been shown this street. A bot
      // that knows it is facing a raise can allow for the fact that a
      // raiser holds far better than a random hand.
      raisesThisStreet: this.raisesThisStreet || 0,
      // Seats still to act behind us — being last to speak is worth a
      // lot, and the bot should know when it has that edge.
      toActBehind: this.seatsToActBehind(seat),
    };
  }

  seatsToActBehind(seat) {
    const idx = this.seats.indexOf(seat);
    let count = 0;
    const n = this.seats.length;
    for (let step = 1; step < n; step++) {
      const s = this.seats[(idx + step) % n];
      if (s.eliminated || s.folded || !s.inHand || s.allIn) continue;
      if (!s.hasActed || s.bet < this.currentBet) count++;
    }
    return count;
  }

  legalFor(seat) {
    const toCall = Math.max(0, this.currentBet - seat.bet);
    const callAmount = Math.min(toCall, seat.chips);
    const maxRaiseTo = seat.bet + seat.chips;
    let minRaiseTo = this.currentBet + this.minRaise;
    if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo;

    // A short all-in raise doesn't reopen betting for anyone who has
    // already acted — they can call it but not raise it again.
    const reopened = !(this.raiseCapped && seat.hasActed);

    return {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0 && seat.chips > 0,
      callAmount,
      canRaise: seat.chips > toCall && reopened,
      minRaiseTo,
      maxRaiseTo,
      toCall,
    };
  }

  handleAction(playerId, action) {
    if (this.status !== 'playing') return { success: false, error: 'Tournament is over' };
    if (this.stage !== 'betting') return { success: false, error: 'No action right now' };

    const seat = this.seatById(playerId);
    if (!seat) return { success: false, error: 'You are not seated' };
    if (this.seats[this.actingIdx] !== seat) return { success: false, error: 'Not your turn' };

    return this.applyAction(seat, action, false);
  }

  applyAction(seat, action, timedOut) {
    const legal = this.legalFor(seat);
    const kind = action && action.kind;

    switch (kind) {
      case 'fold': {
        seat.folded = true;
        seat.hasActed = true;
        seat.lastAction = timedOut ? 'Fold (time)' : 'Fold';
        this.addLog(`${seat.name} folds.`);
        break;
      }

      case 'check': {
        if (!legal.canCheck) return { success: false, error: 'You cannot check' };
        seat.hasActed = true;
        seat.lastAction = timedOut ? 'Check (time)' : 'Check';
        this.addLog(`${seat.name} checks.`);
        break;
      }

      case 'call': {
        if (!legal.canCall) return { success: false, error: 'Nothing to call' };
        const paid = this.commit(seat, legal.toCall);
        seat.hasActed = true;
        seat.lastAction = seat.allIn ? 'All-in' : 'Call';
        this.addLog(`${seat.name} calls ${money(paid)}${seat.allIn ? ' and is all-in' : ''}.`);
        break;
      }

      case 'raise': {
        if (!legal.canRaise) return { success: false, error: 'You cannot raise' };
        let to = Math.floor(Number(action.to));
        if (!Number.isFinite(to)) return { success: false, error: 'Invalid raise' };
        // Clamp rather than reject: the client slider and the server
        // can disagree by a chip when blinds tick over mid-render.
        if (to > legal.maxRaiseTo) to = legal.maxRaiseTo;
        // Below the minimum is only legal as an all-in for less, which
        // is exactly the case where the clamp above already landed us
        // on the whole stack.
        if (to < legal.minRaiseTo && to < legal.maxRaiseTo) {
          return { success: false, error: `Minimum raise is ${money(legal.minRaiseTo)}` };
        }

        const raiseBy = to - this.currentBet;
        const wasBet = this.currentBet === 0;
        this.commit(seat, to - seat.bet);
        this.raisesThisStreet++;

        if (raiseBy >= this.minRaise) {
          // A full raise reopens the betting for everyone.
          this.minRaise = raiseBy;
          this.raiseCapped = false;
          for (const s of this.seats) {
            if (s !== seat && !s.folded && s.inHand && !s.allIn) s.hasActed = false;
          }
        } else {
          this.raiseCapped = true;
        }

        this.currentBet = Math.max(this.currentBet, seat.bet);
        seat.hasActed = true;
        seat.lastAction = seat.allIn ? 'All-in' : (wasBet ? 'Bet' : 'Raise');
        this.addLog(`${seat.name} ${wasBet ? 'bets' : 'raises to'} ${money(seat.bet)}${seat.allIn ? ' and is all-in' : ''}.`);
        break;
      }

      default:
        return { success: false, error: 'Unknown action' };
    }

    this.clearTurnTimer();
    this.advance();
    return { success: true };
  }

  advance() {
    if (this.destroyed) return;

    // Everyone folded to one player — hand is over, no cards shown.
    if (this.contenders().length === 1) {
      return this.finishBetting();
    }

    if (this.bettingComplete()) {
      return this.finishBetting();
    }

    const next = this.nextIdx(this.actingIdx, (s) => (
      !s.eliminated && !s.folded && s.inHand && !s.allIn
      && (!s.hasActed || s.bet < this.currentBet)
    ));

    if (next < 0) return this.finishBetting();

    this.actingIdx = next;
    this.startTurn();
  }

  bettingComplete() {
    const act = this.actionable();
    if (act.length === 0) return true;
    // With one player left able to bet, the round ends as soon as
    // they've matched the outstanding bet (or there isn't one).
    return act.every((s) => s.hasActed && s.bet >= this.currentBet);
  }

  finishBetting() {
    this.clearTurnTimer();
    // The betting round is over, so nobody is on the clock. Clearing
    // this before the next emit matters: otherwise the state that goes
    // out while we deal the next street still names the last player to
    // act as the one to act, and they may have just folded.
    this.actingIdx = -1;
    this.stage = 'dealing';

    if (this.contenders().length === 1) {
      return this.settle(false);
    }

    const streetIdx = STREETS.indexOf(this.street);

    // Nobody can act any more but two or more players are still live:
    // run the remaining board out with a pause between cards.
    if (this.actionable().length <= 1 && streetIdx < STREETS.length - 1) {
      this.stage = 'runout';
      for (const s of this.seats) if (!s.folded && s.inHand) s.showCards = true;
      this.emit('game_update');
      return this.runOutFrom(streetIdx + 1);
    }

    if (streetIdx >= STREETS.length - 1) {
      return this.settle(true);
    }

    this.dealStreet(STREETS[streetIdx + 1]);
    this.emit('game_update');
    this.beginBetting(STREETS[streetIdx + 1]);
  }

  runOutFrom(streetIdx) {
    if (streetIdx >= STREETS.length) {
      return this.settle(true);
    }
    this.later(() => {
      this.dealStreet(STREETS[streetIdx]);
      this.emit('game_update');
      this.runOutFrom(streetIdx + 1);
    }, this.timing.streetPause);
  }

  dealStreet(street) {
    // Burn a card before each street, as dealt live.
    this.deck.pop();
    const count = street === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
    this.street = street;
  }

  // ── settlement ───────────────────────────────────────────────────

  settle(showdown) {
    this.stage = showdown ? 'showdown' : 'handover';
    this.clearTurnTimer();

    const inHand = this.seats.filter((s) => s.inHand);
    this.pots = buildPots(inHand);

    if (showdown) {
      for (const s of this.contenders()) {
        const seven = s.holeCards.concat(this.board);
        s.handScore = evaluate(seven);
        s.handName = describe(s.handScore);
        s.showCards = true;
      }
    }

    const winnings = {};
    const potResults = [];

    for (const pot of this.pots) {
      const eligible = pot.eligible
        .map((id) => this.seatById(id))
        .filter((s) => s && !s.folded);

      if (eligible.length === 0) continue;

      let winners;
      if (eligible.length === 1) {
        winners = eligible;
      } else {
        const best = Math.max(...eligible.map((s) => s.handScore));
        winners = eligible.filter((s) => s.handScore === best);
      }

      // Odd chips go to the first winner left of the button.
      const ordered = this.orderFromButton(winners);
      const shares = splitPot(pot.amount, ordered.map((s) => s.id));
      for (const [id, amt] of Object.entries(shares)) {
        winnings[id] = (winnings[id] || 0) + amt;
      }
      for (const w of winners) w.winning = true;

      potResults.push({
        amount: pot.amount,
        winners: winners.map((s) => ({ id: s.id, name: s.name, handName: s.handName })),
      });
    }

    for (const [id, amt] of Object.entries(winnings)) {
      const s = this.seatById(id);
      if (s) {
        s.chips += amt;
        // Someone who was all-in and got paid has chips again — drop the
        // flag now so the table doesn't label them all-in during the
        // pause before the next hand.
        if (s.chips > 0) s.allIn = false;
      }
    }

    // Highlight the five cards that actually won it.
    let winningCards = null;
    if (showdown) {
      const top = this.contenders().filter((s) => s.winning)[0];
      if (top && this.board.length === 5) {
        winningCards = bestFive(top.holeCards.concat(this.board)).cards.map(toCode);
      }
    }

    // Chips in front have been swept into the pot — clear them so the
    // table doesn't show the same money twice, once in the pot total and
    // again as a bet still sitting in front of a player.
    for (const s of inHand) s.bet = 0;

    this.logSettlement(potResults, showdown);

    this.handResult = {
      showdown,
      pots: potResults,
      winnings,
      winningCards,
    };

    const eliminated = this.applyEliminations();
    this.emit('game_update');

    const live = this.live();
    if (live.length <= 1) {
      return this.later(() => this.finishTournament(), showdown ? this.timing.showdown : this.timing.handPause);
    }

    const pause = showdown || eliminated.length ? this.timing.showdown : this.timing.handPause;
    this.later(() => this.startHand(), pause);
  }

  logSettlement(potResults, showdown) {
    for (const pot of potResults) {
      const names = pot.winners.map((w) => w.name).join(' and ');
      if (showdown && pot.winners[0].handName) {
        const hands = pot.winners.length > 1 ? pot.winners[0].handName : pot.winners[0].handName;
        this.addLog(`${names} win${pot.winners.length > 1 ? '' : 's'} ${money(pot.amount)} with ${hands}.`);
      } else {
        this.addLog(`${names} win${pot.winners.length > 1 ? '' : 's'} ${money(pot.amount)}.`);
      }
    }
  }

  orderFromButton(seats) {
    const n = this.seats.length;
    return seats.slice().sort((a, b) => {
      const ai = (this.seats.indexOf(a) - this.buttonIdx + n) % n;
      const bi = (this.seats.indexOf(b) - this.buttonIdx + n) % n;
      return ai - bi;
    });
  }

  applyEliminations() {
    const busted = this.seats.filter((s) => !s.eliminated && s.inHand && s.chips === 0);
    if (busted.length === 0) return [];

    const survivors = this.seats.filter((s) => !s.eliminated && s.chips > 0).length;

    // Busting on the same hand, the bigger starting stack finishes
    // higher — they survived marginally longer.
    busted.sort((a, b) => b.chipsAtHandStart - a.chipsAtHandStart);
    busted.forEach((s, i) => {
      s.eliminated = true;
      s.place = survivors + i + 1;
      this.addLog(`${s.name} busts out in ${ordinal(s.place)} place.`);
    });

    return busted;
  }

  finishTournament() {
    if (this.status === 'finished') return;
    this.clearTurnTimer();
    this.status = 'finished';
    this.stage = 'complete';

    const winner = this.live()[0] || null;
    if (winner) {
      winner.place = 1;
      this.addLog(`${winner.name} wins the tournament!`);
    }

    const standings = this.seats
      .slice()
      .sort((a, b) => (a.place || 99) - (b.place || 99))
      .map((s) => ({ id: s.id, name: s.name, isAI: s.isAI, place: s.place, chips: s.chips }));

    this.result = {
      kind: 'tournament',
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
      standings,
      hands: this.handNumber,
    };

    // Flip the room to 'finished' before the last messages go out, so
    // both carry the final room state and the client lands on the
    // results screen rather than bouncing back to the table.
    if (this.onEnd) this.onEnd();
    this.emit('game_update');
    this.broadcast({ type: 'game_over', result: this.result, standings });
  }

  totalPot() {
    let n = 0;
    for (const s of this.seats) n += s.committed;
    return n;
  }

  // ── state out ────────────────────────────────────────────────────

  emit(type) {
    if (this.broadcastPerViewer) {
      // The Room merges the room state in around whatever we return.
      // Spectators get a null viewer id, so they only see the public
      // table — never a live hole card.
      this.broadcastPerViewer((occ) => ({
        type,
        ...this.getFullState(occ.isSpectator ? null : occ.id, occ),
      }));
    } else {
      // No per-viewer channel available — fall back to the public view
      // with every hole card hidden rather than leaking them.
      this.broadcast({ type, ...this.getFullState(null) });
    }
  }

  getFullState(viewerId, occupant) {
    if (occupant && occupant.isSpectator) viewerId = null;
    const level = levelAt(this.levelIndex);
    const acting = this.stage === 'betting' ? this.seats[this.actingIdx] : null;
    const viewerSeat = viewerId ? this.seatById(viewerId) : null;

    return {
      gameType: 'holdem',
      status: this.status,
      result: this.result,
      poker: {
        tableSize: this.tableSize,
        aiMode: this.aiMode,
        handNumber: this.handNumber,
        stage: this.stage,
        street: this.street,
        board: this.board.map(toCode),
        pot: this.totalPot(),
        pots: this.pots.map((p) => ({ amount: p.amount, eligible: p.eligible })),
        currentBet: this.currentBet,
        buttonId: this.seats[this.buttonIdx] ? this.seats[this.buttonIdx].id : null,
        sbId: this.seats[this.sbIdx] ? this.seats[this.sbIdx].id : null,
        bbId: this.seats[this.bbIdx] ? this.seats[this.bbIdx].id : null,
        actingId: acting ? acting.id : null,
        actingDeadline: acting && !acting.isAI ? this.actingDeadline : null,
        turnMs: this.timing.turn,
        level: {
          index: this.levelIndex,
          sb: level.sb,
          bb: level.bb,
          ante: level.ante,
          handsUntilNext: HANDS_PER_LEVEL - ((this.handNumber - 1) % HANDS_PER_LEVEL) - 1,
        },
        seats: this.seats.map((s) => this.seatView(s, viewerId)),
        legal: viewerSeat && acting === viewerSeat ? this.legalFor(viewerSeat) : null,
        handResult: this.handResult,
        log: this.log.slice(-14),
      },
    };
  }

  seatView(seat, viewerId) {
    // Hole cards go out only to their owner, or to everyone once the
    // hand reaches a showdown. Spectators never see a live hand.
    const mine = viewerId && seat.id === viewerId;
    const visible = mine || seat.showCards;

    return {
      id: seat.id,
      name: seat.name,
      isAI: seat.isAI,
      chips: seat.chips,
      bet: seat.bet,
      committed: seat.committed,
      folded: seat.folded,
      allIn: seat.allIn,
      eliminated: seat.eliminated,
      place: seat.place,
      inHand: !!seat.inHand,
      lastAction: seat.lastAction,
      connected: seat.isAI ? true : !!(seat.player && seat.player.connected),
      isBot: seat.isAI,
      isMe: !!mine,
      // Only solo tables advertise a playing style — with friends at
      // the table the bots stay anonymous.
      style: seat.ai ? seat.ai.style : null,
      styleHint: seat.ai ? seat.ai.styleHint : null,
      holeCards: visible ? seat.holeCards.map(toCode) : (seat.inHand && !seat.folded ? ['??', '??'] : []),
      handName: seat.showCards ? seat.handName : null,
      winning: seat.winning,
    };
  }

  destroy() {
    this.destroyed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.turnTimer = null;
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

module.exports = TexasHoldem;
