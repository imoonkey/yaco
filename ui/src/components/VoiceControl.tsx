import type { CapabilityState, InteractionState } from '../hooks/useVoice'

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="5.5" y="1" width="5" height="9" rx="2.5" fill="currentColor" />
      <path d="M4 8a4 4 0 0 0 8 0" fill="none" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" />
      <line x1="8" y1="12" x2="8" y2="14.5" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
      style={{ animation: 'spin 0.8s linear infinite' }}>
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeDasharray="20 12" strokeLinecap="round" />
    </svg>
  )
}

type VisualState = 'disabled' | 'ready' | 'recording' | 'processing'

function resolveVisualState(
  capability: CapabilityState,
  interaction: InteractionState,
): VisualState {
  if (capability.status !== 'ready') return 'disabled'
  switch (interaction) {
    case 'recording': return 'recording'
    case 'transcribing':
    case 'formatting':
    case 'requesting_permission':
      return 'processing'
    default: return 'ready'
  }
}

function getAriaLabel(visual: VisualState, capability: CapabilityState): string {
  if (visual === 'disabled' && capability.status === 'unavailable') {
    return `Voice: ${capability.message}`
  }
  switch (visual) {
    case 'disabled': return 'Voice unavailable'
    case 'ready': return 'Start voice recording'
    case 'recording': return 'Stop recording'
    case 'processing': return 'Processing voice input'
  }
}

const BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  fontSize: 11,
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  touchAction: 'manipulation',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  transition: 'background 120ms, color 120ms, opacity 120ms',
}

const VISUAL_STYLES: Record<VisualState, React.CSSProperties> = {
  disabled: {
    background: 'transparent',
    color: 'var(--sol-base1)',
    opacity: 0.5,
    cursor: 'default',
  },
  ready: {
    background: 'rgba(0,0,0,0.06)',
    color: 'var(--sol-base01)',
    opacity: 1,
  },
  recording: {
    background: 'rgba(220,50,47,0.15)',
    color: 'var(--sol-red)',
    opacity: 1,
  },
  processing: {
    background: 'rgba(0,0,0,0.06)',
    color: 'var(--sol-base1)',
    opacity: 1,
    cursor: 'default',
  },
}

export function VoiceControl({
  capability,
  state,
  elapsedMs,
  onStart,
  onStop,
}: {
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  onStart: () => void
  onStop: () => void
}) {
  const visual = resolveVisualState(capability, state)

  const handleClick = () => {
    if (visual === 'recording') {
      onStop()
    } else if (visual === 'ready') {
      onStart()
    }
  }

  return (
    <button
      style={{ ...BASE_STYLE, ...VISUAL_STYLES[visual] }}
      onClick={handleClick}
      disabled={visual === 'disabled'}
      aria-label={getAriaLabel(visual, capability)}
      aria-busy={visual === 'processing'}
    >
      {visual === 'recording' && (
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--sol-red)',
          animation: 'voice-pulse 1.2s ease-in-out infinite',
          flexShrink: 0,
        }} />
      )}
      {visual === 'processing' ? <Spinner /> : <MicIcon />}
      {visual === 'recording' && (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatElapsed(elapsedMs)}
        </span>
      )}
      {visual === 'processing' && state === 'transcribing' && (
        <span>Transcribing</span>
      )}
      {visual === 'processing' && state === 'formatting' && (
        <span>Formatting</span>
      )}
      {visual === 'processing' && state === 'requesting_permission' && (
        <span>Mic…</span>
      )}
      {visual === 'ready' && <span>Voice</span>}
      <style>{`
        @keyframes voice-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  )
}
