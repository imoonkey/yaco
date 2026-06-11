import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Mic, Square, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { DialogShell } from './DialogShell'
import { writeTextToClipboard } from '../lib/clipboard'
import type { VoiceSurface, InteractionState, CapabilityState, AppendText } from '../hooks/useVoice'

// The one compose surface for terminal/editor text entry: type, paste, or
// record (one take at a time, appended to the draft). Insert sends the draft to
// the run's frozen target; ⌘/Ctrl+Enter is the send key (plain Enter is a
// newline, so IME candidate-selection Enter never mis-fires). The tray only
// closes via the X / Esc / Discard — never an outside click — and stashes the
// draft on the clipboard on any close so a glitched insert can't lose it.
export function ComposeTray({
  surface,
  state,
  elapsedMs,
  appendText,
  capability,
  errorMessage,
  notice,
  onRecord,
  onStop,
  onConfirm,
  onCopy,
  onClose,
  onRetry,
}: {
  surface: VoiceSurface
  state: InteractionState
  elapsedMs: number
  appendText: AppendText | null
  capability: CapabilityState
  errorMessage: string | null
  notice: string | null
  onRecord: () => void
  onStop: () => void
  onConfirm: (text: string) => void
  onCopy: (text: string) => void
  onClose: () => void
  onRetry: () => void
}) {
  const isOpen = state !== 'idle'
  const [editText, setEditText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Append a finished take's text to the draft when its key changes (adjust
  // state during render — the canonical React derived-state pattern).
  const [prevAppendKey, setPrevAppendKey] = useState<number | null>(null)
  if (appendText && appendText.key !== prevAppendKey) {
    setPrevAppendKey(appendText.key)
    setEditText(prev => {
      const sep = prev && !/\s$/.test(prev) ? ' ' : ''
      return prev + sep + appendText.text
    })
  }

  // Reset the draft when the tray closes (it stays mounted, returning null when
  // idle) so the previous session's text never reappears. Render-phase
  // derived-state, like the append above. prevAppendKey is kept (run-id keys are
  // monotonic), so a stale appendText can't refill a fresh draft.
  const [prevOpen, setPrevOpen] = useState(isOpen)
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen)
    if (!isOpen) setEditText('')
  }

  // Auto-size: min ~50px, max 50vh.
  const autoSize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxH = window.innerHeight * 0.5
    el.style.height = `${Math.max(50, Math.min(el.scrollHeight, maxH))}px`
  }, [])
  useEffect(() => { autoSize() }, [editText, autoSize])

  // Focus + cursor-to-end when settled into compose (incl. after each append).
  useEffect(() => {
    if ((state === 'composing' || state === 'recoverable') && textareaRef.current) {
      const el = textareaRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [state, prevAppendKey])

  // Stash the draft on the clipboard whenever the tray closes with content, so a
  // glitched insert (WS dropped, session detached) never silently loses it.
  const backupDraft = useCallback(() => {
    if (!editText.trim()) return
    void writeTextToClipboard(editText).then(ok => {
      if (ok) toast('Draft copied to clipboard', { duration: 1500 })
    })
  }, [editText])

  const takeInFlight = state === 'requesting_permission' || state === 'recording' || state === 'transcribing'
  const isRecoverable = state === 'recoverable'
  const canInsert = !takeInFlight && !isRecoverable && editText.trim() !== ''

  const handleConfirm = useCallback(() => {
    if (!canInsert) return
    backupDraft()
    onConfirm(editText)
  }, [canInsert, backupDraft, onConfirm, editText])

  const handleClose = useCallback(() => {
    backupDraft()
    onClose()
  }, [backupDraft, onClose])

  if (!isOpen) return null

  const elapsed = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  const recordDisabled = capability.status !== 'ready'

  return (
    <DialogShell
      onClose={handleClose}
      dismissOnOverlayClick={false}
      overlayBg="var(--sol-overlay-bg)"
      overlayClassName="z-[1000] items-center justify-center"
      style={{
        borderRadius: 8,
        padding: 16,
        width: '90%',
        maxWidth: 520,
        backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 90%, transparent)',
      }}
    >
      <div>
        {/* Header — surface is frozen for the run */}
        <div style={HEADER_STYLE}>
          <span className="font-medium" style={SURFACE_LABEL_STYLE}>
            Compose → {surface === 'terminal' ? 'Terminal' : 'Editor'}
          </span>
          <button style={CLOSE_BTN_STYLE} onClick={handleClose} aria-label="Close"><X size={14} /></button>
        </div>

        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleConfirm()
            }
          }}
          rows={1}
          style={TEXTAREA_STYLE}
          aria-label="Compose input"
          placeholder="Type, paste, or record. ⌘/Ctrl+Enter to send, Esc to close."
        />

        {/* Record / Stop / progress control */}
        <div style={CONTROL_ROW_STYLE}>
          {state === 'recording' ? (
            <>
              <button className="font-medium" style={STOP_BTN_STYLE} onClick={onStop}>
                <Square size={12} fill="currentColor" /> Stop
              </button>
              <span style={{ flex: 1 }} />
              <span style={TIMER_STYLE}>
                <span style={PULSE_DOT_STYLE} />
                <span>{mm}:{ss}</span>
              </span>
            </>
          ) : takeInFlight ? (
            <span style={PROGRESS_STYLE} aria-live="polite">
              <LoaderCircle size={14} style={{ animation: 'voice-spin 0.8s linear infinite' }} aria-hidden="true" />
              {state === 'transcribing' ? 'Transcribing…' : 'Starting mic…'}
            </span>
          ) : (
            <button
              className="font-medium"
              style={{ ...RECORD_BTN_STYLE, ...(recordDisabled ? DISABLED_STYLE : {}) }}
              onClick={onRecord}
              disabled={recordDisabled}
              title={recordDisabled && capability.status === 'unavailable' ? capability.message : undefined}
            >
              <Mic size={14} /> Record
            </button>
          )}
        </div>

        {/* No-speech / soft notice */}
        {notice && !errorMessage && (
          <div style={NOTICE_STYLE} role="status" aria-live="polite">{notice}</div>
        )}

        {/* Error row — Retry re-sends the cached take */}
        {state === 'error' && errorMessage && (
          <div style={ERROR_ROW_STYLE} role="alert">
            <span>{errorMessage}</span>
            <button className="font-medium" style={ERROR_ACTION_STYLE} onClick={onRetry}>Retry</button>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button
            className="font-medium"
            style={{ ...CONFIRM_BTN_STYLE, ...(canInsert ? {} : DISABLED_STYLE) }}
            disabled={!canInsert}
            onClick={handleConfirm}
            title={isRecoverable ? 'Target no longer available' : undefined}
          >
            Insert
          </button>
          <button
            className="font-medium"
            style={{ ...COPY_BTN_STYLE, ...(editText.trim() ? {} : DISABLED_STYLE) }}
            disabled={!editText.trim()}
            onClick={() => onCopy(editText)}
          >
            Copy
          </button>
          <span style={{ flex: 1 }} />
          <button className="font-medium" style={DISCARD_BTN_STYLE} onClick={handleClose}>Discard</button>
        </div>
      </div>
    </DialogShell>
  )
}

