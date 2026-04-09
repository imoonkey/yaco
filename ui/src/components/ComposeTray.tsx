import { useState, useRef, useEffect, useCallback } from 'react'
import { X, ChevronRight, ArrowLeftRight } from 'lucide-react'
import type { VoiceSurface, ComposeData, InteractionState } from '../hooks/useVoice'

export function ComposeTray({
  surface,
  compose,
  state,
  elapsedMs,
  errorMessage,
  onConfirm,
  onDiscard,
  onCopy,
  onRetry,
  onDismiss,
  onStop,
  onSurfaceToggle,
}: {
  surface: VoiceSurface
  compose: ComposeData | null
  state: InteractionState
  elapsedMs: number
  errorMessage: string | null
  onConfirm: (text: string) => void
  onDiscard: () => void
  onCopy: (text: string) => void
  onRetry: () => void
  onDismiss: () => void
  onStop: () => void
  onSurfaceToggle: () => void
}) {
  const isActive = state === 'recording' || state === 'transcribing' || state === 'formatting'
    || state === 'composing' || state === 'recoverable' || state === 'error'
  const [editText, setEditText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [copiedRaw, setCopiedRaw] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Seed textarea when compose data arrives
  useEffect(() => {
    if (compose) {
      setEditText(compose.displayText)
      setShowRaw(compose.formattingStatus === 'fallback_raw')
    }
  }, [compose])

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

  const confirmLabel = 'Insert'
  const isRecoverable = state === 'recoverable'
  const isFallback = compose?.formattingStatus === 'fallback_raw'
  const canToggleSurface = state === 'recording' || state === 'composing'

  if (!isActive) return null

  const elapsed = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div style={OVERLAY_STYLE} onClick={state === 'recording' ? onStop : onDiscard}
      onKeyDown={(e) => {
        if (e.key === 'Tab' && canToggleSurface) {
          e.preventDefault()
          onSurfaceToggle()
        }
      }}
    >
      <div style={DIALOG_STYLE} onClick={(e) => e.stopPropagation()}>
        {/* Header with toggleable surface */}
        <div style={HEADER_STYLE}>
          <button
            style={{
              ...SURFACE_TOGGLE_STYLE,
              ...(canToggleSurface ? { cursor: 'pointer' } : { cursor: 'default', opacity: 0.7 }),
            }}
            onClick={canToggleSurface ? onSurfaceToggle : undefined}
            title={canToggleSurface ? 'Click to switch target' : undefined}
          >
            Voice → {surface === 'terminal' ? 'Terminal' : 'Editor'}
            {canToggleSurface && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.5, display: 'inline-flex', alignItems: 'center', gap: 2 }}>Tab <ArrowLeftRight size={10} /></span>}
          </button>
          <button style={CLOSE_BTN_STYLE} onClick={state === 'recording' ? onStop : onDiscard} aria-label="Close"><X size={14} /></button>
        </div>

        {/* Recording state */}
        {state === 'recording' && (
          <div style={RECORDING_STYLE}>
            <span style={PULSE_DOT_STYLE} />
            <span style={{ fontFamily: 'monospace', fontSize: 20 }}>{mm}:{ss}</span>
            <button style={STOP_BTN_STYLE} onClick={onStop}>Stop</button>
          </div>
        )}

        {/* Processing states */}
        {(state === 'transcribing' || state === 'formatting') && (
          <div style={PROCESSING_STYLE}>
            <span style={SPINNER_STYLE} />
            <span>{state === 'transcribing' ? 'Transcribing…' : 'Formatting…'}</span>
          </div>
        )}

        {/* Error row */}
        {state === 'error' && errorMessage && (
          <div style={ERROR_ROW_STYLE} role="alert">
            <span>{errorMessage}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button style={ERROR_ACTION_STYLE} onClick={onRetry}>Retry</button>
              <button style={ERROR_ACTION_STYLE} onClick={onDismiss}>Dismiss</button>
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
                  onConfirm(editText)
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  onDiscard()
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
                style={{
                  ...CONFIRM_BTN_STYLE,
                  ...(isRecoverable ? { opacity: 0.5, cursor: 'default' } : {}),
                }}
                disabled={isRecoverable}
                onClick={() => onConfirm(editText)}
                title={isRecoverable ? 'Target no longer available' : undefined}
              >
                {confirmLabel}
              </button>
              <button style={COPY_BTN_STYLE} onClick={() => onCopy(editText)}>Copy</button>
              <button style={DISCARD_BTN_STYLE} onClick={onDiscard}>Discard</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// --- Styles ---

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.15)',
  animation: 'overlay-enter 200ms ease-out',
}

