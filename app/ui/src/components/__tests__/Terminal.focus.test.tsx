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

interface FakeBufferLine {
  isWrapped: boolean
  length: number
  getCell(x: number): FakeBufferCell | undefined
  translateToString(trimRight?: boolean): string
}

interface FakeBufferCell {
  getBgColorMode(): number
  getBgColor(): number
  isBgDefault(): boolean
}

type FakeBufferRow = string | { text: string; isWrapped?: boolean; bg?: number }

let fakeLines: FakeBufferLine[] = []
const fakeBuffer = {
  type: 'alternate' as const,
  cursorY: 0,
  cursorX: 0,
  viewportY: 0,
  baseY: 0,
  get length() { return fakeLines.length },
  getLine(row: number) { return fakeLines[row] },
  getNullCell() { return {} },
}

function makeFakeLine(row: FakeBufferRow | undefined): FakeBufferLine {
  const text = typeof row === 'string' ? row : row?.text ?? ''
  const bg = typeof row === 'string' ? undefined : row?.bg
  return {
    isWrapped: typeof row === 'string' ? false : row?.isWrapped ?? false,
    length: 80,
    getCell: (x: number) => {
      if (x < 0 || x >= 80) return undefined
      return {
        getBgColorMode: () => bg == null ? 0 : 3,
        getBgColor: () => bg ?? 0,
        isBgDefault: () => bg == null,
      }
    },
    translateToString: (trimRight?: boolean) => trimRight ? text.trimEnd() : text,
  }
}

