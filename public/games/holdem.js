/* Texas Hold'em renderer.
 *
 * Registers itself into app.js's GAME_RENDERERS, keyed off `gameType`.
 * Everything it needs arrives in `room.poker` — the server sends each
 * player their own view, so this file never has to decide what to hide.
 *
 * This renderer is *incremental*: it mounts the table once and then
 * patches it in place. That matters for more than performance. Poker is
 * a game of small state changes — a bet appears, chips slide in, a card
 * turns over — and if the DOM is torn down and rebuilt on every server
 * message, every one of those changes is a teleport. Keeping elements
 * alive between frames is what lets the table *show* what happened
 * rather than just display where things ended up.
 *
 * The seat ring is rotated so you always sit at the bottom, which is
 * what makes position readable at a glance.
 */

const SUIT_SYMBOL = { c: '♣', d: '♦', h: '♥', s: '♠' };

// Everything that has to survive between updates.
const view = {
  key: null,        // identity of the mounted table; changes force a rebuild
  root: null,
  els: null,
  prev: {},         // last-seen values, for change detection
  lastLogSeq: 0,
  actionSig: null,  // rebuild the action bar only when the decision changes
  tickTimer: null,
  raiseDraft: null,
};

/* ─── Formatting ───────────────────────────────────────────────── */

// Stacks run to the millions and blinds to the thousands, so full
// digits are unreadable on a seat badge. Three significant figures is
// the sweet spot: $1.04M still reads as different from $1M, which
// matters when the number is how you track who's winning.
function chips(n) {
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs >= 1000000) {
    const v = n / 1000000;
    return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/0$/, '')) + 'M';
  }
  if (abs >= 1000) {
    const v = n / 1000;
    return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'K';
  }
  return '$' + Math.round(n);
}

function exact(n) {
  return '$' + (n || 0).toLocaleString('en-US');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ─── Small DOM helpers ────────────────────────────────────────── */

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// Only touch the DOM when the value actually changed — otherwise every
// update restarts CSS transitions on text that didn't move.
function setText(node, text) {
  const v = text == null ? '' : String(text);
  if (node.textContent !== v) node.textContent = v;
}

function setClass(node, name, on) {
  node.classList.toggle(name, !!on);
}

function setHidden(node, hidden) {
  if (node.hidden !== !!hidden) node.hidden = !!hidden;
}

/* ─── Cards ────────────────────────────────────────────────────── */

// Mutates an existing card element rather than replacing it, so a card
// that is already on the table keeps its identity (and doesn't re-run
// its deal-in animation on every unrelated update).
function restartAnim(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // force a reflow so the animation replays
  node.classList.add(cls);
}

function paintCard(node, code, opts = {}) {
  const prev = node.dataset.code || '';
  const next = code || '';
  if (prev === next) {
    setClass(node, 'is-winning', !!opts.winning);
    return;
  }
  node.dataset.code = next;

  // A card turning face-up is a different event from a card arriving,
  // and they shouldn't look the same: the flop is *dealt*, a showdown
  // hand is *revealed*. Same animation for both made a showdown read
  // as though fresh cards had appeared.
  const revealing = prev === '??' && next && next !== '??';
  const dealing = !prev && next;

  const paint = () => {
    node.classList.remove('is-back', 'is-slot', 'is-red', 'is-black');
    node.innerHTML = '';

    if (!next) {
      node.classList.add('is-slot');
      return;
    }
    if (next === '??') {
      node.classList.add('is-back');
      return;
    }
    const rank = next[0] === 'T' ? '10' : next[0];
    const suit = next[1];
    node.classList.add(suit === 'h' || suit === 'd' ? 'is-red' : 'is-black');

    // Corner index plus a large centre pip, the way a real card reads.
    // At seat size the corner is what you actually parse.
    const index = el('span', 'pk-card-index', node);
    el('span', 'pk-card-rank', index).textContent = rank;
    el('span', 'pk-card-suit', index).textContent = SUIT_SYMBOL[suit] || '';
    el('span', 'pk-card-pip', node).textContent = SUIT_SYMBOL[suit] || '';
  };

  if (revealing && opts.animate) {
    // Turn edge-on, swap the face at the midpoint, turn back. The token
    // guards against the card changing again mid-flip (the hand ending,
    // say) — without it a late timeout would paint a stale face over
    // whatever the card had since become.
    const token = (node._paintToken = (node._paintToken || 0) + 1);
    const delay = opts.delay || 0;
    node.style.animationDelay = delay + 'ms';
    restartAnim(node, 'is-flipping');
    setTimeout(() => { if (node._paintToken === token) paint(); }, 150 + delay);
  } else if (dealing && opts.animate) {
    node._paintToken = (node._paintToken || 0) + 1;
    paint();
    node.style.animationDelay = (opts.delay || 0) + 'ms';
    restartAnim(node, 'is-dealing');
  } else {
    node._paintToken = (node._paintToken || 0) + 1;
    paint();
  }

  setClass(node, 'is-winning', !!opts.winning);
}

// Bet sizes are easier to compare as colour than as digits, so chips
// are tiered against the big blind rather than an absolute amount —
// a "big bet" means something different at every blind level.
function chipTier(amount, bb) {
  const r = amount / Math.max(1, bb || 1);
  if (r >= 50) return '5';
  if (r >= 20) return '4';
  if (r >= 8) return '3';
  if (r >= 3) return '2';
  return '1';
}

/* ─── Seat geometry ────────────────────────────────────────────── */

// Seats sit on an ellipse, index 0 at the bottom (that's you) and the
// rest running clockwise, so the player to your left is where they'd be
// at a real table. A nine-handed table on a phone needs a tighter
// horizontal spread or the end seats collide with each other.
// Seat positions on an ellipse of the given radii (as percentages of
// the table box), spaced by arc length rather than by angle. Equal
// angles bunch seats where an ellipse curves hardest — unnoticeable on
// a round table, but on a flat one they pile into each other.
//
// `blocked` marks the stretch of perimeter level with the board as a
// no-seat zone, so the ring routes around the board instead of the
// board shrinking to dodge seats.
function seatPositions(n, box, rxPct, ryPct, blocked) {
  const walk = (useBlocked) => {
    const SAMPLES = 1440;
    const pts = [];
    let total = 0;
    let prevX = null;
    let prevY = null;
    let prevOk = false;

    for (let i = 0; i <= SAMPLES; i++) {
      const t = Math.PI / 2 + (i / SAMPLES) * Math.PI * 2;
      const x = rxPct * Math.cos(t);
      const y = ryPct * Math.sin(t);
      const sx = (x * box.w) / 100;
      const sy = (y * box.h) / 100;
      const ok = !useBlocked || !blocked(sx, sy);
      if (prevX !== null && ok && prevOk) total += Math.hypot(sx - prevX, sy - prevY);
      if (ok) pts.push({ x, y, len: total });
      prevX = sx;
      prevY = sy;
      prevOk = ok;
    }
    return { pts, total };
  };

  let { pts, total } = blocked ? walk(true) : walk(false);
  // If the board leaves too little perimeter to seat everyone, fall back
  // to the full ring — a cramped ring beats seats stacked on each other.
  if (pts.length < n * 4 || total <= 0) ({ pts, total } = walk(false));

  const out = [];
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].len < target) lo = mid + 1; else hi = mid;
    }
    out.push({ x: 50 + pts[lo].x, y: 50 + pts[lo].y });
  }
  out.usable = total;
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Left to stretch into whatever box the window gives it, the felt became
// an egg in portrait and a sliver in landscape, and the seat ring
// degenerated with it — seats piling onto the far ends, sitting on the
// felt and on each other. So the table is held to a sane shape, and
// spare box space becomes margin rather than distortion.
//
// Which shape is sane depends on the box. In landscape it's the wide
// oval everyone pictures. In portrait, holding to that shape capped the
// table at the box's *width* and left a third of a phone screen empty
// below it, so the table stands up instead — the same thing every mobile
// poker room does, and the longer ring seats nine without shrinking them.
// A poker table is roughly 2:1. Held to exactly that in a very flat box
// it came out a small oval adrift in black, using barely a third of the
// width, so the ceiling gives a little when the box itself is flatter —
// never far enough to turn the felt into a canoe.
function maxAspect(w, h) {
  return clamp((w / h) * 0.85, 2.2, 3.3);
}
// How far past the rail a seat's centre sits, as a fraction of the seat.
// At 0.5 the seat would clear the felt entirely and float; at 0 it would
// be centred on the rail with most of the plate on the green.
const SEAT_OUT = 0.3;
// Seat count matters too: nine seats need the perimeter a tall table
// buys, five don't, and stretching a five-handed table to the same shape
// just leaves a long empty egg.
function minAspect(w, h, seatCount) {
  if (w >= h) return 1.15;
  return seatCount > 6 ? 0.66 : 0.88;
}