const DIALOG_STYLE: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--sol-base3) 90%, transparent)',
  border: '1px solid var(--sol-border)',
  borderRadius: 8,
  padding: 16,
  width: '90%',
  maxWidth: 520,
  boxShadow: 'var(--elevation-3)',
  backdropFilter: 'var(--backdrop-blur)',
  WebkitBackdropFilter: 'var(--backdrop-blur)',
  animation: 'dialog-enter 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
}

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
  fontSize: 12,
  color: 'var(--sol-base01)',
}

const SURFACE_TOGGLE_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontWeight: 500,
  fontSize: 12,
  color: 'var(--sol-base01)',
  padding: '2px 4px',
  borderRadius: 4,
}

const CLOSE_BTN_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-base1)',
  fontSize: 14,
  cursor: 'pointer',
  padding: '2px 6px',
  lineHeight: 1,
}

const RECORDING_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: '24px 0',
  color: 'var(--sol-red)',
}

const PULSE_DOT_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: 'var(--sol-red)',
  animation: 'voice-pulse 1.2s ease-in-out infinite',
}

const STOP_BTN_STYLE: React.CSSProperties = {
  height: 32,
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid rgba(220,50,47,0.3)',
  background: 'rgba(220,50,47,0.08)',
  color: 'var(--sol-red)',
  cursor: 'pointer',
  padding: '0 16px',
  fontWeight: 500,
}

const PROCESSING_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '24px 0',
  fontSize: 13,
  color: 'var(--sol-base1)',
}

const SPINNER_STYLE: React.CSSProperties = {
  width: 14,
  height: 14,
  border: '2px solid var(--sol-border)',
  borderTopColor: 'var(--sol-base01)',
  borderRadius: '50%',
  animation: 'voice-spin 0.8s linear infinite',
}

const TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  fontFamily: 'monospace',
  fontSize: 13,
  color: 'var(--sol-base02)',
  background: 'var(--sol-input-bg)',
  border: '1px solid var(--sol-border)',
  borderRadius: 4,
  padding: '8px 10px',
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
  lineHeight: 1.5,
  minHeight: 50,
}

const WARNING_STYLE: React.CSSProperties = {
  background: 'rgba(181,137,0,0.08)',
  border: '1px solid rgba(181,137,0,0.2)',
  color: 'var(--sol-yellow)',
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 4,
  marginBottom: 6,
}

const ERROR_ROW_STYLE: React.CSSProperties = {
  background: 'rgba(220,50,47,0.08)',
  border: '1px solid rgba(220,50,47,0.2)',
  color: 'var(--sol-red)',
  fontSize: 11,
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
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  padding: '2px 4px',
  textDecoration: 'underline',
}

const BTN_BASE: React.CSSProperties = {
  height: 28,
  fontSize: 12,
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  padding: '0 12px',
  touchAction: 'manipulation',
  fontWeight: 500,
  lineHeight: 1,
  transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const CONFIRM_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--sol-blue)',
  color: 'var(--sol-base3)',
}

const COPY_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'rgba(0,0,0,0.06)',
  color: 'var(--sol-base01)',
}

const DISCARD_BTN_STYLE: React.CSSProperties = {
  ...BTN_BASE,
  background: 'none',
  color: 'var(--sol-base1)',
}

const DISCLOSURE_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--sol-base1)',
  fontSize: 11,
  cursor: 'pointer',
  padding: 0,
}

const RAW_TEXT_STYLE: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  color: 'var(--sol-base00)',
  background: 'rgba(0,0,0,0.03)',
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
  color: 'var(--sol-base1)',
  fontSize: 10,
  cursor: 'pointer',
  padding: '0 2px',
  textDecoration: 'underline',
}
