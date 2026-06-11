import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Mic, Square, LoaderCircle, Wand } from 'lucide-react'
import { toast } from 'sonner'
import { DialogShell } from './DialogShell'
import { writeTextToClipboard } from '../lib/clipboard'
import type { VoiceSurface, InteractionState, CapabilityState, AppendText, FormatResult } from '../hooks/useVoice'

// The one compose surface for terminal/editor text entry: type, paste, or
// record (one take at a time, inserted at the caret). Insert sends the draft to
// the run's frozen target; ⌘/Ctrl+Enter is the send key (plain Enter is a
// newline, so IME candidate-selection Enter never mis-fires). Format polishes
// the whole draft via the LLM formatter (Undo via the toast action). The tray
// only closes via the X / Esc — never an outside click — and stashes the draft
// on the clipboard on any close so a glitched insert can't lose it.
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
  onFormat,
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
  onFormat: (text: string) => Promise<FormatResult>
}) {
  const isOpen = state !== 'idle'
  const [editText, setEditText] = useState('')
  const [formatting, setFormatting] = useState(false)
  // Pre-format draft, kept while an Undo for the last Format is still offered.
  const [preFormat, setPreFormat] = useState<string | null>(null)
  // Inline Format feedback (shown in the tray, not a toast — toasts can land far
  // from the tray). { error:true } for failure, false for a benign "no change".
  const [formatNote, setFormatNote] = useState<{ text: string; error: boolean } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Last known caret/selection in the draft — recorded text is spliced here.
  const caretRef = useRef<{ start: number; end: number } | null>(null)
  // Caret to apply after the next value change lands in the DOM (post-append).
  const pendingSelRef = useRef<number | null>(null)

  // Insert a finished take's text at the caret when its key changes (adjust
  // state during render — the canonical React derived-state pattern).
  const [prevAppendKey, setPrevAppendKey] = useState<number | null>(null)
  if (appendText && appendText.key !== prevAppendKey) {
    setPrevAppendKey(appendText.key)
    setPreFormat(null) // a new take supersedes the prior format's Undo
    setFormatNote(null)
    setEditText(prev => {
      const start = Math.min(caretRef.current?.start ?? prev.length, prev.length)
      const end = Math.min(caretRef.current?.end ?? prev.length, prev.length)
      const before = prev.slice(0, start)
      const after = prev.slice(end)
      const lead = before && !/\s$/.test(before) ? ' ' : ''
      const trail = after && !/^\s/.test(after) ? ' ' : ''
      pendingSelRef.current = start + lead.length + appendText.text.length
      return before + lead + appendText.text + trail + after
    })
  }

  // Reset the draft when the tray closes (it stays mounted, returning null when
  // idle) so the previous session's text never reappears. Render-phase
  // derived-state, like the append above. prevAppendKey is kept (run-id keys are
  // monotonic), so a stale appendText can't refill a fresh draft.
  const [prevOpen, setPrevOpen] = useState(isOpen)
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen)
    if (!isOpen) { setEditText(''); setPreFormat(null); setFormatNote(null) }
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

  // Focus and place the caret when settling into compose: after a take, just
  // past the inserted text (pendingSelRef); on first open, at the end. DOM-only
  // (no setState), and keyed on prevAppendKey so it never fights live typing.
  useEffect(() => {
    if (state !== 'composing' && state !== 'recoverable') return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const pos = pendingSelRef.current ?? el.value.length
    el.setSelectionRange(pos, pos)
    caretRef.current = { start: pos, end: pos }
    pendingSelRef.current = null
  }, [state, prevAppendKey])

  // Track the caret/selection so a recorded take splices in at the right spot.
  const syncCaret = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    caretRef.current = { start: el.selectionStart, end: el.selectionEnd }
  }, [])

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

  // Format the whole draft via the LLM formatter; replace in place and keep the
  // pre-format text so a flat Undo button (next to Format) can restore it.
  // Outcome is reported inline (formatNote), never via a toast.
  const handleFormat = useCallback(async () => {
    const before = editText
    if (!before.trim() || formatting) return
    setFormatting(true)
    setFormatNote(null)
    try {
      const { text, ok } = await onFormat(before)
      if (!ok) {
        setFormatNote({ text: 'Formatting failed — try again.', error: true })
      } else if (text === before) {
        setFormatNote({ text: 'Already clean — no changes.', error: false })
      } else {
        setEditText(text)
        setPreFormat(before)
      }
    } finally {
      setFormatting(false)
    }
  }, [editText, formatting, onFormat])

  const handleUndoFormat = useCallback(() => {
    if (preFormat == null) return
    setEditText(preFormat)
    setPreFormat(null)
  }, [preFormat])

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
          onChange={(e) => {
            setEditText(e.target.value)
            if (preFormat !== null) setPreFormat(null)
            if (formatNote !== null) setFormatNote(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleConfirm()
            }
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          rows={1}
          style={TEXTAREA_STYLE}
          aria-label="Compose input"
          placeholder="Type, paste, or record. ⌘/Ctrl+Enter to send, Esc to close."
        />

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

        {/* Inline Format feedback (in the tray, not a toast) */}
        {formatNote && (
          <div
            style={{ ...NOTICE_STYLE, color: formatNote.error ? 'var(--sol-red)' : 'var(--sol-text-faint)' }}
            role="status"
            aria-live="polite"
          >
            {formatNote.text}
          </div>
        )}

        {/* One action row: input/transform on the left (Record, Format), output
            on the right (Insert, Copy). Close is the header X (also backs up). */}
        <div style={ACTION_ROW_STYLE}>
          <div style={GROUP_STYLE}>
            {state === 'recording' ? (
              <>
                <button className="font-medium" style={STOP_BTN_STYLE} onClick={onStop}>
                  <Square size={12} fill="currentColor" /> Stop
                </button>
                <span style={TIMER_STYLE}>
                  <span style={PULSE_DOT_STYLE} />
                  <span>{mm}:{ss}</span>
                </span>
              </>
            ) : takeInFlight ? (
              <span style={PROGRESS_STYLE} aria-live="polite">
                <LoaderCircle size={14} style={{ animation: 'voice-spin 0.8s linear infinite' }} aria-hidden="true" />
                {state === 'transcribing' ? 'Transcribing…' : 'Starting…'}
              </span>
            ) : (
              <>
                <button
                  className="font-medium"
                  style={{ ...RECORD_BTN_STYLE, ...(recordDisabled ? DISABLED_STYLE : {}) }}
                  onClick={onRecord}
                  disabled={recordDisabled}
                  title={recordDisabled && capability.status === 'unavailable' ? capability.message : undefined}
                >
                  <Mic size={14} /> Record
                </button>
                <button
                  className="font-medium"
                  style={{ ...FORMAT_BTN_STYLE, ...(editText.trim() && !formatting ? {} : DISABLED_STYLE) }}
                  disabled={!editText.trim() || formatting}
                  onClick={handleFormat}
                  title="Polish the whole draft with the formatter"
                >
                  {formatting
                    ? <LoaderCircle size={14} style={{ animation: 'voice-spin 0.8s linear infinite' }} aria-hidden="true" />
                    : <Wand size={14} />} Format
                </button>
                {preFormat !== null && (
                  <button style={UNDO_BTN_STYLE} onClick={handleUndoFormat} title="Revert the last format">
                    Undo
                  </button>
                )}
              </>
            )}
          </div>
          <div style={{ ...GROUP_STYLE, marginLeft: 'auto' }}>
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
          </div>
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

const ACTION_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  rowGap: 8,
  marginTop: 12,
  minHeight: 32,
  flexWrap: 'wrap',
}

const GROUP_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const TIMER_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-ui-lg)',
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
  height: 30,
  fontSize: 'var(--text-ui-md)',
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  padding: '0 12px',
  touchAction: 'manipulation',
  lineHeight: 1,
  transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const RECORD_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-subtle-bg)',
  color: 'var(--sol-base01)',
}

const FORMAT_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-subtle-bg)',
  color: 'var(--sol-text)',
}

// Flat, subordinate to Format — quiet underlined link, no fill.
const UNDO_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 30,
  padding: '0 4px',
  fontSize: 'var(--text-ui-sm)',
  background: 'none',
  border: 'none',
  color: 'var(--sol-text-faint)',
  cursor: 'pointer',
  textDecoration: 'underline',
  touchAction: 'manipulation',
}

const STOP_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  border: '1px solid color-mix(in srgb, var(--sol-red) 30%, transparent)',
  background: 'color-mix(in srgb, var(--sol-red) 8%, transparent)',
  color: 'var(--sol-red)',
}

const CONFIRM_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-accent)',
  color: '#fff',
}

const COPY_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-subtle-bg)',
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
