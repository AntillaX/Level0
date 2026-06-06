import { WebGLRenderer, ACESFilmicToneMapping, SRGBColorSpace } from 'three'

// R3F's <Canvas gl={...}> accepts an async factory. We try WebGPU first and
// fall back to WebGL2. Force one by passing ?renderer=webgl or ?renderer=webgpu
// in the URL — handy for comparing.
export async function createRenderer(props) {
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams()
  const force = params.get('renderer')

  if (force !== 'webgl' && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const mod = await import('three/webgpu')
      const WebGPURenderer = mod.WebGPURenderer
      const renderer = new WebGPURenderer({
        canvas: props.canvas,
        antialias: true,
        alpha: false,
      })
      await renderer.init()
      configure(renderer)
      console.info('[renderer] WebGPU')
      return renderer
    } catch (err) {
      console.warn('[renderer] WebGPU init failed, falling back to WebGL2:', err?.message ?? err)
    }
  }

  const renderer = new WebGLRenderer({
    canvas: props.canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  })
  configure(renderer)
  console.info('[renderer] WebGL2')
  return renderer
}

function configure(renderer) {
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = SRGBColorSpace
}
