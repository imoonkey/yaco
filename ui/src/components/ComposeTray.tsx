import { useState, useRef, useEffect, useCallback } from 'react'
import type { VoiceSurface, ComposeData, InteractionState } from '../hooks/useVoice'

export function ComposeTray({
  surface,
  compose,
  state,
  errorMessage,
  onConfirm,
  onDiscard,
  onCopy,
  onRetry,
  onDismiss,
}: {
  surface: VoiceSurface
  compose: ComposeData | null
  state: InteractionState
  errorMessage: string | null
  onConfirm: (text: string) => void
  onDiscard: () => void
  onCopy: (text: string) => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const isOpen = state === 'composing' || state === 'recoverable' || state === 'error'
  const [editText, setEditText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
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

  // Auto-size textarea
  const autoSize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Clamp between 1 row (~20px) and 4 rows (~80px)
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }, [])

  useEffect(() => { autoSize() }, [editText, autoSize])

  const confirmLabel = surface === 'terminal' ? 'Send' : 'Insert'
  const isRecoverable = state === 'recoverable'
  const isFallback = compose?.formattingStatus === 'fallback_raw'

  return (
    <div style={{
      maxHeight: isOpen ? 300 : 0,
      overflow: 'hidden',
      transition: 'max-height 150ms ease-out',
    }}>
      <div style={TRAY_STYLE}>
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
            {/* Formatter fallback warning */}
            {isFallback && compose.warning && (
              <div style={WARNING_STYLE} role="status" aria-live="polite">
                {compose.warning}
              </div>
            )}

            {/* Editable textarea */}
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

            {/* Raw transcript disclosure */}
            {compose.rawText && compose.rawText !== editText && (
              <div style={{ marginTop: 4 }}>
                <button
                  onClick={() => setShowRaw(v => !v)}
                  style={DISCLOSURE_STYLE}
                  aria-expanded={showRaw}
                >
                  <span style={{
                    display: 'inline-block',
                    transition: 'transform 150ms',
                    transform: showRaw ? 'rotate(90deg)' : 'rotate(0deg)',
                    fontSize: 10,
                  }}>&#x25B6;</span>
                  {' '}Raw transcript
                </button>
                {showRaw && (
                  <div style={RAW_TEXT_STYLE}>{compose.rawText}</div>
                )}
              </div>
            )}

            {/* Action buttons */}
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
              <button
                style={COPY_BTN_STYLE}
                onClick={() => onCopy(editText)}
              >
                Copy
              </button>
              <button
                style={DISCARD_BTN_STYLE}
                onClick={onDiscard}
              >
                Discard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// --- Styles ---

const TRAY_STYLE: React.CSSProperties = {
  background: 'var(--sol-base3)',
  borderTop: '1px solid var(--sol-border)',
  padding: '8px 12px',
}

const TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  fontFamily: 'monospace',
  fontSize: 12,
  color: 'var(--sol-base02)',
  background: 'var(--sol-input-bg)',
  border: '1px solid var(--sol-border)',
  borderRadius: 4,
  padding: '6px 8px',
  resize: 'none',
  outline: 'none',
  boxSizing: 'border-box',
  lineHeight: 1.4,
  minHeight: 20,
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
  color: '#dc322f',
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
  color: '#dc322f',
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
}
