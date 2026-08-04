/* Texas Hold'em renderer.
 *
 * Registers itself into app.js's GAME_RENDERERS, keyed off `gameType`.
 * Everything it needs arrives in `room.poker` — the server sends each
 * player their own view, so this file never has to decide what to hide.
 *
 * The seat ring is rotated so you always sit at the bottom of the
 * table, which is what makes position readable at a glance.
 */

const SUIT_SYMBOL = { c: '♣', d: '♦', h: '♥', s: '♠' };

let tickTimer = null;
let raiseDraft = null;   // slider value, kept across re-renders
let raiseDraftKey = '';  // resets the draft when the decision changes

/* ─── Formatting ───────────────────────────────────────────────── */

// Stacks are in the millions and blinds in the thousands, so full
// digits are unreadable on a seat badge. Compact everywhere, exact in
// the title attribute for anyone who wants the real number.
function chips(n) {
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs >= 1000000) {
    const v = n / 1000000;
    return '$' + (v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.0+$/, '')) + 'M';
  }
  if (abs >= 1000) {
    const v = n / 1000;
    return '$' + (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'K';
  }
  return '$' + n;
}

function exact(n) {
  return '$' + (n || 0).toLocaleString('en-US');
}

/* ─── Card ─────────────────────────────────────────────────────── */

function cardEl(code, cls) {
  const el = document.createElement('div');
  el.className = 'pk-card' + (cls ? ' ' + cls : '');
  if (!code || code === '??') {
    el.classList.add('is-back');
    return el;
  }
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  el.classList.add(suit === 'h' || suit === 'd' ? 'is-red' : 'is-black');

  const r = document.createElement('span');
  r.className = 'pk-card-rank';
  r.textContent = rank;
  const s = document.createElement('span');
  s.className = 'pk-card-suit';
  s.textContent = SUIT_SYMBOL[suit] || '';
  el.appendChild(r);
  el.appendChild(s);
  return el;
}

/* ─── Seat geometry ────────────────────────────────────────────── */

// Seats sit on an ellipse, index 0 at the bottom (that's you) and the
// rest running clockwise, so the player to your left is where they'd
// be at a real table.
function seatPositions(n) {
  // On a narrow screen the table is taller than it is wide, and a seat
  // pushed out to the same horizontal radius would hang off the edge —
  // so trade horizontal spread for vertical.
  const narrow = window.innerWidth < 560;
  const rx = narrow ? 36 : 46;
  const ry = narrow ? 42 : 39;

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({
      x: 50 + rx * Math.cos(t),
      y: 50 + ry * Math.sin(t),
    });
  }
  return out;
}

/* ─── Main render ──────────────────────────────────────────────── */

function renderHoldem(stage, room) {
  const p = room.poker;
  if (!p) { stage.textContent = 'Waiting for the table…'; return; }

  clearInterval(tickTimer);
  tickTimer = null;

  // The shared turn banner is redundant next to the poker top bar.
  const banner = $('turn-banner');
  if (banner) banner.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'pk-wrap';

  wrap.appendChild(renderTopBar(p));
  wrap.appendChild(renderTable(p));

  const acting = p.seats.find((s) => s.id === p.actingId);
  if (p.legal) {
    wrap.appendChild(renderActions(p));
  } else {
    wrap.appendChild(renderWaiting(p, acting));
  }

  wrap.appendChild(renderLog(p));
  stage.appendChild(wrap);

  startTicker(p);
}

function renderTopBar(p) {
  const bar = document.createElement('div');
  bar.className = 'pk-topbar';

  const left = document.createElement('span');
  left.className = 'pk-topbar-item';
  left.textContent = `Hand ${p.handNumber}`;

  const mid = document.createElement('span');
  mid.className = 'pk-topbar-item pk-topbar-blinds';
  mid.textContent = `${chips(p.level.sb)} / ${chips(p.level.bb)}`;
  mid.title = `Blinds ${exact(p.level.sb)} / ${exact(p.level.bb)}`
    + (p.level.ante ? ` · ante ${exact(p.level.ante)}` : '');

  const right = document.createElement('span');
  right.className = 'pk-topbar-item';
  const left_ = p.level.handsUntilNext;
  right.textContent = `Level ${p.level.index + 1} · up in ${left_ + 1}`;
  right.title = `Blinds rise in ${left_ + 1} hand${left_ === 0 ? '' : 's'}`;

  bar.appendChild(left);
  bar.appendChild(mid);
  bar.appendChild(right);
  return bar;
}