function resetFakeBuffer(rows: FakeBufferRow[] = [''], cursorY: number = rows.length - 1): void {
  fakeLines = Array.from({ length: 24 }, (_, index) => makeFakeLine(rows[index]))
  fakeBuffer.cursorY = Math.max(0, cursorY)
  fakeBuffer.cursorX = 0
  fakeBuffer.viewportY = 0
  fakeBuffer.baseY = 0
}

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
    buffer = { active: fakeBuffer }
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
    onCursorMove() { return { dispose: () => undefined } }
    onWriteParsed() { return { dispose: () => undefined } }
    onScroll() { return { dispose: () => undefined } }
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
  resetFakeBuffer()
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

  it('frames the current Codex input prompt with horizontal rules', async () => {
    resetFakeBuffer([
      { text: '› write a fix that wraps onto the next line' },
      { text: '  continued input', isWrapped: true },
      '  yaco · main · custom status · Full Access',
    ], 1)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.width).toBe('786px')
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('frames explicit multiline Codex input rows', async () => {
    resetFakeBuffer([
      { text: '› first line' },
      { text: '  second line' },
      { text: '  third line' },
      '  yaco · main · custom status · Full Access',
    ], 2)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('keeps Codex prompt frames across user-authored blank and unindented lines', async () => {
    const promptBg = 0xf2ecd9
    resetFakeBuffer([
      { text: '› first paragraph', bg: promptBg },
      { text: 'second paragraph is not indented', bg: promptBg },
      { text: '', bg: promptBg },
      { text: 'third paragraph after an explicit blank line', bg: promptBg },
      '• assistant output',
    ], 3)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('79px')
    })
  })

  it('ignores Codex prompt background when trimming trailing blank rows before replies', async () => {
    const promptBg = 0xf2ecd9
    resetFakeBuffer([
      { text: '› [Image #1] 这两条线，在我刚启动 codex,有 input box background color 的时候，', bg: promptBg },
      { text: '显示是错的，bottom line 多往下了一行，现在没背景色了，反而对了。', bg: promptBg },
      { text: '', bg: promptBg },
      { text: '' },
      '• Working (5s • esc to interrupt)',
    ], 4)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('frames multiline Codex prompts identically with and without prompt backgrounds', async () => {
    const Terminal = await loadTerminal()
    const promptBg = 0xf2ecd9
    const baseRows = [
      { text: '› first line' },
      { text: '  second line' },
      { text: '  third line' },
      '  yaco · main · custom status · Full Access',
    ] satisfies FakeBufferRow[]
    async function readFrameHeight(rows: FakeBufferRow[]): Promise<string> {
      resetFakeBuffer(rows, 2)
      const { container, unmount } = render(<Terminal sessionName="codex-session" provider="codex" />)
      try {
        await waitFor(() => {
          expect(container.querySelector('[data-terminal-input-frame="true"]')).not.toBeNull()
        })
        return container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')?.style.height ?? ''
      } finally {
        unmount()
      }
    }

    const withoutBg = await readFrameHeight(baseRows)
    const withBg = await readFrameHeight(baseRows.map(row => typeof row === 'string' ? row : { ...row, bg: promptBg }))

    expect(withoutBg).toBe('59px')
    expect(withBg).toBe(withoutBg)
  })

  it('trims trailing blank rows when a Codex prompt has no visible boundary below it', async () => {
    const promptBg = 0xf2ecd9
    resetFakeBuffer([
      { text: '› first line', bg: promptBg },
      { text: '  second line', bg: promptBg },
      { text: '', bg: promptBg },
      '',
      '',
    ], 1)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('keeps the final content row when trimming no-boundary Codex prompt blanks', async () => {
    const promptBg = 0xf2ecd9
    resetFakeBuffer([
      { text: '› first line', bg: promptBg },
      { text: '  second line', bg: promptBg },
      { text: '  third line', bg: promptBg },
      { text: '', bg: promptBg },
      '',
    ], 2)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('does not treat indented quote glyphs as Codex prompt starts', async () => {
    resetFakeBuffer([
      { text: '  › quoted user prompt in assistant output' },
      { text: '  still assistant output' },
    ], 1)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      expect(resizeSpy).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-terminal-input-frame="true"]')).toBeNull()
  })

  it('frames explicit multiline historical Codex prompt rows', async () => {
    resetFakeBuffer([
      { text: '› previous prompt' },
      { text: '  second prompt line' },
      { text: '  third prompt line' },
      '',
      '• assistant output after submit',
      { text: '  indented output detail' },
    ], 5)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('stops no-background Codex prompt frames at line-start reply bullets', async () => {
    resetFakeBuffer([
      { text: '› previous prompt' },
      { text: '  second prompt line' },
      { text: '' },
      { text: 'unindented markdown after a blank line' },
      '• later output',
    ], 4)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('79px')
    })
  })

  it('stops no-background Codex prompt frames at conversation-interrupted rows', async () => {
    resetFakeBuffer([
      { text: '› previous prompt' },
      { text: 'retry with simpler steps' },
      { text: '' },
      '■ Conversation interrupted - tell the model what to do differently.',
    ], 3)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('stops no-background Codex prompt frames at line-start shell marker rows', async () => {
    resetFakeBuffer([
      { text: '› previous prompt' },
      { text: 'run this command' },
      { text: '' },
      '$ npm test',
    ], 3)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('stops no-background Codex prompt frames at line-start MCP warning rows', async () => {
    resetFakeBuffer([
      { text: '› previous prompt' },
      { text: 'check available mcp servers' },
      { text: '' },
      '⚠ MCP startup interrupted. The following servers were not initialized: codex_apps',
    ], 3)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('leaves slash command suggestions below active Codex prompt frames', async () => {
    resetFakeBuffer([
      { text: '› /' },
      { text: '' },
      '/model          choose what model and reasoning effort to use',
      '/fast           1.5x speed, increased usage',
      '/ide            include current selection, open files, and other context from your IDE',
    ], 0)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('leaves shell command suggestions below active Codex prompt frames', async () => {
    resetFakeBuffer([
      { text: '› abc $' },
      { text: '' },
      'GitHub          [Plugin] Triage PRs, issues, CI, and publish flows',
      'Gmail           [Plugin] Read and manage Gmail',
      'CI Debug        [Skill] Debug failing GitHub Actions checks',
      'OpenAI Docs     [Skill] Reference OpenAI docs, Codex self-knowledge, and model migration guidance',
    ], 0)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('leaves shell command suggestions below active multiline Codex prompt frames', async () => {
    resetFakeBuffer([
      { text: '› ask about available tools' },
      { text: '  abc $' },
      { text: '' },
      'GitHub          [Plugin] Triage PRs, issues, CI, and publish flows',
      'CI Debug        [Skill] Debug failing GitHub Actions checks',
    ], 1)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('stops no-background Codex prompt frames at dot-separated status lines', async () => {
    resetFakeBuffer([
      { text: '› Improve documentation in @filename' },
      { text: '' },
      { text: 'Run from the monorepo root unless noted:' },
      { text: '  yaco · main · custom status · Full Access' },
    ], 3)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('stops no-background Codex prompt frames at bottom queue-message status lines', async () => {
    resetFakeBuffer([
      { text: '› dfdsa' },
      'tab to queue message                         100% context left',
    ], 0)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('39px')
    })
  })

  it('does not treat queue-message text before nonblank content as a status line', async () => {
    resetFakeBuffer([
      { text: '› mention status text' },
      'tab to queue message',
      'still part of the prompt',
      '• later output',
    ], 2)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('59px')
    })
  })

  it('does not treat dot-separated rows before nonblank content as status lines', async () => {
    resetFakeBuffer([
      { text: '› compare alpha · beta · gamma' },
      { text: '' },
      { text: '  yaco · main · custom status · Full Access' },
      { text: 'more input after dot-separated row' },
      '• later output',
    ], 4)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frame = container.querySelector<HTMLElement>('[data-terminal-input-frame="true"]')
      expect(frame).not.toBeNull()
      expect(frame?.style.top).toBe('0px')
      expect(frame?.style.height).toBe('79px')
    })
  })

  it('frames visible historical Codex user prompts too', async () => {
    resetFakeBuffer([
      'assistant output',
      { text: '› older prompt' },
      { text: '  wrapped older prompt', isWrapped: true },
      '• more assistant output',
      { text: '› current prompt' },
      '  yaco · main · custom status · Full Access',
    ], 4)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="codex-session" provider="codex" />)

    await waitFor(() => {
      const frames = Array.from(container.querySelectorAll<HTMLElement>('[data-terminal-input-frame="true"]'))
      expect(frames).toHaveLength(2)
      expect(frames.map(frame => frame.style.top)).toEqual(['1px', '61px'])
      expect(frames.map(frame => frame.style.height)).toEqual(['58px', '58px'])
    })
  })

  it('does not frame non-Codex terminal prompt-looking rows', async () => {
    resetFakeBuffer(['›'], 0)
    const Terminal = await loadTerminal()
    const { container } = render(<Terminal sessionName="shell-1" provider="shell" />)

    await waitFor(() => {
      expect(resizeSpy).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-terminal-input-frame="true"]')).toBeNull()
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
