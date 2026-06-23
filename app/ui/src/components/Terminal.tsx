import { useRef, useEffect, useCallback, useState } from 'react'
import { isCloseShortcut, isCopyShortcut } from '../lib/shortcuts'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { writeTextToClipboard } from '../lib/clipboard'
import { readCodexInputPromptFrames, sameInputPromptFrames, type InputPromptFrame } from '../lib/codexInputPromptFrame'
import { getProviderUi } from '../lib/providerUi'
import { useIsTouch } from '../hooks/useIsMobile'
import { TerminalKeyBar } from './TerminalKeyBar'
import type { TerminalKeyBarKey, Modifiers } from './TerminalKeyBar'

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function parsePx(value: string): number {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// Resolve the provider before metadata arrives so terminal presentation policy
// can lock in from the session name alone.
function inferProvider(provider: string | undefined, sessionName: string): string | undefined {
  if (provider) return provider
  const lower = sessionName.toLowerCase()
  if (lower.includes('codex')) return 'codex'
  if (lower.includes('claude')) return 'claude'
  if (lower.startsWith('shell-')) return 'shell'
  return undefined
}

function buildXtermTheme() {
  return {
    background: getCssVar('--sol-editor-bg'),
    foreground: getCssVar('--sol-editor-fg'),
    cursor: getCssVar('--sol-text'),
    cursorAccent: getCssVar('--sol-editor-bg'),
    selectionBackground: getCssVar('--sol-blue') + '47',
    black: getCssVar('--sol-base02'),
    red: getCssVar('--sol-red'),
    green: getCssVar('--sol-green'),
    yellow: getCssVar('--sol-yellow'),
    blue: getCssVar('--sol-blue'),
    magenta: getCssVar('--sol-magenta'),
    cyan: getCssVar('--sol-cyan'),
    white: getCssVar('--sol-base2'),
    brightBlack: getCssVar('--sol-base03'),
    brightRed: getCssVar('--sol-orange'),
    brightGreen: getCssVar('--sol-base01'),
    brightYellow: getCssVar('--sol-base00'),
    brightBlue: getCssVar('--sol-base0'),
    brightMagenta: getCssVar('--sol-violet'),
    brightCyan: getCssVar('--sol-base1'),
    brightWhite: getCssVar('--sol-base3'),
  }
}

interface TerminalPalettePayload {
  foreground: string
  background: string
  cursor: string
}

function readTerminalPalette(): TerminalPalettePayload {
  const theme = buildXtermTheme()
  return {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
  }
}

const ARROW_KEY_SUFFIX: Partial<Record<TerminalKeyBarKey, 'A' | 'B' | 'C' | 'D'>> = {
  'arrow-left': 'D',
  'arrow-down': 'B',
  'arrow-up': 'A',
  'arrow-right': 'C',
}
const ARROW_KEY_SUFFIXES = new Set(['A', 'B', 'C', 'D'])

const WS_RECONNECT_MAX_RETRIES = 5
const WS_RECONNECT_INITIAL_MS = 1000
const WS_RECONNECT_MAX_MS = 15000
const WS_PRESSURE_INITIAL_MS = 5000
const WS_PRESSURE_MAX_MS = 60000
const WS_PRESSURE_CLOSE_CODE = 4002
const TERMINAL_SCROLLBACK_ROWS = 0
const TERMINAL_RIGHT_CLIP_CUSHION_CELLS = 1
const INPUT_PROMPT_FRAME_COLOR = 'color-mix(in srgb, var(--sol-cyan) 62%, var(--sol-editor-bg))'

type TerminalWithCore = XTerm & {
  _core?: {
    _renderService?: {
      clear?: () => void
      dimensions?: {
        css?: {
          cell?: {
            width: number
            height: number
          }
        }
      }
    }
  }
}

function fitTerminal(term: XTerm): void {
  const element = term.element
  const parent = element?.parentElement
  const core = (term as TerminalWithCore)._core
  const cell = core?._renderService?.dimensions?.css?.cell
  if (!element || !parent || !cell?.width || !cell.height) return

  const style = window.getComputedStyle(element)
  const paddingX = parsePx(style.paddingLeft) + parsePx(style.paddingRight)
  const paddingY = parsePx(style.paddingTop) + parsePx(style.paddingBottom)
  const viewport = element.querySelector<HTMLElement>('.xterm-viewport')
  const nativeScrollbarWidth = viewport ? Math.max(0, viewport.offsetWidth - viewport.clientWidth) : 0
  const xtermScrollbar = element.querySelector<HTMLElement>('.xterm-scrollable-element > .scrollbar.vertical')
  const scrollbarWidth = term.options.scrollback === 0 ? 0 : Math.max(nativeScrollbarWidth, xtermScrollbar?.offsetWidth ?? 0)
  const rightClipCushion = Math.ceil(cell.width * TERMINAL_RIGHT_CLIP_CUSHION_CELLS)
  element.style.setProperty('--yaco-terminal-right-clip-cushion', `${rightClipCushion}px`)
  const availableWidth = parent.clientWidth - paddingX - scrollbarWidth - rightClipCushion
  const cols = Math.max(2, Math.floor(availableWidth / cell.width))
  const rows = Math.max(1, Math.floor((parent.clientHeight - paddingY) / cell.height))
  if (term.cols === cols && term.rows === rows) return

  core?._renderService?.clear?.()
  term.resize(cols, rows)
}

interface TerminalProps {
  sessionName: string
  projectName?: string
  provider?: string
  onInteract?: () => void
  onFocus?: () => void
  onCloseRequest?: () => void
  onDisconnect?: () => void
  sendText?: string | null
  sendTextKey?: number
  onOpenCompose?: () => void
}

function decodeOsc52Payload(payload: string): string | null {
  try {
    const bytes = Uint8Array.from(window.atob(payload.replace(/\s+/g, '')), char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function isOscColorReportQuery(data: string): boolean {
  const parts = data.split(';').map(part => part.trim())
  return parts.length > 0 && parts.every(part => part === '?')
}

function suppressOscColorReportQuery(data: string, provider?: string): boolean {
  if (!isOscColorReportQuery(data)) return false
  return getProviderUi(provider).terminal.suppressOscColorReportQuery
}

function applyModifiers(data: string, mods: Modifiers): string | null {
  if (mods.meta && data.length === 1) {
    const key = data.toLowerCase()
    if (key === 'p' || key === 'b') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true }))
      return null
    }
    return `\x1b${data}` // Meta sends ESC prefix
  }
  if (mods.ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0)
    if (code >= 65 && code <= 90) return String.fromCharCode(code - 64) // Ctrl+A-Z
  }
  if (mods.shift) {
    const arrowSuffix = data.length === 3 && data.startsWith('\x1b[') ? data[2] : ''
    if (ARROW_KEY_SUFFIXES.has(arrowSuffix)) return `\x1b[1;2${arrowSuffix}` // Shift+arrow
    if (data === '\t') return '\x1b[Z' // Shift+Tab
  }
  return data
}

