// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// Shared spy across all fake XTerm instances. Must be declared before the
// vi.mock factory uses it (vi.mock is hoisted, so reference inside factory
// is fine as long as the binding exists at call time — vitest allows this).
const focusSpy = vi.fn()

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => {
  class FakeXTerm {
    element: HTMLDivElement
    cols = 80
    rows = 24
    parser = { registerOscHandler: () => ({ dispose: () => undefined }) }
    options: Record<string, unknown> = {}
    focus = focusSpy
    constructor() {
      this.element = document.createElement('div')
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      this.element.appendChild(screen)
      this.element.appendChild(viewport)
    }
    open(container: HTMLElement) { container.appendChild(this.element) }
    loadAddon() { /* no-op */ }
    resize() { /* no-op */ }
    refresh() { /* no-op */ }
    dispose() { /* no-op */ }
    write() { /* no-op */ }
    clear() { /* no-op */ }
    attachCustomKeyEventHandler() { /* no-op */ }
    onData() { return { dispose: () => undefined } }
    onResize() { return { dispose: () => undefined } }
    onSelectionChange() { return { dispose: () => undefined } }
    onBell() { return { dispose: () => undefined } }
    hasSelection() { return false }
    getSelection() { return '' }
    clearSelection() { /* no-op */ }
  }
  return { Terminal: FakeXTerm }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { /* no-op */ } },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

// jsdom reports clientHeight = 0 which prevents Terminal from flipping
// containerReady. Override on the prototype for the duration of the test.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 400,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  })

  class FakeWebSocket {
    static CONNECTING = 0 as const
    static OPEN = 1 as const
    static CLOSING = 2 as const
    static CLOSED = 3 as const
    readyState = 0
    onopen: ((e: Event) => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: Event) => void) | null = null
    onclose: ((e: CloseEvent) => void) | null = null
    send() { /* no-op */ }
    close() { this.readyState = 3 }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)

  vi.stubGlobal('ResizeObserver', class {
    observe() { /* no-op */ }
    disconnect() { /* no-op */ }
    unobserve() { /* no-op */ }
  })

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))

  focusSpy.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Import Terminal AFTER mocks are set up (dynamic import inside test to
// ensure the mock factories register before module evaluation).
async function loadTerminal() {
  const mod = await import('../Terminal')
  return mod.Terminal
}

describe('Terminal focus handoff', () => {
  it('refocuses xterm when sessionName prop changes', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" />)
    // At least one focus call from the mount lifecycle — clear it so we only
    // measure the session-change behavior.
    expect(focusSpy).toHaveBeenCalled()
    focusSpy.mockClear()

    rerender(<Terminal sessionName="session-b" />)
    expect(focusSpy).toHaveBeenCalledTimes(1)

    rerender(<Terminal sessionName="session-c" />)
    expect(focusSpy).toHaveBeenCalledTimes(2)
  })

  it('does not call focus on unrelated prop changes', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" />)
    focusSpy.mockClear()

    // Change an unrelated prop; focus should not fire.
    rerender(<Terminal sessionName="session-a" projectName="proj-1" />)
    expect(focusSpy).not.toHaveBeenCalled()
  })
})
