import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { LoaderCircle, Mic, Square } from 'lucide-react'

type VisualState = 'ready' | 'recording' | 'processing'

// The header mic. Clicking starts a take immediately (same as F5) — opening the
// empty compose tray for typing/pasting is the separate launcher (mobile key
// bar). Clicking while recording stops the take; while a take is in flight the
// button is inert. The icon mirrors the shared voice state.
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
    case 'recording': return 'Stop recording'
    case 'processing': return 'Voice processing'
    case 'ready': return 'Start voice recording'
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
    cursor: 'default',
  },
}

export function VoiceControl({
  capability,
  state,
  onRecord,
  onStop,
}: {
  capability: CapabilityState
  state: InteractionState
  onRecord: () => void
  onStop: () => void
}) {
  const visual = resolveVisualState(state)
  const unavailable = capability.status === 'unavailable' ? capability.message : undefined

  const handleClick = () => {
    if (visual === 'recording') onStop()
    else if (visual === 'ready') onRecord()
    // 'processing' (requesting permission / transcribing): a take is in flight — ignore.
  }

  return (
    <button
      style={{ ...BASE_STYLE, ...VISUAL_STYLES[visual] }}
      onClick={handleClick}
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
