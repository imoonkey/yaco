// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  voiceReducer, INITIAL_STATE,
  selectInteractionState, selectTarget, selectErrorMessage, selectNotice,
  type VoiceReducerState, type VoiceTargetContext,
} from '../voiceStateMachine'

const TARGET: VoiceTargetContext = { surface: 'editor', filePath: 'notes.md' }
const TERM: VoiceTargetContext = { surface: 'terminal', sessionName: 's1' }

// Drive idle → recording, returning the live state + the run id.
function startRecording(target: VoiceTargetContext = TARGET): { state: VoiceReducerState; runId: number } {
  const runId = 1
  let state = voiceReducer(INITIAL_STATE, { type: 'START_RECORD', target, runId })
  state = voiceReducer(state, { type: 'PERMISSION_GRANTED', startedAt: 1000, runId })
  return { state, runId }
}

describe('voiceReducer — single-take lifecycle', () => {
  it('OPEN opens the tray idle (composing) for type/paste', () => {
    const state = voiceReducer(INITIAL_STATE, { type: 'OPEN', target: TARGET })
    expect(state.phase.phase).toBe('composing')
    expect(selectTarget(state.phase)).toEqual(TARGET)
    expect(selectInteractionState(state.phase)).toBe('composing')
  })

  it('records → transcribes → composes', () => {
    const { state: rec, runId } = startRecording()
    expect(rec.phase.phase).toBe('recording')

    const trans = voiceReducer(rec, { type: 'STOP', runId })
    expect(trans.phase.phase).toBe('transcribing')

    const composed = voiceReducer(trans, { type: 'TRANSCRIBED', runId })
    expect(composed.phase.phase).toBe('composing')
  })

  it('STOP with a stale run id is ignored', () => {
    const { state, runId } = startRecording()
    const stale = voiceReducer(state, { type: 'STOP', runId: runId + 99 })
    expect(stale).toBe(state)
  })

  it('NO_SPEECH lands in composing with a notice', () => {
    const { state, runId } = startRecording()
    const trans = voiceReducer(state, { type: 'STOP', runId })
    const composed = voiceReducer(trans, { type: 'NO_SPEECH', message: 'No speech detected.', runId })
    expect(composed.phase.phase).toBe('composing')
    expect(selectNotice(composed.phase)).toBe('No speech detected.')
  })

  it('FAIL during transcribe → error; RETRY → transcribing with a fresh run', () => {
    const { state, runId } = startRecording()
    const trans = voiceReducer(state, { type: 'STOP', runId })
    const errored = voiceReducer(trans, { type: 'FAIL', message: 'Transcription failed. Try again.', runId })
    expect(errored.phase.phase).toBe('error')
    expect(selectErrorMessage(errored.phase)).toBe('Transcription failed. Try again.')

    const retryRunId = errored.runCounter + 1
    const retrying = voiceReducer(errored, { type: 'RETRY', runId: retryRunId })
    expect(retrying.phase.phase).toBe('transcribing')
    expect(retrying.runCounter).toBe(retryRunId)
  })

  it('appends another take from composing, keeping the frozen target', () => {
    const { state } = startRecording()
    const composed = voiceReducer(voiceReducer(state, { type: 'STOP', runId: 1 }), { type: 'TRANSCRIBED', runId: 1 })
    const again = voiceReducer(composed, { type: 'START_RECORD', target: TERM /* ignored */, runId: 2 })
    expect(again.phase.phase).toBe('requesting_permission')
    expect(selectTarget(again.phase)).toEqual(TARGET)
    expect(again.runCounter).toBe(2)
  })

  it('TARGET_LOST is idempotent — re-flagging an already-lost run is a no-op', () => {
    const { state } = startRecording()
    const lost = voiceReducer(state, { type: 'TARGET_LOST' })
    expect(lost).not.toBe(state)
    // Same reference back: prevents the detection effect's per-render re-dispatch loop.
    expect(voiceReducer(lost, { type: 'TARGET_LOST' })).toBe(lost)
  })

  it('TARGET_LOST flags the run; composing+lost reads as recoverable', () => {
    const { state } = startRecording()
    const lost = voiceReducer(state, { type: 'TARGET_LOST' })
    const composed = voiceReducer(voiceReducer(lost, { type: 'STOP', runId: 1 }), { type: 'TRANSCRIBED', runId: 1 })
    expect(selectInteractionState(composed.phase)).toBe('recoverable')
  })

  it('CONFIRM closes from composing or error', () => {
    const { state } = startRecording()
    const composed = voiceReducer(voiceReducer(state, { type: 'STOP', runId: 1 }), { type: 'TRANSCRIBED', runId: 1 })
    expect(voiceReducer(composed, { type: 'CONFIRM' }).phase.phase).toBe('idle')

    const errored = voiceReducer(voiceReducer(state, { type: 'STOP', runId: 1 }), { type: 'FAIL', message: 'x', runId: 1 })
    expect(voiceReducer(errored, { type: 'CONFIRM' }).phase.phase).toBe('idle')
  })

  it('DISCARD closes from any open phase', () => {
    const { state } = startRecording()
    expect(voiceReducer(state, { type: 'DISCARD' }).phase.phase).toBe('idle')
    expect(voiceReducer(INITIAL_STATE, { type: 'DISCARD' })).toBe(INITIAL_STATE)
  })

  it('COPY closes only when the target is lost', () => {
    const { state } = startRecording()
    const composed = voiceReducer(voiceReducer(state, { type: 'STOP', runId: 1 }), { type: 'TRANSCRIBED', runId: 1 })
    expect(voiceReducer(composed, { type: 'COPY' }).phase.phase).toBe('composing')

    const lost = voiceReducer(composed, { type: 'TARGET_LOST' })
    expect(voiceReducer(lost, { type: 'COPY' }).phase.phase).toBe('idle')
  })
})
