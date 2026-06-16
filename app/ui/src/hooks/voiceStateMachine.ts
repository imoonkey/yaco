// --- Shared voice types (owned here to avoid circular imports) ---

export type VoiceSurface = 'editor' | 'terminal'

export interface VoiceTargetContext {
  surface: VoiceSurface
  filePath?: string
  sessionName?: string
  // Which editor/terminal instance the take is bound to. Set at record/open and
  // re-pointed only by RETARGET (the tray's target selector), so a confirmed
  // transcript routes to whichever pane is chosen at Insert time even when the
  // active instance has since changed (design: §G).
  instanceId?: string
}

export type InteractionState =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'transcribing'
  | 'composing'
  | 'recoverable'
  | 'error'

// --- Phase (discriminated union state) ---
//
// Single take, no segmentation. A take is one continuous recording the user
// ends (Stop / F5 / the session cap); it is transcribed once, then its text is
// appended to the compose draft. The tray is open for every phase except `idle`,
// so the draft (owned by the tray) survives recording → transcribing → composing
// → error without unmounting. `targetLost` rides along so a mid-run detach is
// still known once we reach `composing` (where Insert is gated).
export type VoicePhase =
  | { phase: 'idle'; notice: string | null }
  | { phase: 'requesting_permission'; target: VoiceTargetContext; runId: number; targetLost: boolean }
  | { phase: 'recording'; target: VoiceTargetContext; runId: number; startedAt: number; targetLost: boolean }
  | { phase: 'transcribing'; target: VoiceTargetContext; runId: number; targetLost: boolean }
  | { phase: 'composing'; target: VoiceTargetContext; targetLost: boolean; notice: string | null }
  | { phase: 'error'; target: VoiceTargetContext; message: string; targetLost: boolean }

// --- Events ---
// Every event born from an async operation carries `runId` and is dropped on
// mismatch (stale transcription, aborted run, doubled permission). TARGET_LOST
// has no runId: it is dispatched synchronously from a React effect observing the
// live phase, so it can only flag the current run.
export type VoiceEvent =
  | { type: 'OPEN'; target: VoiceTargetContext } // open the tray idle (type / paste)
  | { type: 'START_RECORD'; target: VoiceTargetContext; runId: number } // begin a take
  | { type: 'RETARGET'; target: VoiceTargetContext } // re-point the open run (tray selector)
  | { type: 'PERMISSION_GRANTED'; startedAt: number; runId: number }
  | { type: 'PERMISSION_DENIED'; message: string; runId: number }
  | { type: 'STOP'; runId: number } // user ended the take → transcribe
  | { type: 'TRANSCRIBED'; runId: number } // take's text appended → back to composing
  | { type: 'NO_SPEECH'; message: string; runId: number } // empty take → composing notice
  | { type: 'FAIL'; message: string; runId: number }
  | { type: 'RETRY'; runId: number } // re-run from the cached blob → transcribing
  | { type: 'TARGET_LOST' }
  | { type: 'CONFIRM' }
  | { type: 'COPY' }
  | { type: 'DISCARD' } // also the close (X / Esc) path from any open phase

// --- Reducer state wraps phase + monotonic run counter ---

export interface VoiceReducerState {
  phase: VoicePhase
  runCounter: number
}

export const INITIAL_STATE: VoiceReducerState = {
  phase: { phase: 'idle', notice: null },
  runCounter: 0,
}

// A take or retry opens a new run. The hook is the sole run-id generator and
// passes the id in the event, so the reducer just stores it — they can never
// desync even if a duplicate START_RECORD is dropped on the wrong phase.
function beginRun(
  target: VoiceTargetContext,
  targetLost: boolean,
  runId: number,
): VoiceReducerState {
  return { runCounter: runId, phase: { phase: 'requesting_permission', target, runId, targetLost } }
}

// --- Reducer ---

