// Candidate assets pulled from Poly Haven (CC0). The download script grabs all
// candidates so you can swap them in by changing ACTIVE below — no rebuild
// needed, just edit and Vite hot-reloads.
//
// Asset IDs are Poly Haven slugs. Tags: PolyHaven.com/a/<id>

export const CANDIDATES = {
  ground: [
    { id: 'aerial_grass_rock',   note: 'photo-scan grass + rock — default' },
    { id: 'forrest_ground_01',   note: 'dry forest floor, leaves' },
    { id: 'brown_mud_leaves_01', note: 'darker muddy mix' },
    { id: 'rocky_terrain_02',    note: 'sparse grass over stones' },
  ],
  hedge: [
    { id: 'forest_leaves_03',    note: 'dense leafy foliage — default' },
    { id: 'leafy_grass',         note: 'looser leafy ground/cover (fallback)' },
  ],
  hdri: [
    { id: 'evening_road_01_puresky', note: 'golden-hour empty sky — default' },
    { id: 'kloppenheim_06_puresky',  note: 'warm cloudy dusk' },
    { id: 'venice_sunset',           note: 'low warm sunset' },
    { id: 'belfast_sunset',          note: 'cool fading dusk' },
  ],
}

// Active selection — change these to swap. Vite HMR will reload the scene.
export const ACTIVE = {
  ground: 'aerial_grass_rock',
  hedge:  'forest_leaves_03',
  hdri:   'evening_road_01_puresky',
}

export const ASSET_PATHS = {
  ground: (id = ACTIVE.ground) => `/assets/ground/${id}`,
  hedge:  (id = ACTIVE.hedge)  => `/assets/hedge/${id}`,
  hdri:   (id = ACTIVE.hdri)   => `/assets/hdris/${id}.hdr`,
}
