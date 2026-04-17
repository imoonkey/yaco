import { useRef, useEffect, useCallback, useState } from 'react'
import { isCloseShortcut, isCopyShortcut } from '../lib/shortcuts'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { writeTextToClipboard } from '../lib/clipboard'
import { useIsTouch } from '../hooks/useIsMobile'
import { TerminalKeyBar } from './TerminalKeyBar'
import type { TerminalKeyBarKey, Modifiers } from './TerminalKeyBar'

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
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

const TERMINAL_RIGHT_GUTTER_PX = 3
const ARROW_KEY_SUFFIX: Partial<Record<TerminalKeyBarKey, 'A' | 'B' | 'C' | 'D'>> = {
  'arrow-left': 'D',
  'arrow-down': 'B',
  'arrow-up': 'A',
  'arrow-right': 'C',
}

const WS_RECONNECT_MAX_RETRIES = 5
const WS_RECONNECT_INITIAL_MS = 1000
const WS_RECONNECT_MAX_MS = 15000

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
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  const viewport = element.querySelector<HTMLElement>('.xterm-viewport')
  const scrollbarWidth = viewport ? Math.max(0, viewport.offsetWidth - viewport.clientWidth) : 0
  const cols = Math.max(2, Math.floor((parent.clientWidth - paddingX - scrollbarWidth) / cell.width))
  const rows = Math.max(1, Math.floor((parent.clientHeight - paddingY) / cell.height))
  if (term.cols === cols && term.rows === rows) return

  core?._renderService?.clear?.()
  term.resize(cols, rows)
}

interface TerminalProps {
  sessionName: string
  projectName?: string
  onInteract?: () => void
  onCloseRequest?: () => void
  onDisconnect?: () => void
  sendText?: string | null
  sendTextKey?: number
}

function decodeOsc52Payload(payload: string): string | null {
  try {
    const bytes = Uint8Array.from(window.atob(payload.replace(/\s+/g, '')), char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function applyModifiers(data: string, mods: Modifiers): string {
  if (mods.ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0)
    if (code >= 65 && code <= 90) return String.fromCharCode(code - 64) // Ctrl+A-Z
  }
  if (mods.shift) {
    const m = data.match(/^\x1b\[([ABCD])$/)
    if (m) return `\x1b[1;2${m[1]}` // Shift+arrow
    if (data === '\t') return '\x1b[Z' // Shift+Tab
  }
  return data
}

function buildWsUrl(sessionName: string, cols: number, rows: number, projectName?: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${proto}//${host}/ws/terminal/${encodeURIComponent(sessionName)}?cols=${cols}&rows=${rows}${projectName ? `&project=${encodeURIComponent(projectName)}` : ''}`
}

export function Terminal({ sessionName, projectName, onInteract, onCloseRequest, onDisconnect, sendText, sendTextKey }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onInteractRef = useRef(onInteract)
  const onCloseRequestRef = useRef(onCloseRequest)
  const onDisconnectRef = useRef(onDisconnect)
  const isTouch = useIsTouch()
  const [containerReady, setContainerReady] = useState(false)
  const sendTextKeyRef = useRef<number | undefined>(undefined)
  const [modifiers, setModifiers] = useState<Modifiers>({ ctrl: false, shift: false })
  const modifiersRef = useRef(modifiers)
  useEffect(() => { modifiersRef.current = modifiers }, [modifiers])

  const sendInput = useCallback((data: string) => {
    onInteractRef.current?.()
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
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
    const out = (mods.ctrl || mods.shift) ? applyModifiers(seq, mods) : seq
    if (mods.ctrl || mods.shift) setModifiers({ ctrl: false, shift: false })
    return out
  }, [])

  // External text injection (voice compose send) — no trailing newline
  useEffect(() => {
    if (sendText == null || sendTextKeyRef.current === sendTextKey) return
    sendTextKeyRef.current = sendTextKey
    sendInput(sendText)
    // Focus xterm so user can immediately press Enter to execute
    termRef.current?.focus()
  }, [sendText, sendTextKey, sendInput])

  useEffect(() => {
    onInteractRef.current = onInteract
  }, [onInteract])

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
      fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    if (term.element) {
      term.element.style.boxSizing = 'border-box'
      term.element.style.height = '100%'
      term.element.style.backgroundColor = 'var(--sol-editor-bg)'
      term.element.style.paddingRight = `${TERMINAL_RIGHT_GUTTER_PX}px`
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

    const handleFocusIn = () => {
      onInteractRef.current?.()
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
      const out = (mods.ctrl || mods.shift) ? applyModifiers(data, mods) : data
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data: out }))
      }
      if (mods.ctrl || mods.shift) {
        setModifiers({ ctrl: false, shift: false })
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
          const mods = modifiersRef.current
          const out = (mods.ctrl || mods.shift) ? applyModifiers(ie.data, mods) : ie.data
          wsRef.current!.send(JSON.stringify({ type: 'input', data: out }))
          if (mods.ctrl || mods.shift) {
            setModifiers({ ctrl: false, shift: false })
          }
        }
      }, 0)
    }
    container.addEventListener('keydown', handleKeyDown, { capture: true })
    container.addEventListener('input', handleUnprocessedInput, { capture: true })

    // Resize: send dimensions to current WebSocket via ref
    term.onResize(() => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => fitTerminal(term), 150)
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
      if (resizeTimer) clearTimeout(resizeTimer)
      cancelAnimationFrame(fitAnimationFrame)
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      osc52Disposable.dispose()
      container.removeEventListener('keydown', handleKeyDown, { capture: true })
      container.removeEventListener('input', handleUnprocessedInput, { capture: true })
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

    // Minimum time a connection must stay open before we consider it "stable"
    // and reset failCount.  If the session is dead, tmux outputs an error and
    // exits within milliseconds — the connection never reaches this threshold.
    const STABLE_MS = 5000

    function createWs() {
      const url = buildWsUrl(sessionName, term!.cols, term!.rows, projectName)
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
        term!.writeln('\r\n\x1b[33m[Reconnecting...]\x1b[0m')
      }
      const delay = Math.min(WS_RECONNECT_INITIAL_MS * Math.pow(2, failCount - 1), WS_RECONNECT_MAX_MS)
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

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--sol-editor-bg)' }}>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        onMouseDown={onInteract}
        onFocusCapture={onInteract}
      />
      {isTouch && <TerminalKeyBar sendInput={sendInput} resolveInput={resolveKeyBarInput} modifiers={modifiers} onModifierChange={setModifiers} />}
    </div>
  )
}
