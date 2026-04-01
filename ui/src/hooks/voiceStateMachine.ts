// --- Shared voice types (owned here to avoid circular imports) ---

export type VoiceSurface = 'editor' | 'terminal'

export type FormattingStatus = 'formatted' | 'fallback_raw' | 'empty'

export interface ComposeData {
  rawText: string
  displayText: string
  formattingStatus: FormattingStatus
  warning?: string
}

export interface VoiceTargetContext {
  surface: VoiceSurface
  filePath?: string
  sessionName?: string
}

export type InteractionState =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'transcribing'
  | 'formatting'
  | 'composing'
  | 'recoverable'
  | 'error'

// --- Phase (discriminated union state) ---

export type VoicePhase =
  | { phase: 'idle'; notice: string | null }
  | { phase: 'requesting_permission'; target: VoiceTargetContext; runId: number }
  | { phase: 'recording'; target: VoiceTargetContext; runId: number; startedAt: number }
  | { phase: 'transcribing'; target: VoiceTargetContext; runId: number }
  | { phase: 'formatting'; target: VoiceTargetContext; runId: number }
  | { phase: 'composing'; target: VoiceTargetContext; compose: ComposeData; targetLost: boolean }
  | { phase: 'error'; message: string; retryTarget: VoiceTargetContext | null }

// --- Events ---

export type VoiceEvent =
  | { type: 'START'; target: VoiceTargetContext }
  | { type: 'PERMISSION_GRANTED'; startedAt: number }
  | { type: 'PERMISSION_DENIED'; message: string }
  | { type: 'STOP' }
  | { type: 'TOO_SHORT' }
  | { type: 'COMPOSE_READY'; compose: ComposeData; runId: number }
  | { type: 'NO_SPEECH'; message: string; runId: number }
  | { type: 'FAIL'; message: string; runId: number }
  | { type: 'TARGET_LOST' }
  | { type: 'CONFIRM' }
  | { type: 'DISCARD' }
  | { type: 'COPY' }
  | { type: 'DISMISS' }

// --- Reducer state wraps phase + monotonic run counter ---

export interface VoiceReducerState {
  phase: VoicePhase
  runCounter: number
}

export const INITIAL_STATE: VoiceReducerState = {
  phase: { phase: 'idle', notice: null },
  runCounter: 0,
}

// --- Reducer ---

export function voiceReducer(state: VoiceReducerState, event: VoiceEvent): VoiceReducerState {
  const { phase } = state

  switch (event.type) {
    case 'START': {
      if (phase.phase !== 'idle') return state
      const runId = state.runCounter + 1
      return {
        runCounter: runId,
        phase: { phase: 'requesting_permission', target: event.target, runId },
      }
    }

    case 'PERMISSION_GRANTED':
      if (phase.phase !== 'requesting_permission') return state
      return { ...state, phase: { phase: 'recording', target: phase.target, runId: phase.runId, startedAt: event.startedAt } }

    case 'PERMISSION_DENIED':
      if (phase.phase !== 'requesting_permission') return state
      return { ...state, phase: { phase: 'error', message: event.message, retryTarget: phase.target } }

    case 'STOP':
      if (phase.phase !== 'recording') return state
      return { ...state, phase: { phase: 'transcribing', target: phase.target, runId: phase.runId } }

    case 'TOO_SHORT':
      if (phase.phase !== 'recording') return state
      return { ...state, phase: { phase: 'idle', notice: null } }

    case 'COMPOSE_READY': {
      if (phase.phase !== 'transcribing' && phase.phase !== 'formatting') return state
      if (event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'composing', target: phase.target, compose: event.compose, targetLost: false } }
    }

    case 'NO_SPEECH': {
      if (phase.phase !== 'transcribing' && phase.phase !== 'formatting') return state
      if (event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'idle', notice: event.message } }
    }

    case 'FAIL': {
      if (phase.phase !== 'transcribing' && phase.phase !== 'formatting' && phase.phase !== 'recording') return state
      if ('runId' in phase && event.runId !== phase.runId) return state
      const target = 'target' in phase ? phase.target : null
      return { ...state, phase: { phase: 'error', message: event.message, retryTarget: target } }
    }

    case 'TARGET_LOST':
      if (phase.phase !== 'composing') return state
      return { ...state, phase: { ...phase, targetLost: true } }

    case 'CONFIRM':
      if (phase.phase !== 'composing') return state
      return { ...state, phase: { phase: 'idle', notice: null } }

    case 'DISCARD':
      if (phase.phase !== 'composing') return state
      return { ...state, phase: { phase: 'idle', notice: null } }

    case 'COPY':
      if (phase.phase === 'composing' && phase.targetLost) {
        return { ...state, phase: { phase: 'idle', notice: null } }
      }
      return state

    case 'DISMISS':
      if (phase.phase !== 'error') return state
      return { ...state, phase: { phase: 'idle', notice: null } }

    default:
      return state
  }
}

// --- Selectors (derive public API shape from VoicePhase) ---

export function selectInteractionState(p: VoicePhase): InteractionState {
  if (p.phase === 'requesting_permission') return 'requesting_permission'
  if (p.phase === 'composing' && p.targetLost) return 'recoverable'
  return p.phase as InteractionState
}

export function selectCompose(p: VoicePhase): ComposeData | null {
  return p.phase === 'composing' ? p.compose : null
}

export function selectTarget(p: VoicePhase): VoiceTargetContext | null {
  return 'target' in p ? p.target : null
}

export function selectErrorMessage(p: VoicePhase): string | null {
  return p.phase === 'error' ? p.message : null
}

export function selectNotice(p: VoicePhase): string | null {
  return p.phase === 'idle' ? p.notice : null
}
