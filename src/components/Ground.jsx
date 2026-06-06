import { usePBRMaps } from '../lib/usePBRMaps'
import { ENCLOSURE } from '../config/scene'
import { ASSET_PATHS } from '../config/assets'

export function Ground() {
  const maps = usePBRMaps(ASSET_PATHS.ground(), { repeatX: 10, repeatY: 10 })

  return (
    <mesh
      receiveShadow
      rotation-x={-Math.PI / 2}
      position-y={0}
    >
      <planeGeometry args={[ENCLOSURE.groundSize, ENCLOSURE.groundSize, 1, 1]} />
      <meshStandardMaterial
        {...(maps ?? {})}
        color={maps?.map ? '#9a988c' : '#3a382c'}
        roughness={maps?.roughnessMap ? 1.0 : 0.95}
        metalness={0}
        envMapIntensity={0.4}
      />
    </mesh>
  )
}
