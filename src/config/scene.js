// Dimensions for the small outdoor enclosure.
// Camera looks down -Z by default; far wall is at -Z, open side is +Z.

export const ENCLOSURE = {
  halfX: 9,            // left wall at -halfX, right wall at +halfX
  backZ: -7,           // far wall (with gap)
  frontZ: 7,           // open side (no wall, fades into fog)
  gapWidth: 3,         // width of the maze-entrance opening
  wallHeight: 4,
  wallThickness: 0.6,
  groundSize: 60,
  playerRadius: 0.35,  // for AABB collision
  playerEyeHeight: 1.7,
}

export const FOG = {
  color: '#1a1822',
  near: 6,
  far: 28,
}

export const PLAYER = {
  speed: 3.2,
  start: [0, ENCLOSURE.playerEyeHeight, 5.5],
}