export function voiceReducer(state: VoiceReducerState, event: VoiceEvent): VoiceReducerState {
  const { phase } = state

  switch (event.type) {
    case 'OPEN':
      if (phase.phase !== 'idle') return state
      return { ...state, phase: { phase: 'composing', target: event.target, targetLost: false, notice: null } }

    case 'START_RECORD':
      if (phase.phase === 'idle') return beginRun(event.target, false, event.runId)
      if (phase.phase === 'composing' || phase.phase === 'error') {
        // A re-record reuses the run's current target; change it via RETARGET.
        return beginRun(phase.target, phase.targetLost, event.runId)
      }
      return state

    case 'RETARGET':
      // The tray's target selector re-points the open run. Allowed only while
      // composing/error (recoverable's phase is 'composing'); an in-flight take
      // keeps its bound target. Clearing targetLost recovers a lost run — the
      // user picked from the live-eligible list, and the detection effect
      // re-flags if the new target is somehow still invalid.
      if (phase.phase !== 'composing' && phase.phase !== 'error') return state
      return { ...state, phase: { ...phase, target: event.target, targetLost: false } }

    case 'PERMISSION_GRANTED':
      if (phase.phase !== 'requesting_permission' || event.runId !== phase.runId) return state
      return {
        ...state,
        phase: {
          phase: 'recording',
          target: phase.target,
          runId: phase.runId,
          startedAt: event.startedAt,
          targetLost: phase.targetLost,
        },
      }

    case 'PERMISSION_DENIED':
      if (phase.phase !== 'requesting_permission' || event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'error', target: phase.target, message: event.message, targetLost: phase.targetLost } }

    case 'STOP':
      if (phase.phase !== 'recording' || event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'transcribing', target: phase.target, runId: phase.runId, targetLost: phase.targetLost } }

    case 'TRANSCRIBED':
      if (phase.phase !== 'transcribing' || event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'composing', target: phase.target, targetLost: phase.targetLost, notice: null } }

    case 'NO_SPEECH':
      if (phase.phase !== 'transcribing' || event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'composing', target: phase.target, targetLost: phase.targetLost, notice: event.message } }

    case 'FAIL':
      if (
        phase.phase !== 'requesting_permission' &&
        phase.phase !== 'recording' &&
        phase.phase !== 'transcribing'
      ) return state
      if (event.runId !== phase.runId) return state
      return { ...state, phase: { phase: 'error', target: phase.target, message: event.message, targetLost: phase.targetLost } }

    case 'RETRY':
      if (phase.phase !== 'error') return state
      return {
        runCounter: event.runId,
        phase: { phase: 'transcribing', target: phase.target, runId: event.runId, targetLost: phase.targetLost },
      }

    case 'TARGET_LOST':
      // Idempotent: re-flagging an already-lost run must return the SAME state,
      // else the detection effect (which re-runs every render) loops forever.
      if (phase.phase === 'idle') return state
      if (phase.targetLost) return state
      return { ...state, phase: { ...phase, targetLost: true } }

    case 'CONFIRM':
      // Insert the draft from composing, or from error (a failed take must not
      // block inserting the text already gathered).
      if (phase.phase !== 'composing' && phase.phase !== 'error') return state
      return { ...state, phase: { phase: 'idle', notice: null } }

    case 'COPY':
      // Copy is a side action; it only closes the tray when the target is gone
      // (Insert is impossible, so Copy is the rescue).
      if (phase.phase === 'composing' && phase.targetLost) {
        return { ...state, phase: { phase: 'idle', notice: null } }
      }
      return state

    case 'DISCARD':
      // The close (X / Esc / Discard) path from any open phase.
      if (phase.phase === 'idle') return state
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

export function selectTarget(p: VoicePhase): VoiceTargetContext | null {
  return 'target' in p ? p.target : null
}

export function selectErrorMessage(p: VoicePhase): string | null {
  return p.phase === 'error' ? p.message : null
}

export function selectNotice(p: VoicePhase): string | null {
  if (p.phase === 'idle') return p.notice
  if (p.phase === 'composing') return p.notice
  return null
}