// Table and ring geometry for a given card unit. Pure, so the caller
// can try a few units and pick one that actually fits.
function tableGeometry(unit, w, h, seatWRatio, seatHRatio, seatCount) {
  const seatW = unit * seatWRatio;
  const seatH = unit * seatHRatio;
  const MIN_ASPECT = minAspect(w, h, seatCount);
  const MAX_ASPECT = maxAspect(w, h);

  // The table comes first: as large as the box allows once room is left
  // around it for seats, then held to a table-like aspect.
  let railRx = Math.max(unit * 2, w / 2 - seatW * 0.62);
  let railRy = Math.max(unit * 1.8, h / 2 - seatH * 0.68);

  // Grow the short side before shrinking the long one — shrinking first
  // turned the table into a postage stamp adrift in a wide box.
  const roomRx = w / 2 - seatW * 0.62;
  const roomRy = h / 2 - seatH * 0.68;
  if (railRx / railRy > MAX_ASPECT) {
    railRy = Math.min(roomRy, railRx / MAX_ASPECT);
    if (railRx / railRy > MAX_ASPECT) railRx = railRy * MAX_ASPECT;
  } else if (railRx / railRy < MIN_ASPECT) {
    railRx = Math.min(roomRx, railRy * MIN_ASPECT);
    if (railRx / railRy < MIN_ASPECT) railRy = railRx / MIN_ASPECT;
  }
  railRx = Math.max(unit * 2, railRx);
  railRy = Math.max(unit * 1.8, railRy);

  // Seats straddle the rail, the way players sit at a table: pushed out
  // far enough that the nameplate is mostly off the felt, close enough
  // that it still reads as belonging to that side of the table.
  const geom = {
    seatW,
    seatH,
    railRx,
    railRy,
    ringRx: railRx + seatW * SEAT_OUT,
    ringRy: railRy + seatH * SEAT_OUT,
  };

  // A seat is centred on the ring, so it hangs off it by half its size.
  // Keep the whole seat inside the table box or the bottom row lands on
  // the log below. Pull the rail in with the ring so seats never end up
  // sitting on the felt instead of at the edge of it.
  geom.ringRy = Math.min(geom.ringRy, Math.max(unit, h / 2 - seatH / 2 - 2));
  geom.ringRx = Math.min(geom.ringRx, Math.max(unit, w / 2 - seatW / 2 - 2));
  geom.railRy = Math.min(geom.railRy, Math.max(unit, geom.ringRy - seatH * SEAT_OUT));
  geom.railRx = Math.min(geom.railRx, Math.max(unit, geom.ringRx - seatW * SEAT_OUT));

  // That clamp is per-axis, so it can undo the shape rule above — a
  // five-handed phone table came out a long egg despite asking for
  // something round. Re-apply the shape now that both radii are known,
  // and rebuild the ring from it. Both steps only ever shrink, so the
  // table stays inside the box it was just fitted to.
  geom.railRy = Math.max(unit, Math.min(geom.railRy, geom.railRx / MIN_ASPECT));
  geom.railRx = Math.max(unit, Math.min(geom.railRx, geom.railRy * MAX_ASPECT));
  geom.ringRx = geom.railRx + seatW * SEAT_OUT;
  geom.ringRy = geom.railRy + seatH * SEAT_OUT;
  return geom;
}

