// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

// Shared spy across all fake XTerm instances. Must be declared before the
// vi.mock factory uses it (vi.mock is hoisted, so reference inside factory
// is fine as long as the binding exists at call time — vitest allows this).
const focusSpy = vi.fn()
const resizeSpy = vi.fn()
const clearSpy = vi.fn()
type OscHandler = (data: string) => boolean | Promise<boolean>
const oscHandlers = new Map<number, OscHandler[]>()
const wsSends: string[] = []

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => {
  class FakeXTerm {
    element: HTMLDivElement
    cols = 80
    rows = 24
    _core = {
      _renderService: {
        clear: clearSpy,
        dimensions: {
          css: {
            cell: { width: 10, height: 20 },
          },
        },
      },
    }
    parser = {
      registerOscHandler: (id: number, handler: OscHandler) => {
        const handlers = oscHandlers.get(id) ?? []
        handlers.push(handler)
        oscHandlers.set(id, handlers)
        return {
          dispose: () => {
            const current = oscHandlers.get(id)
            if (!current) return
            const index = current.indexOf(handler)
            if (index !== -1) current.splice(index, 1)
          },
        }
      },
    }
    options: Record<string, unknown> = {}
    focus = focusSpy
    constructor() {
      this.element = document.createElement('div')
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      const scrollable = document.createElement('div')
      scrollable.className = 'xterm-scrollable-element'
      const scrollbar = document.createElement('div')
      scrollbar.className = 'scrollbar vertical'
      scrollable.appendChild(screen)
      scrollable.appendChild(scrollbar)
      this.element.appendChild(viewport)
      this.element.appendChild(scrollable)
    }
    open(container: HTMLElement) { container.appendChild(this.element) }
    loadAddon() { /* no-op */ }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      resizeSpy(cols, rows)
    }
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('vertical') ? 14 : 0
    },
  })

  class FakeWebSocket {
    static CONNECTING = 0 as const
    static OPEN = 1 as const
    static CLOSING = 2 as const
    static CLOSED = 3 as const
    readyState = 1
    onopen: ((e: Event) => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: Event) => void) | null = null
    onclose: ((e: CloseEvent) => void) | null = null
    constructor() {
      setTimeout(() => this.onopen?.(new Event('open')), 0)
    }
    send(data: string) { wsSends.push(data) }
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
  resizeSpy.mockClear()
  clearSpy.mockClear()
  wsSends.length = 0
  oscHandlers.clear()
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

  it('lets Codex receive OSC color report queries without swallowing color setters', async () => {
    const Terminal = await loadTerminal()
    render(<Terminal sessionName="codex-session" provider="codex" />)

    for (const id of [10, 11, 12]) {
      const handler = oscHandlers.get(id)?.at(-1)
      expect(handler).toBeDefined()
      expect(handler?.('?')).toBe(false)
      expect(handler?.('?;?')).toBe(false)
      expect(handler?.('rgb:ffff/ffff/ffff')).toBe(false)
      expect(handler?.('#ffffff')).toBe(false)
      expect(handler?.('rgb:ffff/ffff/ffff;?')).toBe(false)
    }
  })

  it('still suppresses OSC color report queries for non-Codex sessions', async () => {
    const Terminal = await loadTerminal()
    render(<Terminal sessionName="shell-1" provider="shell" />)

    for (const id of [10, 11, 12]) {
      const handler = oscHandlers.get(id)?.at(-1)
      expect(handler).toBeDefined()
      expect(handler?.('?')).toBe(true)
      expect(handler?.('?;?')).toBe(true)
      expect(handler?.('rgb:ffff/ffff/ffff')).toBe(false)
    }
  })

  it('updates the OSC color query policy when provider changes', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" provider="shell" />)
    const handler = oscHandlers.get(11)?.at(-1)
    expect(handler).toBeDefined()
    expect(handler?.('?')).toBe(true)

    rerender(<Terminal sessionName="session-a" provider="codex" />)
    expect(handler?.('?')).toBe(false)
  })

  it('infers Codex OSC color passthrough from the session name before metadata arrives', async () => {
    const Terminal = await loadTerminal()
    render(<Terminal sessionName="codex-new-session" />)

    const handler = oscHandlers.get(11)?.at(-1)
    expect(handler).toBeDefined()
    expect(handler?.('?')).toBe(false)
  })

  it('reserves xterm internal scrollbar width when fitting columns', async () => {
    const Terminal = await loadTerminal()
    render(<Terminal sessionName="session-a" />)

    await waitFor(() => {
      expect(resizeSpy).toHaveBeenCalledWith(78, 20)
    })
  })

  it('sends external terminal text as text-paste instead of raw input', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" />)
    await waitFor(() => {
      expect(wsSends.some(data => data.includes('"resize"'))).toBe(true)
    })
    wsSends.length = 0

    rerender(<Terminal sessionName="session-a" sendText="hello codex" sendTextKey={1} />)

    await waitFor(() => {
      expect(wsSends).toContain(JSON.stringify({ type: 'text-paste', data: 'hello codex' }))
    })
    expect(wsSends).not.toContain(JSON.stringify({ type: 'input', data: 'hello codex' }))
  })
})
