// Tournament structure — turbo.
//
// Everyone starts with $1,000,000, which is 100 big blinds at the
// opening level. Blinds step up every 8 hands and a big-blind ante
// kicks in at level 4 to keep pots worth fighting for as stacks get
// shallow. A 9-handed table lands in the 35-45 minute range; the
// schedule runs out of levels well before it could stall, since by the
// last level one big blind exceeds the entire chips-in-play of a
// 9-player table.

const STARTING_CHIPS = 1000000;
const HANDS_PER_LEVEL = 8;

const BLIND_SCHEDULE = [
  { sb: 5000, bb: 10000, ante: 0 },
  { sb: 8000, bb: 16000, ante: 0 },
  { sb: 12000, bb: 25000, ante: 0 },
  { sb: 20000, bb: 40000, ante: 40000 },
  { sb: 30000, bb: 60000, ante: 60000 },
  { sb: 50000, bb: 100000, ante: 100000 },
  { sb: 75000, bb: 150000, ante: 150000 },
  { sb: 125000, bb: 250000, ante: 250000 },
  { sb: 200000, bb: 400000, ante: 400000 },
  { sb: 300000, bb: 600000, ante: 600000 },
  { sb: 500000, bb: 1000000, ante: 1000000 },
  { sb: 800000, bb: 1600000, ante: 1600000 },
  { sb: 1250000, bb: 2500000, ante: 2500000 },
  { sb: 2000000, bb: 4000000, ante: 4000000 },
  { sb: 3000000, bb: 6000000, ante: 6000000 },
];

// Past the end of the schedule we just stay at the top level — with
// blinds that big the table cannot survive more than a hand or two.
function levelAt(index) {
  return BLIND_SCHEDULE[Math.min(index, BLIND_SCHEDULE.length - 1)];
}

function levelForHand(handNumber) {
  return Math.floor((handNumber - 1) / HANDS_PER_LEVEL);
}

module.exports = {
  STARTING_CHIPS,
  HANDS_PER_LEVEL,
  BLIND_SCHEDULE,
  levelAt,
  levelForHand,
};