// The board fits the felt, and the felt is what the rail encloses. The
// cap used to be barely above the card unit, which left five small cards
// marooned in a large green field; the board is the thing everyone is
// looking at, so it takes the room the felt actually has.
function boardCardFor(geom, unit) {
  const gap = 0.38 * 16;
  return clamp((geom.railRx * 0.86 * 2 - gap * 4) / 5, 12, unit * 1.4);
}

// Seat positions for a solved geometry, keeping the ring off the board.
function ringPositions(seatCount, w, h, geom, unit) {
  const gap = 0.38 * 16;
  const boardCard = boardCardFor(geom, unit);
  const contentHalfX = (boardCard * 5 + gap * 4) / 2;
  const contentHalfY = boardCard * 0.7 + unit * 1.4;
  const bandY = contentHalfY + geom.seatH / 2;
  const blocked = (sx, sy) => Math.abs(sy) < bandY && Math.abs(sx) - geom.seatW / 2 < contentHalfX;

  return seatPositions(
    seatCount,
    { w, h },
    (geom.ringRx / w) * 100,
    (geom.ringRy / h) * 100,
    blocked,
  );
}

// Enough perimeter is necessary but not sufficient: seats are spaced by
// arc length, and around a tight corner the straight line between two of
// them is much shorter than the arc. So check the boxes themselves.
function seatsCollide(pos, geom, w, h) {
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      const dx = Math.abs(pos[i].x - pos[j].x) * w / 100;
      const dy = Math.abs(pos[i].y - pos[j].y) * h / 100;
      if (dx < geom.seatW + 2 && dy < geom.seatH + 2) return true;
    }
  }
  return false;
}

// Shrink the card unit until the seats genuinely fit the ring the table
// leaves them. A table-shaped felt can leave a perimeter too short to
// seat everyone — most obviously on a phone in landscape, where the box
// is very flat — and the alternative to smaller seats is seats stacked
// on each other.
function fitUnit(seatCount, w, h, seatWRatio, seatHRatio, startUnit) {
  let unit = startUnit;
  let geom = tableGeometry(unit, w, h, seatWRatio, seatHRatio, seatCount);
  let pos = ringPositions(seatCount, w, h, geom, unit);
  for (let iter = 0; iter < 12; iter++) {
    if (unit <= 11.01) break;
    const needed = seatCount * geom.seatW * 1.06;
    let next;
    if (pos.usable < needed) next = unit * Math.max(0.82, pos.usable / needed);
    else if (seatsCollide(pos, geom, w, h)) next = unit * 0.94;
    else break;
    unit = clamp(next, 11, 46);
    geom = tableGeometry(unit, w, h, seatWRatio, seatHRatio, seatCount);
    pos = ringPositions(seatCount, w, h, geom, unit);
  }
  return { unit, geom, pos };
}

