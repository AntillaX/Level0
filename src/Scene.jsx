import { Suspense, forwardRef } from 'react'
import { Environment, PointerLockControls } from '@react-three/drei'

import { Ground } from './components/Ground'
import { HedgeWalls } from './components/HedgeWalls'
import { MazeBeyond } from './components/MazeBeyond'
import { FPSPlayer } from './components/FPSPlayer'
import { SafeBoundary } from './lib/SafeBoundary'
import { ASSET_PATHS } from './config/assets'
import { FOG } from './config/scene'

export const Scene = forwardRef(function Scene(_props, controlsRef) {
  return (
    <>
      <color attach="background" args={[FOG.color]} />
      <fog attach="fog" args={[FOG.color, FOG.near, FOG.far]} />

      {/* Evening HDRI drives ambient/env light. If the file isn't there yet,
          SafeBoundary swallows the error and we fall back to lights alone. */}
      <SafeBoundary label="Environment">
        <Suspense fallback={null}>
          <Environment
            files={ASSET_PATHS.hdri()}
            environmentIntensity={0.5}
            background={false}
          />
        </Suspense>
      </SafeBoundary>

      {/* Low warm "sun" raking from the side */}
      <directionalLight
        position={[14, 7, -6]}
        intensity={1.3}
        color="#ffb27a"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      {/* Soft cool fill so unlit faces aren't fully black */}
      <ambientLight intensity={0.1} color="#3a4258" />

      <Suspense fallback={null}>
        <Ground />
        <HedgeWalls />
      </Suspense>
      <MazeBeyond />

      <PointerLockControls ref={controlsRef} />
      <FPSPlayer />
    </>
  )
})
