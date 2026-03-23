import { useState, useRef, useCallback } from 'react'

type KeyDef = {
  label: string
  seq: string
  repeatable?: true
}

const PRIMARY_KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '←', seq: '\x1b[D', repeatable: true },
  { label: '↓', seq: '\x1b[B', repeatable: true },
  { label: '↑', seq: '\x1b[A', repeatable: true },
  { label: '→', seq: '\x1b[C', repeatable: true },
  { label: '^C', seq: '\x03' },
]

const SECONDARY_KEYS: KeyDef[] = [
  { label: '^D', seq: '\x04' },
  { label: '^Z', seq: '\x1a' },
  { label: '^L', seq: '\x0c' },
  { label: '^R', seq: '\x12' },
  { label: '^A', seq: '\x01' },
  { label: '^E', seq: '\x05' },
  { label: '^W', seq: '\x17' },
  { label: '^U', seq: '\x15' },
]

const BTN =
  'min-w-[40px] h-9 px-2 rounded bg-[rgba(0,0,0,0.08)] active:bg-[rgba(0,0,0,0.18)] text-[--sol-base01] font-mono text-sm select-none touch-manipulation'

export function TerminalKeyBar({
  sendInput,
}: {
  sendInput: (data: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null)

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

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, key: KeyDef) => {
      e.preventDefault()
      sendInput(key.seq)
      if (key.repeatable) {
        clearRepeat()
        repeatTimer.current = setTimeout(() => {
          repeatInterval.current = setInterval(() => sendInput(key.seq), 80)
        }, 400)
      }
    },
    [sendInput, clearRepeat],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      clearRepeat()
    },
    [clearRepeat],
  )

  const preventContext = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault()
  }, [])

  return (
    <div className="bg-[--sol-base2] border-t border-[--sol-border]">
      <div className="flex gap-1 px-1 py-1">
        {PRIMARY_KEYS.map(key => (
          <button
            key={key.label}
            className={BTN}
            onTouchStart={e => handleTouchStart(e, key)}
            onTouchEnd={handleTouchEnd}
            onContextMenu={preventContext}
          >
            {key.label}
          </button>
        ))}
        <button
          className={BTN}
          onClick={() => setExpanded(v => !v)}
          onContextMenu={preventContext}
        >
          <span
            className="inline-block transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          >
            ···
          </span>
        </button>
      </div>
      <div
        className="overflow-hidden transition-[max-height] duration-150 ease-out"
        style={{ maxHeight: expanded ? 40 : 0 }}
      >
        <div className="flex gap-1 px-1 py-1">
          {SECONDARY_KEYS.map(key => (
            <button
              key={key.label}
              className={BTN}
              onTouchStart={e => handleTouchStart(e, key)}
              onTouchEnd={handleTouchEnd}
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