function applyMetrics(els, seatCount) {
  const table = els.table;
  const w = table.clientWidth;
  const h = table.clientHeight;
  if (!w || !h) return;

  // Across: five board cards plus a seat either side. Down: the centre
  // cluster with a row of seats above and below.
  const byWidth = w / (seatCount > 6 ? 15 : 13);
  const byHeight = h / 10.2;
  let unit = clamp(Math.min(byWidth, byHeight), 12, 46);
  // Compact drops the style label and the hand name to buy room. A wide
  // box alone isn't enough to justify that: on a desktop the result
  // banner squeezes the table past 2.3:1, and every playing style on the
  // table blinked out at the exact moment the hand was being read.
  table.dataset.compact = (h < 320 || (w / h > 2.3 && h < 430)) ? '1' : '0';

  // Seat dimensions scale with the unit, so express the measured seat as
  // a ratio and the geometry can be solved for any candidate unit. Take
  // the *largest* seat, not the first: a player called Sam sits in a
  // narrower box than one called Station, and the ring has to clear the
  // widest of them.
  const measured = parseFloat(getComputedStyle(table).getPropertyValue('--card')) || unit;
  const seatBox = () => {
    let bw = 0;
    let bh = 0;
    for (const id of els.seatOrder) {
      const s = els.seats.get(id);
      if (!s) continue;
      bw = Math.max(bw, s.root.offsetWidth);
      bh = Math.max(bh, s.root.offsetHeight);
    }
    return [bw, bh];
  };
  const [box0w, box0h] = seatBox();
  const seatWRatio = (box0w || measured * 3.5) / measured;
  const seatHRatio = (box0h || measured * 3) / measured;

  let fit = fitUnit(seatCount, w, h, seatWRatio, seatHRatio, unit);
  table.style.setProperty('--card', fit.unit + 'px');

  // A seat's size doesn't scale perfectly with the unit — its padding and
  // minimum font sizes don't shrink with it — so the ratios measured at
  // the old unit are only an estimate. Re-measure at the chosen unit and,
  // if the seat came out a different shape than assumed, solve again with
  // the true ratios rather than clamping the answer afterwards. Clamping
  // after the fact shortens the ring the fit had already committed to,
  // which is how seats ended up back on top of each other.
  const [box1w, box1h] = seatBox();
  if (box1w && box1h) {
    const trueW = box1w / fit.unit;
    const trueH = box1h / fit.unit;
    if (Math.abs(trueW - seatWRatio) > 0.04 || Math.abs(trueH - seatHRatio) > 0.04) {
      fit = fitUnit(seatCount, w, h, trueW, trueH, unit);
      table.style.setProperty('--card', fit.unit + 'px');
    }
  }
  const geom = fit.geom;
  const pos = fit.pos;

  els.rail.style.width = geom.railRx * 2 + 'px';
  els.rail.style.height = geom.railRy * 2 + 'px';
  els.rail.style.left = (w / 2 - geom.railRx) + 'px';
  els.rail.style.top = (h / 2 - geom.railRy) + 'px';
  table.style.setProperty('--board-card', boardCardFor(geom, fit.unit) + 'px');

  let i = 0;
  for (const id of els.seatOrder) {
    const s = els.seats.get(id);
    if (!s) continue;
    s.root.style.left = pos[i].x + '%';
    s.root.style.top = pos[i].y + '%';
    i++;
  }
}

/* ─── Mount ────────────────────────────────────────────────────── */

function tableKey(room, p) {
  return [room.roomCode, p.tableSize, p.seats.map((s) => s.id).join(',')].join('|');
}

function mount(stage, p) {
  stage.innerHTML = '';

  const root = el('div', 'pk-wrap', stage);
  const els = { seats: new Map() };

  // ── top bar ──
  const bar = el('div', 'pk-topbar', root);
  els.hand = el('span', 'pk-topbar-item', bar);
  els.blinds = el('span', 'pk-topbar-item pk-topbar-blinds', bar);
  els.level = el('span', 'pk-topbar-item', bar);

  // ── table ──
  const table = el('div', 'pk-table', root);
  // Seat count drives how tightly the ring has to pack on small screens.
  table.dataset.seats = String(p.seats.length);
  els.table = table;

  // The rail is a real element rather than a stack of inset shadows, so
  // the felt can sit inside it and the table reads as an object.
  const rail = el('div', 'pk-rail', table);
  const felt = el('div', 'pk-felt', rail);
  els.rail = rail;
  els.felt = felt;

  els.board = [];
  const board = el('div', 'pk-board', felt);
  for (let i = 0; i < 5; i++) {
    const c = el('div', 'pk-card is-slot', board);
    c.dataset.code = '';
    els.board.push(c);
  }

  els.pot = el('div', 'pk-pot', felt);
  el('i', 'pk-chip', els.pot);
  el('span', 'pk-pot-label', els.pot).textContent = 'Pot';
  els.potAmount = el('span', 'pk-pot-amt', els.pot);
  els.potNote = el('div', 'pk-pot-note', felt);

  // ── seats ──
  // Order is kept so the ring can be recomputed later; positions used
  // to be set once at mount, which meant rotating a phone left every
  // seat at its portrait coordinate.
  const ordered = seatOrder(p);
  els.seatOrder = ordered.map((seat) => seat.id);
  for (const seat of ordered) els.seats.set(seat.id, buildSeat(table, seat));

  // ── result, log, then actions ──
  // Winning a pot gets its own banner rather than an overlay on the
  // felt: floating it over the table hid the board at exactly the
  // moment you want to read the winning hand. Sitting here it is still
  // the loudest thing on screen, and it covers nothing.
  els.wrap = root;
  els.result = el('div', 'pk-result', root);
  els.resultTitle = el('div', 'pk-result-title', els.result);
  els.resultSub = el('div', 'pk-result-sub', els.result);

  // The log sits directly above the controls: it's the last thing you
  // read before you act, so it belongs in that eye path rather than
  // stranded at the bottom of the page.
  els.log = el('div', 'pk-log', root);
  els.actions = el('div', 'pk-actionbar', root);

  // There used to be a banner here suggesting you turn the phone
  // sideways. It was true when the table had to be a wide oval; now that
  // it stands up in portrait, portrait is the roomier of the two, and the
  // banner was both wrong and in the way.

  view.root = root;
  view.els = els;
  view.prev = {};
  view.lastLogSeq = 0;
  view.actionSig = null;
  view.raiseDraft = null;

  // Lay out once the box has real dimensions, then keep it in step with
  // the box for the rest of the session. A ResizeObserver covers window
  // resizes, phone rotation and anything else that reshapes the table,
  // where a resize listener alone misses rotation on some browsers.
  applyMetrics(els, p.seats.length);
  if (view.observer) view.observer.disconnect();
  view.observer = new ResizeObserver(() => {
    if (view.els === els && root.isConnected) applyMetrics(els, p.seats.length);
  });
  view.observer.observe(table);

  // Also watch your own seat. The ring's vertical radius is derived from
  // the tallest seat, and at mount that seat has no cards yet — so the
  // radius was computed from a short seat, and once the hand was dealt
  // the seat grew past the bottom of the table and onto the log.
  const hero = els.seats.get(els.seatOrder[0]);
  if (hero) view.observer.observe(hero.root);

  return els;
}

