# Level 0 — Waiting Area

A small, atmospheric 3D web scene: a fenced patch of ground at late evening
with a dark gap in the far hedge leading to a maze that hasn't been built
yet. React Three Fiber + Drei on a Three.js renderer (WebGPU when
available, WebGL2 otherwise).

## Stack

- Vite + React 18
- `@react-three/fiber`, `@react-three/drei`, `three@0.170`
- WebGPU renderer (`three/webgpu`) with automatic WebGL2 fallback
- Poly Haven (CC0) for ground PBR, hedge foliage, and evening HDRIs

## Run it

```bash
npm install
npm run assets     # fetches candidate textures + HDRIs from polyhaven.com
npm run dev        # http://localhost:5173
```

First load before `npm run assets` finishes still renders — materials
fall back to flat colors, the scene runs without an HDRI.

Force a renderer for comparison:

- `http://localhost:5173/?renderer=webgl`
- `http://localhost:5173/?renderer=webgpu`

## Controls

- Click the canvas to lock the pointer
- **WASD** / arrows to move
- Mouse to look
- **Esc** to release

Movement is clamped inside the hedge enclosure. The gap in the far wall
is walkable — keep going and you enter a short dark stub where the maze
will eventually attach.

## Picking different assets

`scripts/download-assets.mjs` pulls every candidate listed in
`src/config/assets.js`. To swap what the scene uses, edit `ACTIVE`:

```js
// src/config/assets.js
export const ACTIVE = {
  ground: 'aerial_grass_rock',          // try forrest_ground_01, brown_mud_leaves_01, ...
  hedge:  'forest_leaves_03',
  hdri:   'evening_road_01_puresky',    // try venice_sunset, kloppenheim_06_puresky, ...
}
```

Add any other Poly Haven slug to `CANDIDATES` in the same file, re-run
`npm run assets`, and Vite HMR picks it up.

Resolutions are configurable for the download step:

```bash
TEX_RES=2k HDRI_RES=2k npm run assets
```

## Layout & tuning

`src/config/scene.js` holds the enclosure dimensions, fog falloff, player
speed, and start position. Changes are picked up on save.

```
                    -Z (far)
       ┌─────────┐ ─┴─ ┌─────────┐    ← hedge, gap in middle
       │         │     │         │
   -X  │      [ open ground ]    │  +X
       │                         │
       └─────────────────────────┘
            (open — fades into fog)
                    +Z
```

## Project layout

```
index.html                Vite entry
src/
  main.jsx                React mount
  App.jsx                 Canvas + overlay + lock state
  Scene.jsx               Lights, fog, environment, scene composition
  components/
    Ground.jsx
    HedgeWalls.jsx        L/R/back walls (back has a centered gap)
    MazeBeyond.jsx        dark recessed box visible through the gap
    FPSPlayer.jsx         WASD + collision against the enclosure
  lib/
    createRenderer.js     WebGPU → WebGL2 fallback
    usePBRMaps.js         Optional-map PBR loader (Diffuse/nor_gl/Rough/AO)
    SafeBoundary.jsx      Swallows render-time errors for optional children
  config/
    scene.js              Dimensions, fog, player
    assets.js             Poly Haven candidates + active selection
scripts/
  download-assets.mjs     Poly Haven downloader
public/
  assets/                 Downloaded textures + HDRIs (gitignored)
```

The old `server.js` / `server/` / `deploy/` directories are vestiges
from the previous (multiplayer tic-tac-toe) scaffold and are not used by
this scene.
