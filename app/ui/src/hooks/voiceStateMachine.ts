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
  | 'active'
  | 'composing'
  | 'recoverable'
  | 'error'

// --- Segment: one coalesced ~10s transcription slot ---
// text === null  -> /transcribe in flight
// text === ''    -> chunk dropped / timed out / failed
// text === '...' -> resolved transcript
export interface Segment {
  index: number
  text: string | null
}

// --- Phase (discriminated union state) ---
//
// The whole capture lifecycle — listening, finishing, formatting — lives in a
// single `active` phase. A final utterance VAD flushes *after* Stop is just one
// more segment event, never a cross-state race.
export type VoicePhase =
  | { phase: 'idle'; notice: string | null }
  | { phase: 'requesting_permission'; target: VoiceTargetContext; runId: number }
  | {
      phase: 'active'
      target: VoiceTargetContext
      runId: number
      startedAt: number
      segments: Segment[]
      nextIndex: number
      closedForInput: boolean // Stop pressed — no more user speech accepted
      vadStopped: boolean // vad.stop() resolved — every final chunk registered
      pendingCount: number // chunks still in flight (null slots)
      formatting: boolean // /format request in flight (gate already fired)
      targetLost: boolean // insertion target vanished mid-run
    }
  | { phase: 'composing'; target: VoiceTargetContext; compose: ComposeData; targetLost: boolean }
  | { phase: 'error'; message: string; retryTarget: VoiceTargetContext | null }

// --- Events ---
// Every event born from an async operation carries `runId` and is dropped on
// mismatch (stale transcription, late flush, aborted run, doubled permission).
// TARGET_LOST has no runId on purpose: it is dispatched synchronously from a
// React effect observing the live phase, so it has no async boundary that could
// carry a stale run — it only ever flags the current active/composing run.
export type VoiceEvent =
  | { type: 'START'; target: VoiceTargetContext }
  | { type: 'PERMISSION_GRANTED'; startedAt: number; runId: number }
  | { type: 'PERMISSION_DENIED'; message: string; runId: number }
  | { type: 'SEGMENT_PENDING'; index: number; runId: number }
  | { type: 'SEGMENT_RESOLVED'; index: number; text: string; runId: number }
  | { type: 'STOP' }
  | { type: 'VAD_STOPPED'; runId: number }
  | { type: 'START_FORMAT' }
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

// --- Finalize gate (derived, not awaited) ---
//
// The hook does not "await stop then drain." It dispatches STOP, calls
// vad.stop() (whose flush synchronously registers a SEGMENT_PENDING before the
// promise resolves), then dispatches VAD_STOPPED. Finalization is derived: a
// late chunk can never slip past the snapshot because it bumped pendingCount
// before VAD_STOPPED, so the gate simply has not opened yet.
//
// The reducer treats this as the single source of truth: START_FORMAT,
// NO_SPEECH and COMPOSE_READY are accepted only when the gate (or, for
// COMPOSE_READY, the formatting stage the gate opens) agrees — no event can
// bypass it.
export type Finalization =
  | { kind: 'pending' } // gate not open (or already formatting)
  | { kind: 'no_speech' } // zero chunks ever detected
  | { kind: 'failed' } // >=1 chunk but all dropped/failed
  | { kind: 'format'; text: string } // assemble joined transcript

export function selectFinalization(p: VoicePhase): Finalization {
  if (p.phase !== 'active' || p.formatting) return { kind: 'pending' }
  if (!p.closedForInput || !p.vadStopped || p.pendingCount !== 0) return { kind: 'pending' }
  if (p.segments.length === 0) return { kind: 'no_speech' }
  const text = joinSegments(p.segments)
  return text.length === 0 ? { kind: 'failed' } : { kind: 'format', text }
}

