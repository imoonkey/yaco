import { useState, useRef, useEffect, useCallback } from 'react'
import { X, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { DialogShell } from './DialogShell'
import { writeTextToClipboard } from '../lib/clipboard'
import type { VoiceSurface, ComposeData, InteractionState } from '../hooks/useVoice'

export function ComposeTray({
  surface,
  compose,
  state,
  elapsedMs,
  liveTranscript,
  pendingCount,
  errorMessage,
  onConfirm,
  onDiscard,
  onCopy,
  onRetry,
  onDismiss,
  onStop,
}: {
  surface: VoiceSurface
  compose: ComposeData | null
  state: InteractionState
  elapsedMs: number
  liveTranscript: string
  pendingCount: number
  errorMessage: string | null
  onConfirm: (text: string) => void
  onDiscard: () => void
  onCopy: (text: string) => void
  onRetry: () => void
  onDismiss: () => void
  onStop: () => void
}) {
  const isActive = state === 'active'
    || state === 'composing' || state === 'recoverable' || state === 'error'
  const [editText, setEditText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [copiedRaw, setCopiedRaw] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Seed textarea when compose data arrives (adjust state during render)
  const [prevCompose, setPrevCompose] = useState(compose)
  if (compose !== prevCompose) {
    setPrevCompose(compose)
    if (compose) {
      setEditText(compose.displayText)
      setShowRaw(compose.formattingStatus === 'fallback_raw')
    }
  }

  // Auto-focus textarea when entering compose state
  useEffect(() => {
    if ((state === 'composing' || state === 'recoverable') && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [state])

  // Auto-size textarea: min 3 rows (~50px), max 50vh
  const autoSize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxH = window.innerHeight * 0.5
    el.style.height = `${Math.max(50, Math.min(el.scrollHeight, maxH))}px`
  }, [])

  useEffect(() => { autoSize() }, [editText, autoSize])

  // Keep the growing live transcript pinned to its latest line.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveTranscript])

  // Defensive safety net: whenever the tray closes with edited content (Insert,
  // Discard, X, or Esc), stash the draft on the clipboard first. If the insert
  // glitches (WS dropped, session detached) the text is never silently lost.
  const backupDraft = useCallback(() => {
    if (!editText.trim()) return
    void writeTextToClipboard(editText).then(ok => {
      if (ok) toast('Draft copied to clipboard', { duration: 1500 })
    })
  }, [editText])

  const handleConfirm = useCallback((text: string) => {
    backupDraft()
    onConfirm(text)
  }, [backupDraft, onConfirm])

  const handleDiscard = useCallback(() => {
    backupDraft()
    onDiscard()
  }, [backupDraft, onDiscard])

  const confirmLabel = 'Insert'
  const isRecoverable = state === 'recoverable'
  const isFallback = compose?.formattingStatus === 'fallback_raw'

  if (!isActive) return null

  const elapsed = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  const handleClose = state === 'active' ? onStop : handleDiscard

  return (
    <DialogShell
      onClose={handleClose}
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
        {/* Header — surface is frozen for the run; not toggleable once started */}
        <div style={HEADER_STYLE}>
          <span className="font-medium" style={SURFACE_LABEL_STYLE}>
            Voice → {surface === 'terminal' ? 'Terminal' : 'Editor'}
          </span>
          <button style={CLOSE_BTN_STYLE} onClick={handleClose} aria-label="Close"><X size={14} /></button>
        </div>

        {/* Active: growing live transcript + timer + pending indicator */}
        {state === 'active' && (
          <div style={ACTIVE_STYLE}>
            <div ref={transcriptRef} style={TRANSCRIPT_STYLE} aria-live="polite">
              {liveTranscript || <span style={{ opacity: 0.5 }}>Listening…</span>}
            </div>
            <div style={ACTIVE_FOOTER_STYLE}>
              <button className="font-medium" style={STOP_BTN_STYLE} onClick={onStop}>Stop</button>
              {pendingCount > 0 && (
                <span style={PENDING_STYLE} title={`${pendingCount} transcribing…`}>
                  <span style={SPINNER_STYLE} />
                  <span>{pendingCount}</span>
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span style={TIMER_STYLE}>
                <span style={PULSE_DOT_STYLE} />
                <span>{mm}:{ss}</span>
              </span>
            </div>
          </div>
        )}

        {/* Error row */}
        {state === 'error' && errorMessage && (
          <div style={ERROR_ROW_STYLE} role="alert">
            <span>{errorMessage}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="font-medium" style={ERROR_ACTION_STYLE} onClick={onRetry}>Retry</button>
              <button className="font-medium" style={ERROR_ACTION_STYLE} onClick={onDismiss}>Dismiss</button>
            </span>
          </div>
        )}

        {/* Compose content */}
        {compose && (state === 'composing' || state === 'recoverable') && (
          <>
            {isFallback && compose.warning && (
              <div style={WARNING_STYLE} role="status" aria-live="polite">
                {compose.warning}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isRecoverable) {
                  e.preventDefault()
                  handleConfirm(editText)
                }
              }}
              rows={1}
              style={TEXTAREA_STYLE}
              aria-label="Voice transcript"
              placeholder="Enter to send, Shift+Enter for newline, Esc to discard"
            />

            {compose.rawText && compose.rawText !== editText && (
              <div style={{ marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={() => setShowRaw(v => !v)}
                    style={DISCLOSURE_STYLE}
                    aria-expanded={showRaw}
                  >
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      transition: 'transform 150ms',
                      transform: showRaw ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}><ChevronRight size={12} /></span>
                    {' '}Raw transcript
                  </button>
                  {showRaw && (
                    <button
                      style={COPY_RAW_STYLE}
                      onClick={() => {
                        navigator.clipboard.writeText(compose.rawText)
                        setCopiedRaw(true)
                        setTimeout(() => setCopiedRaw(false), 1200)
                      }}
                    >
                      {copiedRaw ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                {showRaw && (
                  <div style={RAW_TEXT_STYLE}>{compose.rawText}</div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <button
                className="font-medium"
                style={{
                  ...CONFIRM_BTN_STYLE,
                  ...(isRecoverable ? { background: 'var(--sol-subtle-bg)', color: 'var(--sol-text-disabled)', cursor: 'default' } : {}),
                }}
                disabled={isRecoverable}
                onClick={() => handleConfirm(editText)}
                title={isRecoverable ? 'Target no longer available' : undefined}
              >
                {confirmLabel}
              </button>
              <button className="font-medium" style={COPY_BTN_STYLE} onClick={() => onCopy(editText)}>Copy</button>
              <button className="font-medium" style={DISCARD_BTN_STYLE} onClick={handleDiscard}>Discard</button>
            </div>
          </>
        )}
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

const ACTIVE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const TRANSCRIPT_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-ui-xl)',
  lineHeight: 'var(--lh-normal)',
  color: 'var(--sol-editor-fg)',
  background: 'var(--sol-input-bg)',
  border: '1px solid var(--sol-border)',
  borderRadius: 4,
  padding: '8px 10px',
  minHeight: 60,
  maxHeight: '30vh',
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const ACTIVE_FOOTER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: 'var(--sol-red)',
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

const PENDING_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 'var(--text-ui-sm)',
  color: 'var(--sol-text-faint)',
}

const PULSE_DOT_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: 'var(--sol-red)',
  animation: 'voice-pulse 1.2s ease-in-out infinite',
  flexShrink: 0,
}

const STOP_BTN_STYLE: React.CSSProperties = {
  height: 32,
  fontSize: 'var(--text-ui-lg)',
  borderRadius: 4,
  border: '1px solid color-mix(in srgb, var(--sol-red) 30%, transparent)',
  background: 'color-mix(in srgb, var(--sol-red) 8%, transparent)',
  color: 'var(--sol-red)',
  cursor: 'pointer',
  padding: '0 16px',
}

const SPINNER_STYLE: React.CSSProperties = {
  width: 12,
  height: 12,
  border: '2px solid var(--sol-border)',
  borderTopColor: 'var(--sol-base01)',
  borderRadius: '50%',
  animation: 'voice-spin 0.8s linear infinite',
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

const WARNING_STYLE: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--sol-yellow) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--sol-yellow) 20%, transparent)',
  color: 'var(--sol-yellow)',
  fontSize: 'var(--text-ui-sm)',
  padding: '4px 8px',
  borderRadius: 4,
  marginBottom: 6,
}

const ERROR_ROW_STYLE: React.CSSProperties = {
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

const BTN_BASE: React.CSSProperties = {
  height: 28,
  fontSize: 'var(--text-ui-md)',
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  padding: '0 12px',
  touchAction: 'manipulation',
  lineHeight: 1,
  transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
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

const DISCARD_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'none',
  color: 'var(--sol-text)',
}

const DISCLOSURE_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-text)',
  fontSize: 'var(--text-ui-sm)',
  cursor: 'pointer',
  padding: 0,
}

const RAW_TEXT_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-ui-sm)',
  color: 'var(--sol-text)',
  background: 'var(--sol-subtle-bg)',
  padding: '4px 8px',
  borderRadius: 4,
  marginTop: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  userSelect: 'text',
  cursor: 'text',
}

const COPY_RAW_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-text)',
  fontSize: 'var(--text-ui-xs)',
  cursor: 'pointer',
  padding: '0 2px',
  textDecoration: 'underline',
}