function seatOrder(p) {
  const seats = p.seats.slice();
  const myIdx = seats.findIndex((s) => s.isMe);
  return myIdx >= 0 ? seats.slice(myIdx).concat(seats.slice(0, myIdx)) : seats;
}

function buildSeat(parent, seat) {
  const root = el('div', 'pk-seat', parent);
  root.dataset.seatId = seat.id;
  if (seat.isMe) root.classList.add('is-me');

  const cards = el('div', 'pk-seat-cards', root);
  const cardEls = [el('div', 'pk-card is-mini is-slot', cards), el('div', 'pk-card is-mini is-slot', cards)];
  cardEls.forEach((c) => { c.dataset.code = ''; });

  const plate = el('div', 'pk-seat-plate', root);
  const nameRow = el('div', 'pk-seat-namerow', plate);
  const name = el('span', 'pk-seat-name', nameRow);
  const bot = el('span', 'pk-seat-bot', nameRow);
  bot.textContent = 'AI';
  const style = el('div', 'pk-seat-style', plate);
  const stack = el('div', 'pk-seat-chips', plate);

  const timer = el('div', 'pk-seat-timer', root);
  const timerFill = el('div', 'pk-seat-timer-fill', timer);

  // The dealer/blind marker hangs off the nameplate rather than the
  // seat box: anchored to the seat it sat in the same row as the hole
  // cards and clipped them once the cards grew.
  const mark = el('span', 'pk-seat-mark', plate);

  // What the player just did, what they have out in front of them, and
  // what they showed down all come and go during a hand. In the seat's
  // own flow they changed its height as they appeared, and the ring was
  // solved for a seat that no longer existed — nine seats grew at once
  // at a showdown and climbed onto each other. They hang below the seat
  // instead, so the box the ring is spaced by never changes.
  const below = el('div', 'pk-seat-below', root);
  const action = el('span', 'pk-seat-action', below);
  const bet = el('span', 'pk-seat-bet', below);
  el('i', 'pk-chip', bet);
  const betAmount = el('span', 'pk-seat-bet-amt', bet);
  const hand = el('span', 'pk-seat-hand', below);
  const delta = el('span', 'pk-seat-delta', root);

  return { root, cards: cardEls, name, bot, style, stack, timer, timerFill, mark, action, bet, betAmount, hand, delta };
}

/* ─── Update ───────────────────────────────────────────────────── */

function renderHoldem(stage, room) {
  const p = room.poker;
  if (!p) { stage.innerHTML = ''; stage.textContent = 'Waiting for the table…'; return; }

  const key = tableKey(room, p);
  if (view.key !== key || !view.root || !stage.contains(view.root)) {
    view.key = key;
    mount(stage, p);
  }

  const els = view.els;
  const prev = view.prev;

  updateTopBar(els, p);
  updateBoard(els, p);
  updatePot(els, p);
  updateSeats(els, p);
  updateResult(els, p);
  updateLog(els, p);
  updateActions(els, p);

  view.prev = {
    levelIndex: p.level.index,
    handNumber: p.handNumber,
    street: p.street,
    stage: p.stage,
    pot: p.pot,
    chips: Object.fromEntries(p.seats.map((s) => [s.id, s.chips])),
    bets: Object.fromEntries(p.seats.map((s) => [s.id, s.bet])),
  };
  void prev;

  startTicker(p);
}
renderHoldem.incremental = true;

function updateTopBar(els, p) {
  // On a phone this row shares its width with the Leave button, so it
  // carries only what changes a decision: the blinds, and how soon they
  // rise. The hand counter is the first thing to go — it's a tally, not
  // information you act on.
  const narrow = window.innerWidth < 560;
  const n = p.level.handsUntilNext + 1;

  setHidden(els.hand, narrow);
  setText(els.hand, `Hand ${p.handNumber}`);

  setText(els.blinds, narrow
    ? `${chips(p.level.sb)} / ${chips(p.level.bb)}`
    : `Blinds ${chips(p.level.sb)} / ${chips(p.level.bb)}`);
  els.blinds.title = `Blinds ${exact(p.level.sb)} / ${exact(p.level.bb)}`
    + (p.level.ante ? ` · ante ${exact(p.level.ante)}` : '');

  if (view.prev.levelIndex !== undefined && p.level.index !== view.prev.levelIndex) {
    restartAnim(els.blinds, 'is-raised');
  }

  setText(els.level, narrow ? `↑ ${n}` : `Blinds up in ${n} hand${n === 1 ? '' : 's'}`);
  els.level.title = `Blinds rise in ${n} hand${n === 1 ? '' : 's'}`;
  // Flag the last hand before the jump — it changes how you should play.
  setClass(els.level, 'is-soon', n <= 1);
}

function updateBoard(els, p) {
  const winning = new Set((p.handResult && p.handResult.winningCards) || []);
  // The flop is three cards, and landing them simultaneously turns a
  // street change into a single blink. Dealt one after another, the
  // eye actually registers the board changing.
  let arriving = 0;
  for (let i = 0; i < 5; i++) {
    const next = p.board[i] || '';
    const isNew = next && (els.board[i].dataset.code || '') !== next;
    paintCard(els.board[i], next, {
      winning: winning.has(next),
      animate: true,
      delay: isNew ? (arriving++) * 100 : 0,
    });
  }
}