function renderTable(p) {
  const table = document.createElement('div');
  table.className = 'pk-table';

  const felt = document.createElement('div');
  felt.className = 'pk-felt';

  // Community cards
  const board = document.createElement('div');
  board.className = 'pk-board';
  const winning = new Set((p.handResult && p.handResult.winningCards) || []);
  for (let i = 0; i < 5; i++) {
    const code = p.board[i];
    if (code) {
      board.appendChild(cardEl(code, winning.has(code) ? 'is-winning' : ''));
    } else {
      const slot = document.createElement('div');
      slot.className = 'pk-card is-slot';
      board.appendChild(slot);
    }
  }
  felt.appendChild(board);

  // Pot
  const pot = document.createElement('div');
  pot.className = 'pk-pot';
  pot.textContent = `Pot ${chips(p.pot)}`;
  pot.title = `Pot ${exact(p.pot)}`;
  felt.appendChild(pot);

  // Result line / side-pot note
  const status = document.createElement('div');
  status.className = 'pk-status';
  status.textContent = statusLine(p);
  felt.appendChild(status);

  table.appendChild(felt);

  // Rotate so the viewer is always seated at the bottom.
  const seats = p.seats.slice();
  const myIdx = seats.findIndex((s) => s.isMe);
  const ordered = myIdx >= 0 ? seats.slice(myIdx).concat(seats.slice(0, myIdx)) : seats;
  const pos = seatPositions(ordered.length);

  ordered.forEach((seat, i) => {
    const el = renderSeat(seat, p, winning);
    el.style.left = pos[i].x + '%';
    el.style.top = pos[i].y + '%';
    table.appendChild(el);
  });

  return table;
}

function statusLine(p) {
  if (p.handResult && p.handResult.pots && p.handResult.pots.length) {
    return p.handResult.pots.map((pot) => {
      const names = pot.winners.map((w) => w.name).join(' & ');
      const hand = pot.winners[0] && pot.winners[0].handName;
      return `${names} ${pot.winners.length > 1 ? 'split' : 'wins'} ${chips(pot.amount)}${hand ? ' — ' + hand : ''}`;
    }).join('   ·   ');
  }
  if (p.pots && p.pots.length > 1) {
    return `${p.pots.length} pots in play`;
  }
  if (p.stage === 'runout') return 'All in — running it out';
  return '';
}

function renderSeat(seat, p, winning) {
  const el = document.createElement('div');
  el.className = 'pk-seat';
  if (seat.isMe) el.classList.add('is-me');
  if (seat.folded) el.classList.add('is-folded');
  if (seat.eliminated) el.classList.add('is-out');
  if (seat.id === p.actingId) el.classList.add('is-acting');
  if (seat.winning) el.classList.add('is-winner');
  if (!seat.connected) el.classList.add('is-offline');

  // Hole cards
  const cards = document.createElement('div');
  cards.className = 'pk-seat-cards';
  if (seat.inHand && !seat.eliminated && seat.holeCards.length) {
    for (const c of seat.holeCards) {
      // Highlight a hole card only for the seat that actually won with
      // it — the same rank can sit in a loser's hand untouched.
      const isWinningCard = seat.winning && winning && winning.has(c);
      cards.appendChild(cardEl(c, 'is-mini' + (isWinningCard ? ' is-winning' : '')));
    }
  }
  el.appendChild(cards);

  // Name plate
  const plate = document.createElement('div');
  plate.className = 'pk-seat-plate';

  const name = document.createElement('span');
  name.className = 'pk-seat-name';
  name.textContent = seat.name;
  if (seat.isAI) {
    const bot = document.createElement('span');
    bot.className = 'pk-seat-bot';
    bot.textContent = 'AI';
    name.appendChild(bot);
  }
  plate.appendChild(name);

  const stack = document.createElement('span');
  stack.className = 'pk-seat-chips';
  if (seat.eliminated) {
    stack.textContent = seat.place ? `Out · ${ordinal(seat.place)}` : 'Out';
  } else {
    stack.textContent = seat.allIn ? 'All-in' : chips(seat.chips);
    stack.title = exact(seat.chips);
  }
  plate.appendChild(stack);
  el.appendChild(plate);

  // Turn clock — only for the seat on the clock, and only when the
  // server actually gave us a deadline (bots don't get one).
  if (seat.id === p.actingId && p.actingDeadline) {
    const timer = document.createElement('div');
    timer.className = 'pk-seat-timer';
    const fill = document.createElement('div');
    fill.className = 'pk-seat-timer-fill';
    fill.dataset.deadline = String(p.actingDeadline);
    fill.dataset.total = String(p.turnMs);
    timer.appendChild(fill);
    el.appendChild(timer);
  }

  // Dealer / blind markers
  const marks = [];
  if (seat.id === p.buttonId) marks.push(['D', 'is-button']);
  else if (seat.id === p.sbId) marks.push(['SB', '']);
  else if (seat.id === p.bbId) marks.push(['BB', '']);
  if (marks.length) {
    const m = document.createElement('span');
    m.className = 'pk-seat-mark ' + marks[0][1];
    m.textContent = marks[0][0];
    el.appendChild(m);
  }

  // Last action + chips pushed in this round
  if (seat.lastAction && !seat.eliminated) {
    const act = document.createElement('span');
    act.className = 'pk-seat-action';
    act.textContent = seat.lastAction;
    el.appendChild(act);
  }
  if (seat.bet > 0) {
    const bet = document.createElement('span');
    bet.className = 'pk-seat-bet';
    bet.textContent = chips(seat.bet);
    bet.title = exact(seat.bet);
    el.appendChild(bet);
  }
  if (seat.handName) {
    const hn = document.createElement('span');
    hn.className = 'pk-seat-hand';
    hn.textContent = seat.handName;
    el.appendChild(hn);
  }

  return el;
}

