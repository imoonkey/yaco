import { useRef, useEffect } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { writeTextToClipboard } from '../lib/clipboard'

const SOLARIZED_THEME = {
  background: '#eee8d5',
  foreground: '#657b83',
  cursor: '#586e75',
  cursorAccent: '#eee8d5',
  selectionBackground: '#eee8d5',
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

export function Terminal({ sessionName, onInteract, onCloseRequest }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onInteractRef = useRef(onInteract)
  const onCloseRequestRef = useRef(onCloseRequest)

  useEffect(() => {
    onInteractRef.current = onInteract
  }, [onInteract])

  useEffect(() => {
    onCloseRequestRef.current = onCloseRequest
  }, [onCloseRequest])

  useEffect(() => {
    if (!containerRef.current) return

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
    wsRef.current = ws

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = () => sendResize()

    // Raw PTY output — write directly to xterm
    ws.onmessage = (event) => {
      term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data))
    }

    ws.onerror = () => term.writeln('\r\n\x1b[31m[Connection error]\x1b[0m')
    ws.onclose = () => term.writeln('\r\n\x1b[33m[Disconnected]\x1b[0m')

    // Raw input — send directly
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    term.onResize(() => sendResize())

    const observer = new ResizeObserver(() => fitTerminal(term))
    observer.observe(container)

    return () => {
      container.removeEventListener('focusin', handleFocusIn)
      osc52Disposable.dispose()
      observer.disconnect()
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [sessionName])

  return <div ref={containerRef} className="h-full w-full" style={{ backgroundColor: SOLARIZED_THEME.background }} onMouseDown={onInteract} onFocusCapture={onInteract} />
}
