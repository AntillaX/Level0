import { useMemo } from 'react'
import { usePBRMaps } from '../lib/usePBRMaps'
import { ENCLOSURE } from '../config/scene'
import { ASSET_PATHS } from '../config/assets'

// Tall hedge walls on left, right, far. Far wall has a centered gap.
export function HedgeWalls() {
  const maps = usePBRMaps(ASSET_PATHS.hedge(), { repeatX: 3, repeatY: 1.2 })

  const segments = useMemo(() => {
    const { halfX, backZ, frontZ, gapWidth, wallHeight, wallThickness } = ENCLOSURE
    const halfGap = gapWidth / 2
    const centerZ = (backZ + frontZ) / 2
    const sideLen = frontZ - backZ + wallThickness
    const backSegW = halfX - halfGap

    return [
      // left wall
      { pos: [-halfX, wallHeight / 2, centerZ], size: [wallThickness, wallHeight, sideLen] },
      // right wall
      { pos: [ halfX, wallHeight / 2, centerZ], size: [wallThickness, wallHeight, sideLen] },
      // far wall, left of gap
      { pos: [-(halfGap + backSegW / 2), wallHeight / 2, backZ], size: [backSegW, wallHeight, wallThickness] },
      // far wall, right of gap
      { pos: [ halfGap + backSegW / 2, wallHeight / 2, backZ], size: [backSegW, wallHeight, wallThickness] },
    ]
  }, [])

  return (
    <group>
      {segments.map((seg, i) => (
        <mesh key={i} castShadow receiveShadow position={seg.pos}>
          <boxGeometry args={seg.size} />
          <meshStandardMaterial
            {...(maps ?? {})}
            color={maps?.map ? '#6c7a52' : '#2d3a22'}
            roughness={1.0}
            metalness={0}
            envMapIntensity={0.35}
          />
        </mesh>
      ))}
    </group>
  )
}