function updatePot(els, p) {
  setText(els.potAmount, chips(p.pot));
  els.pot.dataset.tier = chipTier(p.pot, p.level.bb);
  els.pot.title = `Pot ${exact(p.pot)}`;
  if (view.prev.pot !== undefined && p.pot > view.prev.pot) {
    pulse(els.pot, 'is-bumped');
  }

  // Side pots are the one bit of pot state that genuinely needs words.
  const note = p.pots && p.pots.length > 1 ? `${p.pots.length} pots` : '';
  setText(els.potNote, note);
  setHidden(els.potNote, !note);
}

function updateSeats(els, p) {
  const winning = new Set((p.handResult && p.handResult.winningCards) || []);
  const newHand = p.handNumber !== view.prev.handNumber;
  // Hands turn over one after another at a showdown rather than all at
  // once, so you can read each one as it lands.
  let revealing = 0;
  // Playing styles are only sent on solo tables, so their presence is
  // also how the seat knows there are no humans to distinguish.
  const solo = p.seats.some((s) => s.style);

  for (const seat of p.seats) {
    const s = els.seats.get(seat.id);
    if (!s) continue;

    setClass(s.root, 'is-folded', seat.folded);
    setClass(s.root, 'is-out', seat.eliminated);
    setClass(s.root, 'is-acting', seat.id === p.actingId);
    setClass(s.root, 'is-winner', seat.winning);
    setClass(s.root, 'is-offline', !seat.connected);
    setClass(s.root, 'is-live', seat.inHand && !seat.folded && !seat.eliminated);

    setText(s.name, seat.name);
    // On a solo table every opponent is a bot, so the badge marks
    // nothing and only steals room from the name. It earns its place
    // when there are humans at the table to tell the bots apart from.
    setHidden(s.bot, !seat.isAI || solo);

    // Playing style is only sent for solo tables; with friends at the
    // table the bots stay anonymous.
    setText(s.style, seat.style || '');
    setHidden(s.style, !seat.style);
    if (seat.styleHint) s.style.title = seat.styleHint;

    // Stack: count toward the new value so a pot being won or lost is
    // visible as movement rather than a number that has simply changed.
    const before = view.prev.chips ? view.prev.chips[seat.id] : undefined;
    if (seat.eliminated) {
      setText(s.stack, seat.place ? `Out · ${ordinal(seat.place)}` : 'Out');
    } else if (before !== undefined && before !== seat.chips && !newHand) {
      countTo(s.stack, before, seat.chips);
      showDelta(s.delta, seat.chips - before);
    } else {
      setText(s.stack, seat.allIn ? 'All-in' : chips(seat.chips));
    }
    s.stack.title = exact(seat.chips);

    // Hole cards
    const show = seat.inHand && !seat.eliminated && seat.holeCards.length;
    const turningOver = show && (s.cards[0].dataset.code || '') === '??'
      && seat.holeCards[0] && seat.holeCards[0] !== '??';
    const revealDelay = turningOver ? (revealing++) * 130 : 0;

    for (let i = 0; i < 2; i++) {
      const code = show ? (seat.holeCards[i] || '') : '';
      paintCard(s.cards[i], code, {
        winning: seat.winning && winning.has(code),
        animate: true,
        delay: revealDelay,
      });
      // An empty slot on a seat that isn't in the hand just reads as a
      // ghost card — hide it rather than outlining nothing.
      setHidden(s.cards[i], !code);
    }

    // Dealer / blind marker
    let markText = '';
    if (seat.id === p.buttonId) markText = 'D';
    else if (seat.id === p.sbId) markText = 'SB';
    else if (seat.id === p.bbId) markText = 'BB';
    setText(s.mark, markText);
    setHidden(s.mark, !markText);
    setClass(s.mark, 'is-button', markText === 'D');

    // Last action, colour-coded so aggression reads at a glance. A fold
    // is already said by the dimmed seat and the missing cards, so the
    // badge would just repeat it — nine seats reading FOLD is noise.
    const raw = seat.eliminated ? '' : (seat.lastAction || '');
    const act = /^fold$/i.test(raw) ? '' : raw;
    setText(s.action, act);
    setHidden(s.action, !act);
    const aggressive = /raise|bet|all-in/i.test(act);
    const passive = /fold/i.test(act);
    setClass(s.action, 'is-aggressive', aggressive);
    setClass(s.action, 'is-passive', passive);

    // Chips in front. When they clear at the end of a street, fly them
    // to the pot instead of letting them vanish.
    const prevBet = view.prev.bets ? view.prev.bets[seat.id] : undefined;
    if (prevBet && !seat.bet && !newHand) {
      flyChips(s.bet, els.pot, chips(prevBet));
    }
    setText(s.betAmount, seat.bet > 0 ? chips(seat.bet) : '');
    s.bet.dataset.tier = chipTier(seat.bet, p.level.bb);
    setHidden(s.bet, seat.bet <= 0);
    s.bet.title = exact(seat.bet);

    setText(s.hand, seat.handName || '');
    setHidden(s.hand, !seat.handName);

    // Turn clock — only the seat on the clock, and only when the server
    // gave us a deadline (bots don't get one).
    const onClock = seat.id === p.actingId && !!p.actingDeadline;
    setHidden(s.timer, !onClock);
    if (onClock) {
      s.timerFill.dataset.deadline = String(p.actingDeadline);
      s.timerFill.dataset.total = String(p.turnMs);
    }
  }
}

