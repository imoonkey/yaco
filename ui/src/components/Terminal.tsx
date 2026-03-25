import { useRef, useEffect, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { writeTextToClipboard } from '../lib/clipboard'
import { useIsTouch } from '../hooks/useIsMobile'
import { TerminalKeyBar } from './TerminalKeyBar'
import type { TerminalKeyBarKey } from './TerminalKeyBar'

const SOLARIZED_THEME = {
  background: '#eee8d5',
  foreground: '#657b83',
  cursor: '#586e75',
  cursorAccent: '#eee8d5',
  selectionBackground: 'rgba(38, 139, 210, 0.28)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#eee8d5',
}

const TERMINAL_RIGHT_GUTTER_PX = 3
const ARROW_KEY_SUFFIX: Partial<Record<TerminalKeyBarKey, 'A' | 'B' | 'C' | 'D'>> = {
  'arrow-left': 'D',
  'arrow-down': 'B',
  'arrow-up': 'A',
  'arrow-right': 'C',
}

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
  onInteract?: () => void
  onCloseRequest?: () => void
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

function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'c') return false
  return event.metaKey || (event.ctrlKey && event.shiftKey)
}

function isCloseShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'w' && event.metaKey && !event.ctrlKey && !event.altKey
}

export function Terminal({ sessionName, onInteract, onCloseRequest, sendText, sendTextKey }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onInteractRef = useRef(onInteract)
  const onCloseRequestRef = useRef(onCloseRequest)
  const isTouch = useIsTouch()
  const [containerReady, setContainerReady] = useState(false)
  const sendTextKeyRef = useRef<number | undefined>(undefined)

  const sendInput = useCallback((data: string) => {
    onInteractRef.current?.()
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  const resolveKeyBarInput = useCallback((key: TerminalKeyBarKey, fallback: string) => {
    const suffix = ARROW_KEY_SUFFIX[key]
    if (!suffix) return fallback

    const prefix = termRef.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
    return `${prefix}${suffix}`
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

  // Main terminal initialization — only runs when container is ready.
  useEffect(() => {
    if (!containerReady || !containerRef.current) return

    const container = containerRef.current

    const term = new XTerm({
      theme: SOLARIZED_THEME,
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
      term.element.style.backgroundColor = SOLARIZED_THEME.background
      term.element.style.paddingRight = `${TERMINAL_RIGHT_GUTTER_PX}px`
      const viewport = term.element.querySelector<HTMLElement>('.xterm-viewport')
      if (viewport) viewport.style.backgroundColor = SOLARIZED_THEME.background
    }
    fitAddon.fit()
    fitTerminal(term)

    // Schedule a refit after the browser paints (container dimensions
    // may refine slightly after the initial layout pass).
    const fitAnimationFrame = requestAnimationFrame(() => {
      fitTerminal(term)
      term.refresh(0, term.rows - 1)
    })

    // Touch scroll bridge: xterm v6 registers document-level touch handlers
    // (from VS Code's scrollable element) that call preventDefault(), stealing
    // all touch events. We intercept touch, convert to WheelEvent, and dispatch
    // on xterm's screen element. This goes through xterm's normal wheel pipeline:
    // scrollback buffer for shell sessions, mouse escape sequences for tmux.
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

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsHost = window.location.host
    const ws = new WebSocket(`${wsProtocol}//${wsHost}/ws/terminal/${encodeURIComponent(sessionName)}?cols=${term.cols}&rows=${term.rows}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    let disposed = false

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = () => sendResize()

    // Raw PTY output — write directly to xterm
    ws.onmessage = (event) => {
      if (disposed) return
      term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data))
    }

    ws.onerror = () => {
      if (!disposed) term.writeln('\r\n\x1b[31m[Connection error]\x1b[0m')
    }
    ws.onclose = () => {
      if (!disposed) term.writeln('\r\n\x1b[33m[Disconnected]\x1b[0m')
    }

    // Raw input — send directly
    let imeInputHandled = false
    term.onData((data) => {
      imeInputHandled = true
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    // Mobile IME fix: xterm v6 silently drops spaces/symbols from Chinese
    // mobile keyboards. Its _inputEvent() skips insertText when the prior
    // IME keydown (keyCode 229) left _keyDownSeen=true. We catch dropped
    // input by checking if onData fired for this input event.
    // Only on touch devices — desktop keydown/keypress handle input before
    // _inputEvent runs, which would cause false positives here.
    const imeTextarea = window.matchMedia('(pointer: coarse)').matches
      ? container.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea')
      : null
    const handleUnprocessedInput = (e: Event) => {
      const ie = e as InputEvent
      if (ie.inputType !== 'insertText' || !ie.data) return
      imeInputHandled = false
      queueMicrotask(() => {
        if (!imeInputHandled && ie.data && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: ie.data }))
        }
      })
    }
    imeTextarea?.addEventListener('input', handleUnprocessedInput, { capture: true })

    term.onResize(() => sendResize())

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      // Debounce to avoid thrashing during CSS transitions (e.g. compose tray slide)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => fitTerminal(term), 150)
    })
    observer.observe(container)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      cancelAnimationFrame(fitAnimationFrame)
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      osc52Disposable.dispose()
      imeTextarea?.removeEventListener('input', handleUnprocessedInput, { capture: true })
      observer.disconnect()
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [sessionName, containerReady])

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: SOLARIZED_THEME.background }}>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        onMouseDown={onInteract}
        onFocusCapture={onInteract}
      />
      {isTouch && <TerminalKeyBar sendInput={sendInput} resolveInput={resolveKeyBarInput} />}
    </div>
  )
}
