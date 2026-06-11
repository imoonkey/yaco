import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { LoaderCircle, Mic, Square } from 'lucide-react'

type VisualState = 'ready' | 'recording' | 'processing'

// The header launcher for the unified compose tray. Clicking always opens the
// tray (type / paste / record work regardless of mic availability); recording
// and stop live inside the tray. The icon mirrors the shared voice state so the
// header still shows ambient recording/processing feedback.
function resolveVisualState(interaction: InteractionState): VisualState {
  switch (interaction) {
    case 'recording': return 'recording'
    case 'requesting_permission':
    case 'transcribing':
      return 'processing'
    default: return 'ready'
  }
}

function getAriaLabel(visual: VisualState): string {
  switch (visual) {
    case 'recording': return 'Recording — open compose'
    case 'processing': return 'Voice processing — open compose'
    case 'ready': return 'Open compose (type, paste, or record)'
  }
}

const BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 24,
  padding: 0,
  fontSize: 'var(--text-ui-sm)',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  touchAction: 'manipulation',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const VISUAL_STYLES: Record<VisualState, React.CSSProperties> = {
  ready: {
    background: 'var(--sol-subtle-bg)',
    color: 'var(--sol-base01)',
    opacity: 1,
  },
  recording: {
    background: 'color-mix(in srgb, var(--sol-red) 15%, transparent)',
    color: 'var(--sol-red)',
    opacity: 1,
    animation: 'recording-scale 1.2s ease-in-out infinite',
  },
  processing: {
    background: 'var(--sol-subtle-bg)',
    color: 'var(--sol-text)',
    opacity: 1,
  },
}

export function VoiceControl({
  capability,
  state,
  onOpen,
}: {
  capability: CapabilityState
  state: InteractionState
  onOpen: () => void
}) {
  const visual = resolveVisualState(state)
  const unavailable = capability.status === 'unavailable' ? capability.message : undefined

  return (
    <button
      style={{ ...BASE_STYLE, ...VISUAL_STYLES[visual] }}
      onClick={onOpen}
      aria-label={getAriaLabel(visual)}
      title={unavailable}
      aria-busy={visual === 'processing'}
    >
      {visual === 'processing' ? (
        <LoaderCircle size={14} aria-hidden="true" style={{ animation: 'voice-spin 0.8s linear infinite' }} />
      ) : visual === 'recording' ? (
        <Square size={12} aria-hidden="true" fill="currentColor" />
      ) : (
        <Mic size={14} aria-hidden="true" />
      )}
    </button>
  )
}
