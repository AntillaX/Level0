#!/usr/bin/env node
/**
 * Pulls candidate ground/hedge PBR textures and evening HDRIs from
 * Poly Haven's public API (CC0, no auth) into ./public/assets/.
 *
 *   npm run assets
 *
 * Env vars:
 *   TEX_RES   texture resolution (1k|2k|4k)  default 1k
 *   HDRI_RES  HDRI resolution    (1k|2k|4k)  default 1k
 *
 * Already-downloaded files are skipped; safe to re-run.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT  = path.join(ROOT, 'public', 'assets')

const TEX_RES  = process.env.TEX_RES  ?? '1k'
const HDRI_RES = process.env.HDRI_RES ?? '1k'

const CANDIDATES = {
  ground: ['aerial_grass_rock', 'forrest_ground_01', 'brown_mud_leaves_01', 'rocky_terrain_02'],
  hedge:  ['forest_leaves_03', 'leafy_grass'],
  hdri:   ['evening_road_01_puresky', 'kloppenheim_06_puresky', 'venice_sunset', 'belfast_sunset'],
}

// Poly Haven uses several top-level keys for the same conceptual map. We try
// each in order and save under the canonical name the app expects.
const MAP_ALIASES = {
  Diffuse: ['Diffuse', 'diff', 'Color', 'col'],
  nor_gl:  ['nor_gl', 'Normal', 'nor'],
  Rough:   ['Rough', 'rough', 'Roughness'],
  AO:      ['AO', 'ao'],
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function downloadTo(url, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()))
}

function pickFormat(node, prefer) {
  if (!node) return null
  for (const fmt of prefer) {
    if (node[fmt]?.url) return { fmt, url: node[fmt].url }
  }
  const fmt = Object.keys(node).find(k => node[k]?.url)
  return fmt ? { fmt, url: node[fmt].url } : null
}

async function downloadTexture(id, kind) {
  const files = await getJSON(`https://api.polyhaven.com/files/${id}`)
  const outDir = path.join(OUT, kind, id)

  for (const [canonical, aliases] of Object.entries(MAP_ALIASES)) {
    const top = aliases.map(a => files[a]).find(Boolean)
    if (!top) continue
    const resNode = top[TEX_RES]
    if (!resNode) {
      console.warn(`    ${canonical}: no ${TEX_RES} variant`)
      continue
    }
    const pick = pickFormat(resNode, ['jpg', 'png'])
    if (!pick) continue
    const out = path.join(outDir, `${canonical}.${pick.fmt}`)
    if (existsSync(out)) {
      console.log(`    ${canonical}.${pick.fmt} (cached)`)
      continue
    }
    console.log(`    ${canonical}.${pick.fmt}`)
    await downloadTo(pick.url, out)
  }
}

async function downloadHDRI(id) {
  const files = await getJSON(`https://api.polyhaven.com/files/${id}`)
  const node = files.hdri?.[HDRI_RES]
  if (!node) {
    console.warn(`    no ${HDRI_RES} HDRI`)
    return
  }
  const pick = pickFormat(node, ['hdr', 'exr'])
  if (!pick) return
  const out = path.join(OUT, 'hdris', `${id}.${pick.fmt}`)
  if (existsSync(out)) {
    console.log(`    ${id}.${pick.fmt} (cached)`)
    return
  }
  console.log(`    ${id}.${pick.fmt}`)
  await downloadTo(pick.url, out)
}

async function run() {
  console.log(`Poly Haven · textures ${TEX_RES}, HDRIs ${HDRI_RES}`)
  console.log(`Target: ${OUT}\n`)

  for (const [kind, ids] of Object.entries(CANDIDATES)) {
    for (const id of ids) {
      console.log(`${kind}/${id}`)
      try {
        if (kind === 'hdri') await downloadHDRI(id)
        else                 await downloadTexture(id, kind)
      } catch (e) {
        console.warn(`  ${e.message}`)
      }
    }
  }

  console.log('\nDone. Edit src/config/assets.js → ACTIVE to swap selections.')
}

run().catch((e) => { console.error(e); process.exit(1) })