function joinSegments(segments: Segment[]): string {
  return segments
    .map(s => s.text ?? '')
    .filter(t => t.length > 0)
    .join(' ')
    .trim()
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
      if (phase.phase !== 'requesting_permission' || event.runId !== phase.runId) return state
      return {
        ...state,
        phase: {
          phase: 'active',
          target: phase.target,
          runId: phase.runId,
          startedAt: event.startedAt,
          segments: [],
          nextIndex: 0,
          closedForInput: false,
          vadStopped: false,
          pendingCount: 0,
          formatting: false,
          targetLost: false,
        },
      }

    case 'PERMISSION_DENIED':
      if (phase.phase !== 'requesting_permission' || event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'error', message: event.message, retryTarget: phase.target } }

    case 'SEGMENT_PENDING': {
      // Accepted even after Stop (closedForInput): the flushed remainder is a
      // canonical segment. Rejected only once we have committed to formatting.
      if (phase.phase !== 'active' || phase.formatting || event.runId !== phase.runId) return state
      if (phase.segments.some(s => s.index === event.index)) return state
      return {
        ...state,
        phase: {
          ...phase,
          segments: [...phase.segments, { index: event.index, text: null }],
          nextIndex: Math.max(phase.nextIndex, event.index + 1),
          pendingCount: phase.pendingCount + 1,
        },
      }
    }

    case 'SEGMENT_RESOLVED': {
      if (phase.phase !== 'active' || event.runId !== phase.runId) return state
      const slot = phase.segments.find(s => s.index === event.index)
      if (!slot || slot.text !== null) return state // unknown or already filled
      return {
        ...state,
        phase: {
          ...phase,
          segments: phase.segments.map(s => (s.index === event.index ? { ...s, text: event.text } : s)),
          pendingCount: phase.pendingCount - 1,
        },
      }
    }

    case 'STOP':
      if (phase.phase !== 'active' || phase.closedForInput) return state
      return { ...state, phase: { ...phase, closedForInput: true } }

    case 'VAD_STOPPED':
      if (phase.phase !== 'active' || phase.vadStopped || event.runId !== phase.runId) return state
      return { ...state, phase: { ...phase, vadStopped: true } }

    case 'START_FORMAT':
      // Cannot bypass the gate: only valid when finalization derives `format`.
      if (phase.phase !== 'active' || selectFinalization(phase).kind !== 'format') return state
      return { ...state, phase: { ...phase, formatting: true } }

    case 'COMPOSE_READY':
      // The /format result only lands while formatting is in flight, which is
      // reachable solely through the gate via START_FORMAT.
      if (phase.phase !== 'active' || event.runId !== phase.runId || !phase.formatting) return state
      return {
        ...state,
        phase: { phase: 'composing', target: phase.target, compose: event.compose, targetLost: phase.targetLost },
      }

    case 'NO_SPEECH':
      // Cannot bypass the gate: only valid when finalization derives `no_speech`.
      if (phase.phase !== 'active' || event.runId !== phase.runId) return state
      if (selectFinalization(phase).kind !== 'no_speech') return state
      return { ...state, phase: { phase: 'idle', notice: event.message } }

    case 'FAIL':
      // FAIL has several legitimate sources (permission, mid-run network/abort,
      // the `failed` finalization branch, /format failure), so it is not tied
      // to the gate — only run-isolated.
      if (phase.phase !== 'active' && phase.phase !== 'requesting_permission') return state
      if (event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'error', message: event.message, retryTarget: phase.target } }

    case 'TARGET_LOST':
      if (phase.phase === 'active' || phase.phase === 'composing') {
        return { ...state, phase: { ...phase, targetLost: true } }
      }
      return state

    case 'CONFIRM':
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
  if (p.phase === 'composing' && p.targetLost) return 'recoverable'
  return p.phase
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

export function selectSegments(p: VoicePhase): Segment[] {
  return p.phase === 'active' ? p.segments : []
}

export function selectLiveTranscript(p: VoicePhase): string {
  return p.phase === 'active' ? joinSegments(p.segments) : ''
}

export function selectPendingCount(p: VoicePhase): number {
  return p.phase === 'active' ? p.pendingCount : 0
}
