import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { ENCLOSURE, PLAYER } from '../config/scene'

const MAZE_DEPTH = 8 // matches <MazeBeyond /> depth

// Module-scoped keyboard state — single instance even under StrictMode
const keys = { forward: false, back: false, left: false, right: false }

function bindKey(code, down) {
  switch (code) {
    case 'KeyW': case 'ArrowUp':    keys.forward = down; break
    case 'KeyS': case 'ArrowDown':  keys.back    = down; break
    case 'KeyA': case 'ArrowLeft':  keys.left    = down; break
    case 'KeyD': case 'ArrowRight': keys.right   = down; break
  }
}

function constrain(prevX, prevZ, nextX, nextZ) {
  const { halfX, backZ, frontZ, gapWidth, wallThickness, playerRadius } = ENCLOSURE
  const r = playerRadius
  const halfThick = wallThickness / 2
  const halfGap = gapWidth / 2

  // Resolve X using prev Z's region (slide along the wall you're hitting)
  let x = nextX
  const prevInEnclosure = prevZ >= backZ + halfThick + r
  if (prevInEnclosure) {
    x = Math.max(-halfX + halfThick + r, Math.min(halfX - halfThick - r, x))
  } else {
    x = Math.max(-halfGap + r, Math.min(halfGap - r, x))
  }

  // Resolve Z based on whether the new X sits inside the gap column
  let z = nextZ
  const inGapColumn = Math.abs(x) <= halfGap - r
  if (inGapColumn) {
    // walk-through allowed; back wall is the cave's back
    z = Math.max(backZ - MAZE_DEPTH + r, z)
  } else {
    // far hedge stops us
    z = Math.max(backZ + halfThick + r, z)
  }

  // Soft front cap so we don't drift forever into the fog
  z = Math.min(frontZ + 10, z)

  return [x, z]
}

export function FPSPlayer() {
  const { camera } = useThree()
  const forward = useRef(new Vector3())
  const right   = useRef(new Vector3())
  const move    = useRef(new Vector3())

  // Place camera once on mount
  useEffect(() => {
    camera.position.set(...PLAYER.start)
    camera.lookAt(0, PLAYER.start[1], ENCLOSURE.backZ)
  }, [camera])

  useEffect(() => {
    const down = (e) => bindKey(e.code, true)
    const up   = (e) => bindKey(e.code, false)
    const blur = () => { keys.forward = keys.back = keys.left = keys.right = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useFrame((_state, dt) => {
    const f = +keys.forward - +keys.back
    const s = +keys.right   - +keys.left
    if (f === 0 && s === 0) return

    // Camera-facing forward, projected to the ground plane
    camera.getWorldDirection(forward.current)
    forward.current.y = 0
    if (forward.current.lengthSq() < 1e-6) return
    forward.current.normalize()
    right.current.crossVectors(forward.current, camera.up).normalize()

    move.current.set(0, 0, 0)
      .addScaledVector(forward.current, f)
      .addScaledVector(right.current, s)
    if (move.current.lengthSq() > 1) move.current.normalize()
    move.current.multiplyScalar(PLAYER.speed * Math.min(dt, 0.05))

    const [nx, nz] = constrain(
      camera.position.x,
      camera.position.z,
      camera.position.x + move.current.x,
      camera.position.z + move.current.z,
    )
    camera.position.x = nx
    camera.position.z = nz
    camera.position.y = PLAYER.start[1]
  })

  return null
}
