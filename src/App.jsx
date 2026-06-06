import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Scene } from './Scene'
import { createRenderer } from './lib/createRenderer'

export function App() {
  const controlsRef = useRef(null)
  const [locked, setLocked] = useState(false)
  const [gpuWarning, setGpuWarning] = useState(null)

  useEffect(() => {
    const onChange = () => setLocked(!!document.pointerLockElement)
    document.addEventListener('pointerlockchange', onChange)
    return () => document.removeEventListener('pointerlockchange', onChange)
  }, [])

  // Surface fatal renderer issues
  useEffect(() => {
    const onErr = (e) => {
      const msg = e?.message ?? String(e?.error ?? '')
      if (/webgpu|webgl/i.test(msg)) setGpuWarning(msg)
    }
    window.addEventListener('error', onErr)
    return () => window.removeEventListener('error', onErr)
  }, [])

  const requestLock = () => controlsRef.current?.lock?.()

  return (
    <>
      <Canvas
        gl={createRenderer}
        camera={{ position: [0, 1.7, 5.5], fov: 70, near: 0.05, far: 80 }}
        shadows
        dpr={[1, 1.6]}
      >
        <Scene ref={controlsRef} />
      </Canvas>

      {locked && <div className="crosshair" aria-hidden />}

      {!locked && (
        <div className="overlay" onClick={requestLock}>
          <div className="panel">
            <h1>waiting area</h1>
            <p>click to enter</p>
            <p className="hint">WASD · mouse to look · esc to release</p>
          </div>
        </div>
      )}

      {gpuWarning && (
        <div className="warning">{gpuWarning}</div>
      )}
    </>
  )
}