function buildWsUrl(sessionName: string, cols: number, rows: number, palette: TerminalPalettePayload, projectName?: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = new URLSearchParams({
    cols: String(cols),
    rows: String(rows),
    fg: palette.foreground,
    bg: palette.background,
    cursor: palette.cursor,
  })
  if (projectName) params.set('project', projectName)
  return `${proto}//${host}/ws/terminal/${encodeURIComponent(sessionName)}?${params.toString()}`
}

export function Terminal({ sessionName, projectName, provider, onInteract, onFocus, onCloseRequest, onDisconnect, sendText, sendTextKey, onOpenCompose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onInteractRef = useRef(onInteract)
  const onFocusRef = useRef(onFocus)
  const onCloseRequestRef = useRef(onCloseRequest)
  const onDisconnectRef = useRef(onDisconnect)
  // Resolve the provider once per render so terminal contrast and OSC suppression
  // share one policy source, including the session-name inference before metadata.
  const resolvedProvider = inferProvider(provider, sessionName)
  const providerRef = useRef(resolvedProvider)
  const isTouch = useIsTouch()
  const [containerReady, setContainerReady] = useState(false)
  const [inputPromptFrames, setInputPromptFrames] = useState<InputPromptFrame[]>([])
  const sendTextKeyRef = useRef<number | undefined>(undefined)
  const [modifiers, setModifiers] = useState<Modifiers>({ ctrl: false, shift: false, meta: false })
  const modifiersRef = useRef(modifiers)
  useEffect(() => { modifiersRef.current = modifiers }, [modifiers])

  useEffect(() => {
    providerRef.current = resolvedProvider
  }, [resolvedProvider])

  const sendInput = useCallback((data: string) => {
    onInteractRef.current?.()
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  const pasteText = useCallback((data: string) => {
    onInteractRef.current?.()
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text-paste', data }))
    }
  }, [])

  const resolveKeyBarInput = useCallback((key: TerminalKeyBarKey, fallback: string) => {
    const mods = modifiersRef.current
    const suffix = ARROW_KEY_SUFFIX[key]
    let seq = fallback
    if (suffix) {
      const prefix = termRef.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
      seq = `${prefix}${suffix}`
    }
    if (mods.ctrl || mods.shift || mods.meta) {
      const out = applyModifiers(seq, mods)
      setModifiers({ ctrl: false, shift: false, meta: false })
      if (out === null) return ''
      return out
    }
    return seq
  }, [])

  // External text injection (voice compose send) — no trailing newline
  useEffect(() => {
    if (sendText == null || sendTextKeyRef.current === sendTextKey) return
    sendTextKeyRef.current = sendTextKey
    pasteText(sendText)
    // Focus xterm so user can immediately press Enter to execute
    termRef.current?.focus()
  }, [sendText, sendTextKey, pasteText])

  useEffect(() => {
    onInteractRef.current = onInteract
  }, [onInteract])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    onCloseRequestRef.current = onCloseRequest
  }, [onCloseRequest])

  useEffect(() => {
    onDisconnectRef.current = onDisconnect
  }, [onDisconnect])

  // Wait for container to have real dimensions before initializing xterm.
  // On PWA cold start, flex layout may not have settled yet — opening
  // xterm in a 0-height container breaks its renderer permanently.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (el.clientHeight > 0) {
      setContainerReady(true)
      return
    }
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) {
        observer.disconnect()
        setContainerReady(true)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // --- Effect 1: xterm lifecycle (lives for the component's mount lifetime) ---
  useEffect(() => {
    if (!containerReady || !containerRef.current) return

    const container = containerRef.current

    const initialTheme = buildXtermTheme()
    const term = new XTerm({
      theme: initialTheme,
      // xterm can't read CSS vars — pull the resolved --font-mono (already
      // platform-adjusted by the index.html script: SF Mono on Mac, JetBrains
      // Mono elsewhere) so the terminal matches the rest of the app.
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || "ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      // Workflow attaches to tmux sessions; tmux owns scrollback/history. Keeping
      // browser-side xterm scrollback reserves a permanent ~14px right gutter,
      // which costs 1-2 usable terminal columns in the embedded pane.
      scrollback: TERMINAL_SCROLLBACK_ROWS,
      // Real value is applied by the provider effect below (keeps the xterm
      // instance from being recreated on session switch). 1 = no adjustment.
      minimumContrastRatio: 1,
      cursorBlink: true,
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    if (term.element) {
      term.element.classList.add('yaco-terminal-xterm')
      term.element.style.setProperty('--yaco-terminal-right-clip-cushion', '0px')
      term.element.style.boxSizing = 'border-box'
      term.element.style.height = '100%'
      term.element.style.backgroundColor = 'var(--sol-editor-bg)'
      const viewport = term.element.querySelector<HTMLElement>('.xterm-viewport')
      if (viewport) viewport.style.backgroundColor = 'var(--sol-editor-bg)'
    }
    fitAddon.fit()
    fitTerminal(term)
    term.focus()

    const fitAnimationFrame = requestAnimationFrame(() => {
      fitTerminal(term)
      term.refresh(0, term.rows - 1)
    })

    let inputPromptFrameRaf: number | null = null
    const applyInputPromptFrame = () => {
      inputPromptFrameRaf = null
      const next = readCodexInputPromptFrames(term, getProviderUi(providerRef.current).terminal.inputPromptFrame)
      setInputPromptFrames(prev => sameInputPromptFrames(prev, next) ? prev : next)
    }
    const scheduleInputPromptFrame = () => {
      if (inputPromptFrameRaf != null) return
      inputPromptFrameRaf = requestAnimationFrame(applyInputPromptFrame)
    }
    scheduleInputPromptFrame()
    const inputPromptFrameDisposables = [
      term.onCursorMove(scheduleInputPromptFrame),
      term.onWriteParsed(scheduleInputPromptFrame),
      term.onScroll(scheduleInputPromptFrame),
      term.onResize(scheduleInputPromptFrame),
    ]

    // Touch scroll bridge
    let touchY: number | null = null
    const screenEl = term.element?.querySelector('.xterm-screen') ?? term.element

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchY = e.touches[0].clientY
        e.stopPropagation()
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || e.touches.length !== 1 || !screenEl) return
      const currentY = e.touches[0].clientY
      const deltaY = touchY - currentY
      touchY = currentY
      screenEl.dispatchEvent(new WheelEvent('wheel', {
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: e.touches[0].clientX,
        clientY: e.touches[0].clientY,
        bubbles: true,
        cancelable: true,
      }))
      e.preventDefault()
      e.stopPropagation()
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (touchY !== null) e.stopPropagation()
      touchY = null
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: true })
    container.addEventListener('touchcancel', onTouchEnd, { passive: true })

    // Focus moving into the terminal (including the programmatic `term.focus()` on
    // mount / session switch) is FOCUS, not a genuine interaction — route it to
    // onFocus so it never pins a freshly-created preview terminal. Pinning is left
    // to real input (mousedown / keystroke / paste), mirroring the editor's
    // promote-on-edit.
    const handleFocusIn = () => {
      onFocusRef.current?.()
    }
    container.addEventListener('focusin', handleFocusIn)

    const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
      const separatorIndex = data.indexOf(';')
      if (separatorIndex === -1) return false

      const payload = data.slice(separatorIndex + 1)
      if (!payload || payload === '?') return true

      const text = decodeOsc52Payload(payload)
      if (text == null) return true

      void writeTextToClipboard(text)
      return true
    })

    const oscColorDisposables = [10, 11, 12].map(id =>
      term.parser.registerOscHandler(id, data => suppressOscColorReportQuery(data, providerRef.current))
    )

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        onInteractRef.current?.()
      }

      if (event.type === 'keydown' && onCloseRequestRef.current && isCloseShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        onCloseRequestRef.current()
        return false
      }

      if (event.type !== 'keydown' || !term.hasSelection() || !isCopyShortcut(event)) {
        return true
      }

      event.preventDefault()
      event.stopPropagation()
      void writeTextToClipboard(term.getSelection()).then((copied) => {
        if (copied) term.clearSelection()
      })
      return false
    })

    // Raw input — send to current WebSocket via ref
    let imeInputHandled = false
    term.onData((data) => {
      imeInputHandled = true
      const mods = modifiersRef.current
      if (mods.ctrl || mods.shift || mods.meta) {
        const out = applyModifiers(data, mods)
        setModifiers({ ctrl: false, shift: false, meta: false })
        if (out === null) return
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data: out }))
        }
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    // IME fix: xterm v6 silently drops characters from Chinese/CJK IME input.
    let keyDownHandledByXterm = false
    const handleKeyDown = (e: KeyboardEvent) => {
      keyDownHandledByXterm = e.keyCode !== 229
    }
    const handleUnprocessedInput = (e: Event) => {
      const ie = e as InputEvent
      if (ie.inputType !== 'insertText' || !ie.data) return
      if (keyDownHandledByXterm) {
        keyDownHandledByXterm = false
        return
      }
      imeInputHandled = false
      setTimeout(() => {
        if (!imeInputHandled && ie.data && wsRef.current?.readyState === WebSocket.OPEN) {
          onInteractRef.current?.() // CJK/IME input → pin a previewed terminal
          const mods = modifiersRef.current
          if (mods.ctrl || mods.shift || mods.meta) {
            const out = applyModifiers(ie.data, mods)
            setModifiers({ ctrl: false, shift: false, meta: false })
            if (out === null) return
            wsRef.current!.send(JSON.stringify({ type: 'input', data: out }))
          } else {
            wsRef.current!.send(JSON.stringify({ type: 'input', data: ie.data }))
          }
        }
      }, 0)
    }
    container.addEventListener('keydown', handleKeyDown, { capture: true })
    container.addEventListener('input', handleUnprocessedInput, { capture: true })

    // Image paste: when the clipboard contains an image (e.g. a screenshot
    // pasted into a TUI agent like Claude Code or Codex), forward the bytes
    // to the server so it can mirror them into the desktop's X11 clipboard
    // and trigger the agent's native paste handler. Text paste is left to
    // xterm's default path (which already streams via WS input).
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      onInteractRef.current?.() // a genuine paste (text or image) → pin a previewed terminal
      for (const item of items) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        event.preventDefault()
        event.stopPropagation()
        file.arrayBuffer().then((buf) => {
          const ws = wsRef.current
          if (ws?.readyState !== WebSocket.OPEN) return
          const u8 = new Uint8Array(buf)
          let binary = ''
          const chunkSize = 0x8000
          for (let i = 0; i < u8.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize) as unknown as number[])
          }
          ws.send(JSON.stringify({ type: 'image-paste', mime: file.type || 'image/png', base64: btoa(binary) }))
        }).catch((err) => {
          console.warn('[terminal] image paste failed', err)
        })
        return
      }
    }
    container.addEventListener('paste', handlePaste, { capture: true })

    // Resize: send dimensions to current WebSocket via ref
    term.onResize(() => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })

    // Refit at most once per animation frame while the container resizes, so
    // the grid tracks splitter drags instead of freezing until the drag pauses.
    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (resizeRaf != null) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        fitTerminal(term)
      })
    })
    observer.observe(container)

    // Live theme switching
    const themeObserver = new MutationObserver(() => {
      term.options.theme = buildXtermTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      themeObserver.disconnect()
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf)
      if (inputPromptFrameRaf != null) cancelAnimationFrame(inputPromptFrameRaf)
      cancelAnimationFrame(fitAnimationFrame)
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      osc52Disposable.dispose()
      for (const disposable of oscColorDisposables) disposable.dispose()
      for (const disposable of inputPromptFrameDisposables) disposable.dispose()
      container.removeEventListener('keydown', handleKeyDown, { capture: true })
      container.removeEventListener('input', handleUnprocessedInput, { capture: true })
      container.removeEventListener('paste', handlePaste, { capture: true })
      observer.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [containerReady])

  // --- Effect 2: WebSocket lifecycle with reconnection ---
  useEffect(() => {
    const term = termRef.current
    if (!containerReady || !term) return

    let disposed = false
    let firstConnect = true
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stableTimer: ReturnType<typeof setTimeout> | null = null
    let failCount = 0
    let pressureMode = false

    // Minimum time a connection must stay open before we consider it "stable"
    // and reset failCount.  If the session is dead, tmux outputs an error and
    // exits within milliseconds — the connection never reaches this threshold.
    const STABLE_MS = 5000

    function createWs() {
      const url = buildWsUrl(sessionName, term!.cols, term!.rows, readTerminalPalette(), projectName)
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        if (disposed) { ws.close(); return }
        if (firstConnect) {
          firstConnect = false
          // Reset terminal state to clear stale content and escape sequences
          // (e.g. mouse tracking left enabled by a prior Claude Code session).
          // \ec = RIS (Reset to Initial State) — clears screen, resets modes.
          // Follow with \e[?25h because xterm.js RIS doesn't reset isCursorHidden.
          term!.write('\x1bc\x1b[?25h')
        }
        ws.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }))
        // Reset fail counter once connection is stable
        stableTimer = setTimeout(() => { failCount = 0 }, STABLE_MS)
      }

      ws.onmessage = (event) => {
        if (disposed) return
        term!.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data))
      }

      ws.onerror = () => {
        // onclose handles everything
      }

      ws.onclose = (event) => {
        if (stableTimer) { clearTimeout(stableTimer); stableTimer = null }
        if (disposed) return
        // 4001 = PTY exited (session ended) — detach immediately, no reconnect
        if (event.code === 4001) {
          onDisconnectRef.current?.()
          return
        }
        pressureMode = event.code === WS_PRESSURE_CLOSE_CODE
        scheduleReconnect()
      }
    }

    function scheduleReconnect() {
      failCount++
      if (failCount > WS_RECONNECT_MAX_RETRIES) {
        term!.writeln('\r\n\x1b[31m[Disconnected]\x1b[0m')
        onDisconnectRef.current?.()
        return
      }
      if (failCount === 1) {
        const msg = pressureMode
          ? '\r\n\x1b[33m[Server overloaded — retrying...]\x1b[0m'
          : '\r\n\x1b[33m[Reconnecting...]\x1b[0m'
        term!.writeln(msg)
      }
      const base = pressureMode ? WS_PRESSURE_INITIAL_MS : WS_RECONNECT_INITIAL_MS
      const cap = pressureMode ? WS_PRESSURE_MAX_MS : WS_RECONNECT_MAX_MS
      const delay = Math.min(base * Math.pow(2, failCount - 1), cap)
      const jitter = delay * (0.5 + Math.random())
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (disposed) return
        createWs()
      }, jitter)
    }

    // Force reconnect on wake from sleep — tab becomes visible, WS may be dead
    const handleVisibility = () => {
      if (document.hidden || disposed) return
      const ws = wsRef.current
      if (ws && ws.readyState <= WebSocket.OPEN) return // still connected
      // Cancel pending backoff and reconnect immediately
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      scheduleReconnect()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    createWs()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibility)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (stableTimer) clearTimeout(stableTimer)
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
      wsRef.current = null
    }
  }, [sessionName, containerReady, projectName])

  // Re-focus xterm whenever the attached session changes, so keyboard shortcut
  // / sidebar click handoff puts the user directly into the terminal.
  useEffect(() => {
    if (!sessionName) return
    termRef.current?.focus()
  }, [sessionName])

  // The XTerm instance is shared across attached sessions, so re-apply the
  // provider-specific contrast floor whenever the attached session changes.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const terminalPolicy = getProviderUi(resolvedProvider).terminal
    term.options.minimumContrastRatio = terminalPolicy.minimumContrastRatio
    const next = readCodexInputPromptFrames(term, terminalPolicy.inputPromptFrame)
    setInputPromptFrames(prev => sameInputPromptFrames(prev, next) ? prev : next)
    term.refresh(0, term.rows - 1)
  }, [resolvedProvider, containerReady])

  return (
    // data-terminal-surface marks the keyboard-owning region (xterm helper
    // textarea + key-bar paste textarea) so useKeyboardViewport only shrinks
    // #root when the terminal — not a normal input — opened the keyboard.
    <div data-terminal-surface className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--sol-editor-bg)' }}>
      {/* overflow-hidden clips the xterm grid to the terminal's own panel box: on a
          one-shot viewport jump (e.g. unplugging a monitor) the grid keeps its old
          wide cols for the single frame before the ResizeObserver re-fit lands, and
          would otherwise paint over the neighbouring panel. This is ABOVE the row-
          level right-edge cushion (`.xterm-rows > div` padding in index.css) and the
          fit reserves that cushion, so a row's last glyph always ends inside this box
          — the clip never eats characters. */}
      <div
        className="relative flex-1 min-h-0 w-full select-text overflow-hidden"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        onMouseDown={onInteract}
        onFocusCapture={onFocus}
      >
        <div
          ref={containerRef}
          className="absolute inset-0 select-text"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        />
        {inputPromptFrames.map((frame, index) => (
          <div
            key={`${frame.top}:${frame.height}:${index}`}
            aria-hidden="true"
            data-terminal-input-frame="true"
            className="pointer-events-none absolute z-[4]"
            style={{
              left: 0,
              width: frame.width,
              top: frame.top,
              height: frame.height,
              borderTop: `${getProviderUi(resolvedProvider).terminal.inputPromptFrame?.lineWidth ?? 1}px solid ${INPUT_PROMPT_FRAME_COLOR}`,
              borderBottom: `${getProviderUi(resolvedProvider).terminal.inputPromptFrame?.lineWidth ?? 1}px solid ${INPUT_PROMPT_FRAME_COLOR}`,
            }}
          />
        ))}
      </div>
      {isTouch && <TerminalKeyBar sendInput={sendInput} resolveInput={resolveKeyBarInput} modifiers={modifiers} onModifierChange={setModifiers} onOpenCompose={onOpenCompose} />}
    </div>
  )
}
