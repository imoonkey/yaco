import { useState, useRef, useCallback, useEffect } from 'react'
import { Ellipsis } from 'lucide-react'
import type { MouseEvent, SyntheticEvent, TouchEvent } from 'react'

type KeyDef = {
  id: TerminalKeyBarKey
  label: string
  ariaLabel: string
  seq: string
  repeatable?: true
}

export type TerminalKeyBarKey =
  | 'escape'
  | 'tab'
  | 'enter'
  | 'arrow-left'
  | 'arrow-down'
  | 'arrow-up'
  | 'arrow-right'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-z'
  | 'ctrl-l'
  | 'ctrl-r'
  | 'ctrl-o'
  | 'ctrl-b'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-w'
  | 'ctrl-u'

export type Modifiers = { ctrl: boolean; shift: boolean }

const PRIMARY_KEYS: KeyDef[] = [
  { id: 'escape', label: 'Esc', ariaLabel: 'Escape', seq: '\x1b' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', seq: '\t' },
  { id: 'enter', label: '↵', ariaLabel: 'Enter', seq: '\r' },
  { id: 'arrow-left', label: '←', ariaLabel: 'Left arrow', seq: '\x1b[D', repeatable: true },
  { id: 'arrow-down', label: '↓', ariaLabel: 'Down arrow', seq: '\x1b[B', repeatable: true },
  { id: 'arrow-up', label: '↑', ariaLabel: 'Up arrow', seq: '\x1b[A', repeatable: true },
  { id: 'arrow-right', label: '→', ariaLabel: 'Right arrow', seq: '\x1b[C', repeatable: true },
]

const SECONDARY_KEYS: KeyDef[] = [
  { id: 'ctrl-c', label: 'C', ariaLabel: 'Control C', seq: '\x03' },
  { id: 'ctrl-d', label: 'D', ariaLabel: 'Control D', seq: '\x04' },
  { id: 'ctrl-z', label: 'Z', ariaLabel: 'Control Z', seq: '\x1a' },
  { id: 'ctrl-l', label: 'L', ariaLabel: 'Control L', seq: '\x0c' },
  { id: 'ctrl-r', label: 'R', ariaLabel: 'Control R', seq: '\x12' },
  { id: 'ctrl-o', label: 'O', ariaLabel: 'Control O', seq: '\x0f' },
  { id: 'ctrl-b', label: 'B', ariaLabel: 'Control B', seq: '\x02' },
  { id: 'ctrl-a', label: 'A', ariaLabel: 'Control A', seq: '\x01' },
  { id: 'ctrl-e', label: 'E', ariaLabel: 'Control E', seq: '\x05' },
  { id: 'ctrl-w', label: 'W', ariaLabel: 'Control W', seq: '\x17' },
  { id: 'ctrl-u', label: 'U', ariaLabel: 'Control U', seq: '\x15' },
]

const ALL_KEYS = [...PRIMARY_KEYS, ...SECONDARY_KEYS]

const BTN =
  'min-w-[32px] h-7 px-1.5 rounded bg-[rgba(0,0,0,0.08)] active:bg-[rgba(0,0,0,0.18)] text-[--sol-base01] font-mono text-xs select-none touch-manipulation'
const BTN_ACTIVE =
  'min-w-[32px] h-7 px-1.5 rounded bg-[--sol-blue] text-[--sol-base3] font-mono text-xs select-none touch-manipulation'

export function TerminalKeyBar({
  sendInput,
  resolveInput,
  modifiers,
  onModifierChange,
}: {
  sendInput: (data: string) => void
  resolveInput?: (key: TerminalKeyBarKey, fallback: string) => string
  modifiers: Modifiers
  onModifierChange: (m: Modifiers) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const suppressClick = useRef(false)
  const releaseSuppressedClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRepeat = useCallback(() => {
    if (repeatTimer.current) {
      clearTimeout(repeatTimer.current)
      repeatTimer.current = null
    }
    if (repeatInterval.current) {
      clearInterval(repeatInterval.current)
      repeatInterval.current = null
    }
  }, [])

  const clearSuppressedClickTimer = useCallback(() => {
    if (releaseSuppressedClickTimer.current) {
      clearTimeout(releaseSuppressedClickTimer.current)
      releaseSuppressedClickTimer.current = null
    }
  }, [])

  const scheduleSuppressedClickReset = useCallback(() => {
    clearSuppressedClickTimer()
    releaseSuppressedClickTimer.current = setTimeout(() => {
      suppressClick.current = false
      releaseSuppressedClickTimer.current = null
    }, 500)
  }, [clearSuppressedClickTimer])

  const getKey = useCallback((keyId: string | undefined) => {
    if (!keyId) return null
    return ALL_KEYS.find(key => key.id === keyId) ?? null
  }, [])

  const activateKey = useCallback((key: KeyDef) => {
    sendInput(resolveInput?.(key.id, key.seq) ?? key.seq)
  }, [resolveInput, sendInput])

  const handleTouchStart = useCallback(
    (e: TouchEvent<HTMLButtonElement>) => {
      const key = getKey(e.currentTarget.dataset.key)
      if (!key) return

      e.preventDefault()
      clearSuppressedClickTimer()
      suppressClick.current = true
      activateKey(key)
      if (key.repeatable) {
        clearRepeat()
        repeatTimer.current = setTimeout(() => {
          repeatInterval.current = setInterval(() => activateKey(key), 80)
        }, 400)
      }
    },
    [activateKey, clearRepeat, clearSuppressedClickTimer, getKey],
  )

  const handleTouchEnd = useCallback(
    (e: TouchEvent<HTMLButtonElement>) => {
      e.preventDefault()
      clearRepeat()
      scheduleSuppressedClickReset()
    },
    [clearRepeat, scheduleSuppressedClickReset],
  )

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    const key = getKey(e.currentTarget.dataset.key)
    if (!key) return

    if (suppressClick.current) {
      e.preventDefault()
      suppressClick.current = false
      clearSuppressedClickTimer()
      return
    }

    activateKey(key)
  }, [activateKey, clearSuppressedClickTimer, getKey])

  const preventContext = useCallback((e: SyntheticEvent) => {
    e.preventDefault()
  }, [])

  const toggleExpanded = useCallback(() => {
    setExpanded(value => !value)
  }, [])

  const toggleCtrl = useCallback(() => {
    onModifierChange({ ...modifiers, ctrl: !modifiers.ctrl })
  }, [modifiers, onModifierChange])

  const toggleShift = useCallback(() => {
    onModifierChange({ ...modifiers, shift: !modifiers.shift })
  }, [modifiers, onModifierChange])

  useEffect(() => {
    return () => {
      clearRepeat()
      clearSuppressedClickTimer()
      suppressClick.current = false
    }
  }, [clearRepeat, clearSuppressedClickTimer])

  return (
    <div className="bg-[--sol-base2] border-t border-[--sol-border] pb-[env(safe-area-inset-bottom)]" role="toolbar" aria-label="Terminal key bar" onMouseDown={preventContext}>
      <div className="flex gap-1 px-2 py-1">
        <button
          type="button"
          className={modifiers.ctrl ? BTN_ACTIVE : BTN}
          aria-label="Control modifier"
          aria-pressed={modifiers.ctrl}
          onClick={toggleCtrl}
          onContextMenu={preventContext}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={modifiers.shift ? BTN_ACTIVE : BTN}
          aria-label="Shift modifier"
          aria-pressed={modifiers.shift}
          onClick={toggleShift}
          onContextMenu={preventContext}
        >
          ⇧
        </button>
        {PRIMARY_KEYS.map(key => (
          <button
            key={key.label}
            type="button"
            className={BTN}
            aria-label={key.ariaLabel}
            data-key={key.id}
            onClick={handleClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={preventContext}
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          className={BTN}
          aria-controls="terminal-keybar-secondary"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide more terminal keys' : 'Show more terminal keys'}
          onClick={toggleExpanded}
          onContextMenu={preventContext}
        >
          <span
            className="inline-flex items-center justify-center transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          >
            <Ellipsis size={14} />
          </span>
        </button>
      </div>
      <div
        id="terminal-keybar-secondary"
        className="overflow-hidden transition-[max-height] duration-150 ease-out"
        aria-hidden={!expanded}
        style={{ maxHeight: expanded ? 36 : 0 }}
      >
        <div className="flex gap-1 px-2 py-1 items-center" hidden={!expanded}>
          <span className="text-[10px] font-mono text-[--sol-base1] shrink-0 pl-0.5 pr-0.5">^</span>
          {SECONDARY_KEYS.map(key => (
            <button
              key={key.label}
              type="button"
              className={BTN}
              aria-label={key.ariaLabel}
              data-key={key.id}
              onClick={handleClick}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              onContextMenu={preventContext}
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
