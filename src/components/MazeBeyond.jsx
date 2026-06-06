import { BackSide } from 'three'
import { ENCLOSURE } from '../config/scene'

// A recessed dark "cave" sitting behind the gap. Inside is pitch black so
// looking through the gap reveals only darkness — the maze's mouth.
export function MazeBeyond() {
  const { backZ, gapWidth, wallHeight, wallThickness } = ENCLOSURE
  const depth = 8
  const width = gapWidth + 0.05
  const height = wallHeight + 0.05
  const z = backZ - wallThickness / 2 - depth / 2

  return (
    <group position={[0, height / 2, z]}>
      {/* inverted box — we see its inside faces from inside the gap */}
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <meshBasicMaterial color="#020207" side={BackSide} />
      </mesh>
      {/* dim floor plane inside the gap so the bottom isn't a gap-into-fog */}
      <mesh rotation-x={-Math.PI / 2} position-y={-height / 2 + 0.01}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial color="#050509" />
      </mesh>
    </group>
  )
}
