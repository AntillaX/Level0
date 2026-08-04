// Side-pot construction.
//
// When players are all-in for different amounts, the pot splits into
// layers. A player is only eligible for the layers they actually paid
// into. Folded players still contribute their chips but win nothing.
//
// The algorithm walks the distinct commitment levels from low to high.
// At each level every player contributes the slice of their commitment
// that falls inside that band, and everyone still live who reached the
// level is eligible for the resulting pot.
//
// Worked example — A all-in 100, B all-in 300, C called 300:
//   band 0-100 : 100 x3 = 300, eligible A,B,C   (main pot)
//   band 100-300: 200 x2 = 400, eligible B,C    (side pot)

function buildPots(seats) {
  const contributors = seats.filter((s) => s.committed > 0);
  if (contributors.length === 0) return [];

  const levels = [...new Set(contributors.map((s) => s.committed))].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;

  for (const level of levels) {
    let amount = 0;
    for (const s of contributors) {
      // The portion of this player's commitment inside (prev, level].
      const slice = Math.min(s.committed, level) - Math.min(s.committed, prev);
      if (slice > 0) amount += slice;
    }

    const eligible = seats
      .filter((s) => !s.folded && s.committed >= level)
      .map((s) => s.id);

    if (amount > 0 && eligible.length > 0) {
      // Merge into the previous pot when the eligibility set is
      // identical — avoids showing "Side pot" chips that nobody can
      // actually contest separately.
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length
          && last.eligible.every((id, i) => id === eligible[i])) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    } else if (amount > 0) {
      // Everyone who reached this level folded; fold the orphaned chips
      // into the previous layer so no money vanishes.
      if (pots.length > 0) pots[pots.length - 1].amount += amount;
    }

    prev = level;
  }

  return pots;
}

// Split a pot between tied winners. Chips are indivisible, so the odd
// remainder goes to the earliest seat left of the button — the standard
// live-poker rule, applied here via the caller's seat ordering.
function splitPot(amount, winnerIds) {
  const n = winnerIds.length;
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;
  const out = {};
  for (const id of winnerIds) {
    out[id] = base;
    if (remainder > 0) {
      out[id] += 1;
      remainder--;
    }
  }
  return out;
}

module.exports = { buildPots, splitPot };