// --- Styles ---

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
  fontSize: 'var(--text-ui-md)',
  color: 'var(--sol-text)',
}

const SURFACE_LABEL_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-ui-md)',
  color: 'var(--sol-text)',
  padding: '2px 4px',
}

const CLOSE_BTN_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-text)',
  fontSize: 'var(--text-ui-xl)',
  cursor: 'pointer',
  padding: '2px 6px',
  lineHeight: 1,
}

const TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-ui-lg)',
  color: 'var(--sol-editor-fg)',
  background: 'var(--sol-input-bg)',
  border: '1px solid var(--sol-border)',
  borderRadius: 4,
  padding: '8px 10px',
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
  lineHeight: 'var(--lh-normal)',
  minHeight: 50,
}

const CONTROL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 10,
  minHeight: 32,
}

const TIMER_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-ui-xl)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--sol-red)',
}

const PULSE_DOT_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: 'var(--sol-red)',
  animation: 'voice-pulse 1.2s ease-in-out infinite',
  flexShrink: 0,
}

const PROGRESS_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 'var(--text-ui-md)',
  color: 'var(--sol-text-faint)',
}

const BTN_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  fontSize: 'var(--text-ui-md)',
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  padding: '0 14px',
  touchAction: 'manipulation',
  lineHeight: 1,
  transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const RECORD_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-subtle-bg)',
  color: 'var(--sol-base01)',
}

const STOP_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  border: '1px solid color-mix(in srgb, var(--sol-red) 30%, transparent)',
  background: 'color-mix(in srgb, var(--sol-red) 8%, transparent)',
  color: 'var(--sol-red)',
}

const CONFIRM_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  height: 28,
  padding: '0 12px',
  background: 'var(--sol-accent)',
  color: '#fff',
}

const COPY_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  height: 28,
  padding: '0 12px',
  background: 'var(--sol-subtle-bg)',
  color: 'var(--sol-text)',
}

const DISCARD_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  height: 28,
  padding: '0 12px',
  background: 'none',
  color: 'var(--sol-text)',
}

const DISABLED_STYLE: React.CSSProperties = {
  background: 'var(--sol-subtle-bg)',
  color: 'var(--sol-text-disabled)',
  cursor: 'default',
}

const NOTICE_STYLE: React.CSSProperties = {
  marginTop: 8,
  fontSize: 'var(--text-ui-sm)',
  color: 'var(--sol-text-faint)',
}

const ERROR_ROW_STYLE: React.CSSProperties = {
  marginTop: 8,
  background: 'color-mix(in srgb, var(--sol-red) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--sol-red) 20%, transparent)',
  color: 'var(--sol-red)',
  fontSize: 'var(--text-ui-sm)',
  padding: '4px 8px',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const ERROR_ACTION_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-red)',
  fontSize: 'var(--text-ui-sm)',
  cursor: 'pointer',
  padding: '2px 4px',
  textDecoration: 'underline',
}
