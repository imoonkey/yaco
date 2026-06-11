import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { LoaderCircle, Mic, Square } from 'lucide-react'

type VisualState = 'disabled' | 'ready' | 'recording' | 'processing'

function resolveVisualState(
  capability: CapabilityState,
  interaction: InteractionState,
): VisualState {
  if (capability.status !== 'ready') return 'disabled'
  switch (interaction) {
    case 'active': return 'recording'
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
  disabled: {
    background: 'transparent',
    color: 'var(--sol-text-disabled)',
    cursor: 'default',
  },
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
    cursor: 'default',
  },
}

export function VoiceControl({
  capability,
  state,
  onStart,
  onStop,
}: {
  capability: CapabilityState
  state: InteractionState
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
      {visual === 'processing' ? (
        <LoaderCircle size={14} aria-hidden="true" style={{ animation: 'spin 0.8s linear infinite' }} />
      ) : visual === 'recording' ? (
        <Square size={12} aria-hidden="true" fill="currentColor" />
      ) : (
        <Mic size={14} aria-hidden="true" />
      )}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  )
}
