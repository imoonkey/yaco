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
const wsUrls: string[] = []
/** Every fake socket built, so a test can drive a drop the way the network would. */
const wsInstances: { readyState: number; onclose: ((e: CloseEvent) => void) | null }[] = []
/** xterm resize listeners, so a test can fire one the way a refit would. */
const resizeHandlers: ((size: { cols: number; rows: number }) => void)[] = []

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
    options: Record<string, unknown>
    focus = focusSpy
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options }
      this.element = document.createElement('div')
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      Object.defineProperty(screen, 'clientWidth', {
        configurable: true,
        get: () => 786,
      })
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
    writeln() { /* no-op */ }
    clear() { /* no-op */ }
    attachCustomKeyEventHandler() { /* no-op */ }
    onData() { return { dispose: () => undefined } }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      resizeHandlers.push(handler)
      return { dispose: () => undefined }
    }
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
    constructor(url?: string) {
      wsUrls.push(String(url ?? ''))
      wsInstances.push(this)
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
  wsUrls.length = 0
  resizeHandlers.length = 0
  wsInstances.length = 0
  oscHandlers.clear()
  document.documentElement.style.setProperty('--sol-editor-bg', '#fdf6e3')
  document.documentElement.style.setProperty('--sol-editor-fg', '#657b83')
  document.documentElement.style.setProperty('--sol-text', '#657b83')
  document.documentElement.style.setProperty('--sol-blue', '#268bd2')
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

  it('reserves one cell as a right clip cushion without counting hidden xterm scrollbars', async () => {
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="session-a" />)

    await waitFor(() => {
      expect(resizeSpy).toHaveBeenCalledWith(79, 20)
    })
    expect(container.querySelector<HTMLElement>('.yaco-terminal-xterm')?.style.getPropertyValue('--yaco-terminal-right-clip-cushion')).toBe('10px')
  })

  it('passes the resolved terminal palette to the terminal websocket', async () => {
    const Terminal = await loadTerminal()
    render(<Terminal sessionName="session-a" />)

    await waitFor(() => {
      expect(wsUrls.length).toBeGreaterThan(0)
    })
    const url = decodeURIComponent(wsUrls[0]!)
    expect(url).toContain('fg=#657b83')
    expect(url).toContain('bg=#fdf6e3')
    expect(url).toContain('cursor=#657b83')
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

// A kept-but-hidden pane (PanelGroup's keep-alive) must not act like a visible one:
// its tmux client is still attached, so pushing its size to the PTY would resize the
// tmux window under a device that is actually looking at that session, and it must not
// hold keyboard focus.
describe('Terminal visibility', () => {
  const resizes = () => wsSends.filter((s) => JSON.parse(s).type === 'resize')
  const fireXtermResize = () => { for (const h of resizeHandlers) h({ cols: 100, rows: 30 }) }

  it('does not push a refit to the PTY while hidden', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" visible />)
    await waitFor(() => expect(wsUrls).toHaveLength(1))

    rerender(<Terminal sessionName="session-a" visible={false} />)
    wsSends.length = 0
    fireXtermResize()

    expect(resizes(), 'a hidden pane must not resize its tmux window').toHaveLength(0)
  })

  it('hands the PTY its current size when it becomes visible again', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" visible />)
    await waitFor(() => expect(wsUrls).toHaveLength(1))
    rerender(<Terminal sessionName="session-a" visible={false} />)
    wsSends.length = 0

    rerender(<Terminal sessionName="session-a" visible />)

    expect(resizes(), 'the size it reached while hidden is sent once on show').toHaveLength(1)
  })

  it('does not re-attach a dropped socket until the pane is visible again', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" visible />)
    await waitFor(() => expect(wsUrls).toHaveLength(1))
    rerender(<Terminal sessionName="session-a" visible={false} />)

    // The socket drops while nobody is looking at this pane. Re-attaching would hand
    // the server this pane's cols/rows, which it applies with `tmux resize-window`.
    const dropped = wsInstances[0]
    dropped.readyState = 3
    dropped.onclose?.({ code: 1006 } as CloseEvent)
    // Past the reconnect backoff (1000ms base x 0.5-1.5 jitter), so this is a real
    // "never reconnects", not "has not reconnected yet".
    await new Promise((r) => setTimeout(r, 2_000))
    expect(wsUrls, 'a hidden pane must not re-attach').toHaveLength(1)

    // Showing the pane resumes it through the normal backoff path (base 1000ms).
    rerender(<Terminal sessionName="session-a" visible />)
    await waitFor(() => expect(wsUrls).toHaveLength(2), { timeout: 4_000 })
  })

  it('never attaches while hidden: not on mount, not on a backoff armed while visible', async () => {
    const Terminal = await loadTerminal()

    // Mounting hidden (a lazily imported Terminal whose chunk resolves after a tab
    // switch) must not attach — the attach itself sizes the tmux window.
    const first = render(<Terminal sessionName="session-a" visible={false} />)
    await new Promise((r) => setTimeout(r, 100))
    expect(wsUrls, 'a pane that mounts hidden must not attach').toHaveLength(0)
    first.unmount()
    wsUrls.length = 0
    wsInstances.length = 0

    // A reconnect armed WHILE VISIBLE must not fire after the user switches away.
    const second = render(<Terminal sessionName="session-b" visible />)
    await waitFor(() => expect(wsUrls).toHaveLength(1))
    const dropped = wsInstances[0]
    dropped.readyState = 3
    dropped.onclose?.({ code: 1006 } as CloseEvent)   // backoff timer now armed
    second.rerender(<Terminal sessionName="session-b" visible={false} />)

    await new Promise((r) => setTimeout(r, 2_000))
    expect(wsUrls, 'the armed backoff must not attach a hidden pane').toHaveLength(1)
  })

  it('takes focus on the hidden -> visible edge, and never while hidden', async () => {
    const Terminal = await loadTerminal()
    const { rerender } = render(<Terminal sessionName="session-a" visible />)
    rerender(<Terminal sessionName="session-a" visible={false} />)
    focusSpy.mockClear()

    // Still hidden: a session rebind must not pull focus into an unseen pane.
    rerender(<Terminal sessionName="session-b" visible={false} />)
    expect(focusSpy).not.toHaveBeenCalled()

    rerender(<Terminal sessionName="session-b" visible />)
    expect(focusSpy).toHaveBeenCalledTimes(1)
  })
})