/* ─── Action controls ──────────────────────────────────────────── */

function renderActions(p) {
  const legal = p.legal;
  const box = document.createElement('div');
  box.className = 'pk-actions';

  // Reset the slider whenever this is a genuinely new decision.
  const key = `${p.handNumber}:${p.street}:${p.currentBet}:${legal.minRaiseTo}`;
  if (raiseDraftKey !== key) {
    raiseDraftKey = key;
    raiseDraft = null;
  }

  if (legal.canRaise) {
    const step = Math.max(1, Math.round(p.level.bb / 2));
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    if (raiseDraft === null || raiseDraft < min || raiseDraft > max) raiseDraft = min;

    const row = document.createElement('div');
    row.className = 'pk-raise';

    const amount = document.createElement('div');
    amount.className = 'pk-raise-amount';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'pk-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(raiseDraft);

    const label = () => {
      amount.textContent = raiseDraft >= max ? `All-in ${chips(max)}` : chips(raiseDraft);
      amount.title = exact(raiseDraft);
    };
    label();

    slider.addEventListener('input', () => {
      raiseDraft = Math.min(max, Math.max(min, Number(slider.value)));
      label();
      raiseBtn.textContent = raiseLabel();
    });

    const presets = document.createElement('div');
    presets.className = 'pk-presets';
    const potSized = p.currentBet + Math.round(p.pot);
    const halfPot = p.currentBet + Math.round(p.pot / 2);
    const options = [
      ['Min', min],
      ['½ Pot', halfPot],
      ['Pot', potSized],
      ['All-in', max],
    ];
    for (const [text, value] of options) {
      const v = Math.min(max, Math.max(min, value));
      // Skip a preset that can't do anything different from the others.
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pk-preset';
      b.textContent = text;
      b.addEventListener('click', () => {
        raiseDraft = v;
        slider.value = String(v);
        label();
        raiseBtn.textContent = raiseLabel();
      });
      presets.appendChild(b);
    }

    row.appendChild(amount);
    row.appendChild(slider);
    row.appendChild(presets);
    box.appendChild(row);
  }

  const buttons = document.createElement('div');
  buttons.className = 'pk-buttons';

  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'pk-btn pk-btn-fold';
  fold.textContent = 'Fold';
  fold.addEventListener('click', () => act({ kind: 'fold' }));
  buttons.appendChild(fold);

  if (legal.canCheck) {
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'pk-btn pk-btn-check';
    check.textContent = 'Check';
    check.addEventListener('click', () => act({ kind: 'check' }));
    buttons.appendChild(check);
  } else if (legal.canCall) {
    const call = document.createElement('button');
    call.type = 'button';
    call.className = 'pk-btn pk-btn-call';
    call.textContent = legal.callAmount >= legal.maxRaiseTo
      ? `Call all-in ${chips(legal.callAmount)}`
      : `Call ${chips(legal.callAmount)}`;
    call.title = exact(legal.callAmount);
    call.addEventListener('click', () => act({ kind: 'call' }));
    buttons.appendChild(call);
  }

  let raiseBtn = null;
  const raiseLabel = () => {
    if (raiseDraft >= legal.maxRaiseTo) return `All-in ${chips(legal.maxRaiseTo)}`;
    return `${p.currentBet > 0 ? 'Raise to' : 'Bet'} ${chips(raiseDraft)}`;
  };
  if (legal.canRaise) {
    raiseBtn = document.createElement('button');
    raiseBtn.type = 'button';
    raiseBtn.className = 'pk-btn pk-btn-raise';
    raiseBtn.textContent = raiseLabel();
    raiseBtn.addEventListener('click', () => act({ kind: 'raise', to: raiseDraft }));
    buttons.appendChild(raiseBtn);
  }

  box.appendChild(buttons);
  return box;
}

