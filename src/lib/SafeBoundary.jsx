import { Component } from 'react'

// Renders nothing instead of crashing the whole tree when a child throws.
// Used around <Environment> so the scene still loads when an HDRI 404s.
export class SafeBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err) {
    console.warn(`[SafeBoundary:${this.props.label ?? '?'}]`, err?.message ?? err)
    this.props.onFail?.(err)
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children
  }
}