function updateResult(els, p) {
  const r = p.handResult;
  const showing = !!(r && r.pots && r.pots.length) && (p.stage === 'showdown' || p.stage === 'handover');
  const wasShowing = view.resultShowing;
  view.resultShowing = showing;

  // The banner takes its height from the controls, not from the table.
  // Taking it from the table meant every showdown reshaped the seat ring,
  // and on a phone in landscape there was no height left to give: seats
  // slid off the top of the screen and the banner itself came out clipped.
  // There is nothing to act on during a showdown, so the controls yield.
  setClass(els.wrap, 'is-result', showing);

  if (!showing) {
    setClass(els.result, 'is-showing', false);
    return;
  }

  // Send the pot to whoever won it, once, as the result appears.
  if (!wasShowing) {
    for (const pot of r.pots) {
      const share = Math.round(pot.amount / pot.winners.length);
      for (const w of pot.winners) {
        const seat = els.seats.get(w.id);
        if (seat) flyChips(els.pot, seat.root, chips(share), 'is-payout');
      }
    }
  }

  const parts = r.pots.map((pot) => {
    const names = pot.winners.map((w) => w.name).join(' & ');
    return `${names} ${pot.winners.length > 1 ? 'split' : 'wins'} ${chips(pot.amount)}`;
  });
  const hand = r.pots[0].winners[0] && r.pots[0].winners[0].handName;

  setText(els.resultTitle, parts.join(' · '));
  setText(els.resultSub, hand || (r.showdown ? '' : 'everyone else folded'));
  setClass(els.result, 'is-showing', true);
}

function updateLog(els, p) {
  const entries = p.log || [];
  // Entries carry a sequence number, so we append exactly what's new —
  // matching on text would duplicate repeated lines like "Atlas folds."
  for (const entry of entries) {
    if (entry.seq === undefined || entry.seq > view.lastLogSeq) {
      const line = el('div', 'pk-log-line', els.log);
      line.textContent = entry.text;
      if (entry.seq !== undefined) view.lastLogSeq = entry.seq;
    }
  }
  // Keep the tail only; the newest line is styled as the current one.
  while (els.log.children.length > 2) els.log.removeChild(els.log.firstChild);
  const kids = els.log.children;
  for (let i = 0; i < kids.length; i++) {
    setClass(kids[i], 'is-latest', i === kids.length - 1);
  }
}

/* ─── Action controls ──────────────────────────────────────────── */

function updateActions(els, p) {
  const legal = p.legal;

  // Rebuild only when the decision itself changes. Anything more eager
  // would yank the raise slider out from under a thumb mid-drag.
  const sig = legal
    ? `act:${p.handNumber}:${p.street}:${p.currentBet}:${legal.minRaiseTo}:${legal.maxRaiseTo}:${legal.toCall}`
    : `wait:${p.stage}:${p.actingId}:${p.handNumber}`;
  if (sig === view.actionSig) return;
  view.actionSig = sig;
  view.raiseDraft = null;

  els.actions.innerHTML = '';
  if (legal) buildActions(els.actions, p, legal);
  else buildWaiting(els.actions, p);
}

function buildWaiting(box, p) {
  const wrap = el('div', 'pk-waiting', box);
  const me = p.seats.find((s) => s.isMe);
  const acting = p.seats.find((s) => s.id === p.actingId);

  if (p.stage === 'complete') setText(wrap, 'Tournament over');
  else if (me && me.eliminated) setText(wrap, `You finished ${ordinal(me.place)} — watching the rest`);
  else if (me && me.folded) setText(wrap, 'You folded this hand');
  else if (me && me.allIn) setText(wrap, 'All-in — good luck');
  else if (acting) setText(wrap, `Waiting on ${acting.name}…`);
  else if (p.stage === 'showdown' || p.stage === 'handover') setText(wrap, 'Next hand shortly…');
  else setText(wrap, 'Dealing…');
}

