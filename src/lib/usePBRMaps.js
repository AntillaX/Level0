import { useEffect, useState } from 'react'
import { TextureLoader, RepeatWrapping, SRGBColorSpace } from 'three'

const loader = new TextureLoader()

function tryLoad(url) {
  return new Promise((resolve) => {
    loader.load(url, resolve, undefined, () => resolve(null))
  })
}

// Poly Haven sometimes ships .jpg, sometimes .png. Try both, return whichever
// loads — or null if neither exists yet (assets not downloaded).
async function loadOptional(base, name) {
  for (const ext of ['jpg', 'png']) {
    const t = await tryLoad(`${base}/${name}.${ext}`)
    if (t) return t
  }
  return null
}

export function usePBRMaps(base, { repeatX = 1, repeatY = 1, anisotropy = 8 } = {}) {
  const [maps, setMaps] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadOptional(base, 'Diffuse'),
      loadOptional(base, 'nor_gl'),
      loadOptional(base, 'Rough'),
      loadOptional(base, 'AO'),
    ]).then(([diffuse, normal, rough, ao]) => {
      if (cancelled) return
      const next = {}
      if (diffuse) {
        diffuse.colorSpace = SRGBColorSpace
        next.map = diffuse
      }
      if (normal) next.normalMap = normal
      if (rough)  next.roughnessMap = rough
      if (ao)     next.aoMap = ao
      for (const t of Object.values(next)) {
        t.wrapS = t.wrapT = RepeatWrapping
        t.repeat.set(repeatX, repeatY)
        t.anisotropy = anisotropy
      }
      setMaps(next)
    })
    return () => { cancelled = true }
  }, [base, repeatX, repeatY, anisotropy])

  return maps
}
