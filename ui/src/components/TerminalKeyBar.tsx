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
  | 'page-up'
  | 'page-down'
  | 'arrow-left'
  | 'arrow-down'
  | 'arrow-up'
  | 'arrow-right'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-k'
  | 'ctrl-o'
  | 'ctrl-b'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-w'
  | 'ctrl-u'

export type Modifiers = { ctrl: boolean; shift: boolean; meta: boolean }

const PRIMARY_KEYS: KeyDef[] = [
  { id: 'escape', label: 'Esc', ariaLabel: 'Escape', seq: '\x1b' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', seq: '\t' },
  { id: 'page-up', label: 'PgU', ariaLabel: 'Page Up', seq: '\x1b[5~', repeatable: true },
  { id: 'page-down', label: 'PgD', ariaLabel: 'Page Down', seq: '\x1b[6~', repeatable: true },
  { id: 'enter', label: '↵', ariaLabel: 'Enter', seq: '\r' },
  { id: 'arrow-left', label: '←', ariaLabel: 'Left arrow', seq: '\x1b[D', repeatable: true },
  { id: 'arrow-down', label: '↓', ariaLabel: 'Down arrow', seq: '\x1b[B', repeatable: true },
  { id: 'arrow-up', label: '↑', ariaLabel: 'Up arrow', seq: '\x1b[A', repeatable: true },
  { id: 'arrow-right', label: '→', ariaLabel: 'Right arrow', seq: '\x1b[C', repeatable: true },
]

const SECONDARY_KEYS: KeyDef[] = [
  { id: 'ctrl-c', label: 'C', ariaLabel: 'Control C', seq: '\x03' },
  { id: 'ctrl-d', label: 'D', ariaLabel: 'Control D', seq: '\x04' },
  { id: 'ctrl-b', label: 'B', ariaLabel: 'Control B', seq: '\x02' },
  { id: 'ctrl-o', label: 'O', ariaLabel: 'Control O', seq: '\x0f' },
  { id: 'ctrl-a', label: 'A', ariaLabel: 'Control A', seq: '\x01' },
  { id: 'ctrl-e', label: 'E', ariaLabel: 'Control E', seq: '\x05' },
  { id: 'ctrl-u', label: 'U', ariaLabel: 'Control U', seq: '\x15' },
  { id: 'ctrl-k', label: 'K', ariaLabel: 'Control K', seq: '\x0b' },
  { id: 'ctrl-w', label: 'W', ariaLabel: 'Control W', seq: '\x17' },
]

const ALL_KEYS = [...PRIMARY_KEYS, ...SECONDARY_KEYS]

const BTN =
  'min-w-[32px] h-7 px-1.5 rounded bg-[--sol-subtle-bg] active:bg-[--sol-subtle-bg-active] text-[--sol-base01] font-mono text-xs select-none touch-manipulation'
const BTN_MOD_ON =
  'min-w-[32px] h-7 px-1.5 rounded bg-[#268bd2] text-[#fdf6e3] font-mono text-xs select-none touch-manipulation'

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

  const handleExpandPointer = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setExpanded(value => !value)
  }, [])

  const handleCtrlPointer = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onModifierChange({ ...modifiers, ctrl: !modifiers.ctrl })
  }, [modifiers, onModifierChange])

  const handleShiftPointer = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onModifierChange({ ...modifiers, shift: !modifiers.shift })
  }, [modifiers, onModifierChange])

  const handleMetaPointer = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onModifierChange({ ...modifiers, meta: !modifiers.meta })
  }, [modifiers, onModifierChange])

  useEffect(() => {
    return () => {
      clearRepeat()
      clearSuppressedClickTimer()
      suppressClick.current = false
    }
  }, [clearRepeat, clearSuppressedClickTimer])

  return (
    <div className="bg-[--sol-editor-bg] border-t border-[--sol-border]" style={{ paddingBottom: 'calc(var(--kb-safe-bottom, env(safe-area-inset-bottom)) / 2)' }} role="toolbar" aria-label="Terminal key bar" onMouseDown={preventContext}>
      <div className="flex gap-1 px-2 py-1">
        <button
          type="button"
          className={modifiers.ctrl ? BTN_MOD_ON : BTN}
          aria-label="Control modifier"
          aria-pressed={modifiers.ctrl}
          onPointerDown={handleCtrlPointer}
          onContextMenu={preventContext}
        >
          Ctrl
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
          onPointerDown={handleExpandPointer}
          onContextMenu={preventContext}
        >
          <span
            className="inline-flex items-center justify-center"
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
          <button
            type="button"
            className={modifiers.shift ? BTN_MOD_ON : BTN}
            aria-label="Shift modifier"
            aria-pressed={modifiers.shift}
            onPointerDown={handleShiftPointer}
            onContextMenu={preventContext}
          >
            ⇧
          </button>
          <button
            type="button"
            className={modifiers.meta ? BTN_MOD_ON : BTN}
            aria-label="Meta modifier"
            aria-pressed={modifiers.meta}
            onPointerDown={handleMetaPointer}
            onContextMenu={preventContext}
          >
            ⌘
          </button>
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