function act(action) {
  raiseDraft = null;
  raiseDraftKey = '';
  send({ type: 'game_action', action });
}

function renderWaiting(p, acting) {
  const el = document.createElement('div');
  el.className = 'pk-waiting';
  const me = p.seats.find((s) => s.isMe);

  if (p.stage === 'complete') el.textContent = 'Tournament over';
  else if (me && me.eliminated) el.textContent = `You finished ${ordinal(me.place)} — watching the rest`;
  else if (me && me.folded) el.textContent = 'You folded this hand';
  else if (me && me.allIn) el.textContent = 'All-in — good luck';
  else if (acting) el.textContent = `Waiting on ${acting.name}…`;
  else if (p.stage === 'showdown' || p.stage === 'handover') el.textContent = 'Next hand shortly…';
  else el.textContent = 'Dealing…';

  return el;
}

function renderLog(p) {
  const box = document.createElement('div');
  box.className = 'pk-log';
  for (const entry of (p.log || []).slice(-6)) {
    const line = document.createElement('div');
    line.className = 'pk-log-line';
    line.textContent = entry.text;
    box.appendChild(line);
  }
  return box;
}

/* ─── Turn clock ───────────────────────────────────────────────── */

// The server sends an absolute deadline rather than a countdown, so a
// slow message or a tab that was backgrounded can't leave the bar out
// of step with the real clock.
function startTicker(p) {
  if (!p.actingDeadline) return;
  const tick = () => {
    const fill = document.querySelector('.pk-seat-timer-fill');
    if (!fill) { clearInterval(tickTimer); tickTimer = null; return; }
    const deadline = Number(fill.dataset.deadline);
    const total = Number(fill.dataset.total) || 30000;
    const remaining = Math.max(0, deadline - Date.now());
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    fill.style.width = pct + '%';
    fill.classList.toggle('is-low', remaining < 8000);
  };
  tick();
  tickTimer = setInterval(tick, 200);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ─── Tournament standings, shown on the game-over screen ──────── */

function renderHoldemStandings(el, room) {
  const result = room.result;
  el.innerHTML = '';
  if (!result || !result.standings) return;

  for (const s of result.standings) {
    const row = document.createElement('div');
    row.className = 'pk-standing';
    if (s.place === 1) row.classList.add('is-first');
    if (s.id === state.playerId) row.classList.add('is-me');

    const place = document.createElement('span');
    place.className = 'pk-standing-place';
    place.textContent = ordinal(s.place);

    const name = document.createElement('span');
    name.className = 'pk-standing-name';
    name.textContent = s.name + (s.id === state.playerId ? ' (you)' : '');
    if (s.isAI) {
      const bot = document.createElement('span');
      bot.className = 'pk-seat-bot';
      bot.textContent = 'AI';
      name.appendChild(bot);
    }

    const chipCount = document.createElement('span');
    chipCount.className = 'pk-standing-chips';
    chipCount.textContent = s.place === 1 ? chips(s.chips) : '';

    row.appendChild(place);
    row.appendChild(name);
    row.appendChild(chipCount);
    el.appendChild(row);
  }
}

// Register with the dispatcher in app.js.
GAME_RENDERERS.holdem = renderHoldem;
GAME_OVER_RENDERERS.holdem = renderHoldemStandings;