function buildActions(box, p, legal) {
  const wrapper = el('div', 'pk-actions', box);
  let raiseBtn = null;

  const raiseLabel = () => {
    if (view.raiseDraft >= legal.maxRaiseTo) return `All-in ${chips(legal.maxRaiseTo)}`;
    return `${p.currentBet > 0 ? 'Raise to' : 'Bet'} ${chips(view.raiseDraft)}`;
  };

  if (legal.canRaise) {
    const step = Math.max(1, Math.round(p.level.bb / 2));
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    if (view.raiseDraft === null || view.raiseDraft < min || view.raiseDraft > max) view.raiseDraft = min;

    const row = el('div', 'pk-raise', wrapper);
    const amount = el('div', 'pk-raise-amount', row);
    const slider = el('input', 'pk-slider', row);
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(view.raiseDraft);

    const label = () => {
      setText(amount, view.raiseDraft >= max ? `All-in ${chips(max)}` : chips(view.raiseDraft));
      amount.title = exact(view.raiseDraft);
    };
    label();

    slider.addEventListener('input', () => {
      view.raiseDraft = Math.min(max, Math.max(min, Number(slider.value)));
      label();
      if (raiseBtn) setText(raiseBtn, raiseLabel());
    });

    const presets = el('div', 'pk-presets', row);
    const options = [
      ['Min', min],
      ['½ Pot', p.currentBet + Math.round(p.pot / 2)],
      ['Pot', p.currentBet + Math.round(p.pot)],
      ['All-in', max],
    ];
    for (const [text, value] of options) {
      const v = Math.min(max, Math.max(min, value));
      const b = el('button', 'pk-preset', presets);
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => {
        view.raiseDraft = v;
        slider.value = String(v);
        label();
        if (raiseBtn) setText(raiseBtn, raiseLabel());
      });
    }
  }

  const buttons = el('div', 'pk-buttons', wrapper);

  const fold = el('button', 'pk-btn pk-btn-fold', buttons);
  fold.type = 'button';
  fold.textContent = 'Fold';
  fold.addEventListener('click', () => act({ kind: 'fold' }));

  if (legal.canCheck) {
    const check = el('button', 'pk-btn pk-btn-check', buttons);
    check.type = 'button';
    check.textContent = 'Check';
    check.addEventListener('click', () => act({ kind: 'check' }));
  } else if (legal.canCall) {
    const call = el('button', 'pk-btn pk-btn-call', buttons);
    call.type = 'button';
    call.textContent = legal.callAmount >= legal.maxRaiseTo
      ? `Call all-in ${chips(legal.callAmount)}`
      : `Call ${chips(legal.callAmount)}`;
    call.title = exact(legal.callAmount);
    call.addEventListener('click', () => act({ kind: 'call' }));
  }

  if (legal.canRaise) {
    raiseBtn = el('button', 'pk-btn pk-btn-raise', buttons);
    raiseBtn.type = 'button';
    raiseBtn.textContent = raiseLabel();
    raiseBtn.addEventListener('click', () => act({ kind: 'raise', to: view.raiseDraft }));
  }
}

function act(action) {
  view.raiseDraft = null;
  view.actionSig = null;
  send({ type: 'game_action', action });
}

/* ─── Motion ───────────────────────────────────────────────────── */

function pulse(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

// Count a stack toward its new value. Short enough not to lag the game,
// long enough that the eye catches which stacks moved.
function countTo(node, from, to) {
  const start = performance.now();
  const dur = 550;
  if (node._countRaf) cancelAnimationFrame(node._countRaf);
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    setText(node, chips(Math.round(from + (to - from) * eased)));
    if (t < 1) node._countRaf = requestAnimationFrame(step);
    else { node._countRaf = null; setText(node, chips(to)); }
  };
  node._countRaf = requestAnimationFrame(step);
}

function showDelta(node, amount) {
  if (!amount) return;
  setText(node, (amount > 0 ? '+' : '') + chips(amount));
  setClass(node, 'is-up', amount > 0);
  setClass(node, 'is-down', amount < 0);
  pulse(node, 'is-flying');
}

// Chips travelling between two points on the table. Used both ways:
// bets going to the pot when a street closes, and the pot going to
// whoever won it. The second half was missing entirely — chips flowed
// in and then the pot simply reset, so the payoff moment, the whole
// point of the hand, had no motion at all.
function flyChips(fromEl, toEl, label, cls) {
  if (!fromEl || !toEl || !view.els) return;
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  if (!from.width || !to.width) return;

  const host = view.els.table;
  const hostRect = host.getBoundingClientRect();

  const ghost = el('span', 'pk-chip-ghost' + (cls ? ' ' + cls : ''), host);
  el('i', 'pk-chip', ghost);
  el('span', 'pk-chip-ghost-amt', ghost).textContent = label;
  ghost.style.left = (from.left - hostRect.left) + 'px';
  ghost.style.top = (from.top - hostRect.top) + 'px';

  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);

  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.7)`;
    ghost.style.opacity = '0';
  });
  setTimeout(() => ghost.remove(), 700);
}

/* ─── Turn clock ───────────────────────────────────────────────── */

// The server sends an absolute deadline rather than a countdown, so a
// slow message or a backgrounded tab can't leave the bar out of step
// with the real clock.
function startTicker(p) {
  clearInterval(view.tickTimer);
  view.tickTimer = null;
  if (!p.actingDeadline) return;

  const tick = () => {
    const fill = view.root && view.root.querySelector('.pk-seat-timer:not([hidden]) .pk-seat-timer-fill');
    if (!fill) { clearInterval(view.tickTimer); view.tickTimer = null; return; }
    const deadline = Number(fill.dataset.deadline);
    const total = Number(fill.dataset.total) || 30000;
    const remaining = Math.max(0, deadline - Date.now());
    fill.style.width = Math.max(0, Math.min(100, (remaining / total) * 100)) + '%';
    setClass(fill, 'is-low', remaining < 8000);
  };
  tick();
  view.tickTimer = setInterval(tick, 200);
}

/* ─── Tournament standings, shown on the game-over screen ──────── */

function renderHoldemStandings(host, room) {
  const result = room.result;
  host.innerHTML = '';
  if (!result || !result.standings) return;

  for (const s of result.standings) {
    const row = el('div', 'pk-standing', host);
    if (s.place === 1) row.classList.add('is-first');
    if (s.id === state.playerId) row.classList.add('is-me');

    el('span', 'pk-standing-place', row).textContent = ordinal(s.place);

    const name = el('span', 'pk-standing-name', row);
    name.textContent = s.name + (s.id === state.playerId ? ' (you)' : '');
    if (s.isAI) el('span', 'pk-seat-bot', name).textContent = 'AI';

    el('span', 'pk-standing-chips', row).textContent = s.place === 1 ? chips(s.chips) : '';
  }
}

// Register with the dispatcher in app.js.
GAME_RENDERERS.holdem = renderHoldem;
GAME_OVER_RENDERERS.holdem = renderHoldemStandings;
