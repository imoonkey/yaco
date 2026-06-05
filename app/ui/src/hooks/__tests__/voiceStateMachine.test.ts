import { describe, it, expect } from 'vitest'
import {
  voiceReducer,
  INITIAL_STATE,
  selectFinalization,
  selectInteractionState,
  selectLiveTranscript,
  selectTarget,
  type VoiceReducerState,
  type VoiceEvent,
  type VoiceTargetContext,
} from '../voiceStateMachine'

const TARGET: VoiceTargetContext = { surface: 'editor', filePath: '/notes.md' }

// Fold a list of events over the reducer.
function reduce(state: VoiceReducerState, ...events: VoiceEvent[]): VoiceReducerState {
  return events.reduce(voiceReducer, state)
}

// Drive idle -> active and return both the state and the run's id.
function startActive(target: VoiceTargetContext = TARGET): { state: VoiceReducerState; runId: number } {
  const requesting = reduce(INITIAL_STATE, { type: 'START', target })
  if (requesting.phase.phase !== 'requesting_permission') throw new Error('expected requesting_permission')
  const runId = requesting.phase.runId
  const state = reduce(requesting, { type: 'PERMISSION_GRANTED', startedAt: 1000, runId })
  if (state.phase.phase !== 'active') throw new Error('expected active')
  return { state, runId }
}

function assertActive(state: VoiceReducerState) {
  if (state.phase.phase !== 'active') throw new Error(`expected active, got ${state.phase.phase}`)
  return state.phase
}

describe('voiceReducer — lifecycle', () => {
  it('walks idle → requesting_permission → active with a fresh run', () => {
    const { state, runId } = startActive()
    const p = assertActive(state)
    expect(runId).toBe(1)
    expect(p.runId).toBe(1)
    expect(p.startedAt).toBe(1000)
    expect(p.segments).toEqual([])
    expect(p.nextIndex).toBe(0)
    expect(p.closedForInput).toBe(false)
    expect(p.vadStopped).toBe(false)
    expect(p.pendingCount).toBe(0)
    expect(p.formatting).toBe(false)
    expect(p.targetLost).toBe(false)
    expect(selectInteractionState(p)).toBe('active')
    expect(selectTarget(p)).toEqual(TARGET)
  })

  it('START is ignored unless idle', () => {
    const { state } = startActive()
    expect(voiceReducer(state, { type: 'START', target: { surface: 'terminal' } })).toBe(state)
  })

  it('PERMISSION_DENIED → error, DISMISS → idle', () => {
    const requesting = reduce(INITIAL_STATE, { type: 'START', target: TARGET })
    const runId = requesting.phase.phase === 'requesting_permission' ? requesting.phase.runId : -1
    const denied = reduce(requesting, { type: 'PERMISSION_DENIED', message: 'Microphone denied.', runId })
    expect(denied.phase).toEqual({ phase: 'error', message: 'Microphone denied.', retryTarget: TARGET })
    const idle = reduce(denied, { type: 'DISMISS' })
    expect(idle.phase).toEqual({ phase: 'idle', notice: null })
  })
})

describe('voiceReducer — segments', () => {
  it('pushes pending slots and assigns nextIndex / pendingCount', () => {
    const { state, runId } = startActive()
    const s = reduce(
      state,
      { type: 'SEGMENT_PENDING', index: 0, runId },
      { type: 'SEGMENT_PENDING', index: 1, runId },
    )
    const p = assertActive(s)
    expect(p.segments).toEqual([
      { index: 0, text: null },
      { index: 1, text: null },
    ])
    expect(p.nextIndex).toBe(2)
    expect(p.pendingCount).toBe(2)
  })

  it('ignores a duplicate pending for an index already present', () => {
    const { state, runId } = startActive()
    const s = reduce(
      state,
      { type: 'SEGMENT_PENDING', index: 0, runId },
      { type: 'SEGMENT_PENDING', index: 0, runId },
    )
    const p = assertActive(s)
    expect(p.segments).toHaveLength(1)
    expect(p.pendingCount).toBe(1)
  })

  it('fills slots by index for out-of-order /transcribe returns', () => {
    const { state, runId } = startActive()
    let s = reduce(
      state,
      { type: 'SEGMENT_PENDING', index: 0, runId },
      { type: 'SEGMENT_PENDING', index: 1, runId },
      { type: 'SEGMENT_PENDING', index: 2, runId },
    )
    // Resolve out of order: 2, then 0, then 1.
    s = reduce(
      s,
      { type: 'SEGMENT_RESOLVED', index: 2, text: 'world', runId },
      { type: 'SEGMENT_RESOLVED', index: 0, text: 'hello', runId },
      { type: 'SEGMENT_RESOLVED', index: 1, text: 'there', runId },
    )
    const p = assertActive(s)
    expect(p.pendingCount).toBe(0)
    expect(p.segments.map(x => x.text)).toEqual(['hello', 'there', 'world'])
    // Live transcript stays in index order regardless of resolve order.
    expect(selectLiveTranscript(p)).toBe('hello there world')
  })

  it('ignores a resolve for an unknown or already-filled slot', () => {
    const { state, runId } = startActive()
    const pending = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    const filled = reduce(pending, { type: 'SEGMENT_RESOLVED', index: 0, text: 'hi', runId })
    expect(assertActive(filled).pendingCount).toBe(0)
    // Unknown index — no-op.
    expect(voiceReducer(filled, { type: 'SEGMENT_RESOLVED', index: 9, text: 'x', runId })).toBe(filled)
    // Already filled — no-op (pendingCount must not go negative).
    expect(voiceReducer(filled, { type: 'SEGMENT_RESOLVED', index: 0, text: 'dup', runId })).toBe(filled)
  })
})

describe('voiceReducer — runId guard (stale run)', () => {
  it('drops async events whose runId does not match the active run', () => {
    const { state, runId } = startActive()
    const stale = runId + 7
    const pending = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })

    expect(voiceReducer(pending, { type: 'SEGMENT_PENDING', index: 1, runId: stale })).toBe(pending)
    expect(voiceReducer(pending, { type: 'SEGMENT_RESOLVED', index: 0, text: 'x', runId: stale })).toBe(pending)
    expect(voiceReducer(pending, { type: 'VAD_STOPPED', runId: stale })).toBe(pending)
    expect(voiceReducer(pending, { type: 'NO_SPEECH', message: 'n', runId: stale })).toBe(pending)
    expect(voiceReducer(pending, { type: 'FAIL', message: 'f', runId: stale })).toBe(pending)
    expect(
      voiceReducer(pending, {
        type: 'COMPOSE_READY',
        runId: stale,
        compose: { rawText: 'r', displayText: 'd', formattingStatus: 'formatted' },
      }),
    ).toBe(pending)
  })

  it('a resolve from a previous run never lands in a newer run', () => {
    // Run 1 → fail → dismiss → run 2. A run-1 promise resolving late is dropped.
    const first = startActive()
    const failed = reduce(first.state, { type: 'STOP' }, { type: 'VAD_STOPPED', runId: first.runId })
    // gate: no chunks → hook would dispatch NO_SPEECH; simulate a FAIL path instead
    const errored = reduce(failed, { type: 'FAIL', message: 'boom', runId: first.runId })
    expect(errored.phase.phase).toBe('error')
    const idle = reduce(errored, { type: 'DISMISS' })

    const requesting = reduce(idle, { type: 'START', target: TARGET })
    const run2 = requesting.phase.phase === 'requesting_permission' ? requesting.phase.runId : -1
    expect(run2).toBe(first.runId + 1)
    const active2 = reduce(requesting, { type: 'PERMISSION_GRANTED', startedAt: 2000, runId: run2 })
    const pendingRun2 = reduce(active2, { type: 'SEGMENT_PENDING', index: 0, runId: run2 })
    // Late resolve from run 1 — dropped.
    const after = voiceReducer(pendingRun2, { type: 'SEGMENT_RESOLVED', index: 0, text: 'old', runId: first.runId })
    expect(after).toBe(pendingRun2)
  })
})

describe('voiceReducer — finalize gate', () => {
  it('stays pending until closedForInput && vadStopped && pendingCount === 0', () => {
    const { state, runId } = startActive()
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })

    expect(selectFinalization(s.phase)).toEqual({ kind: 'pending' }) // nothing closed yet

    s = reduce(s, { type: 'STOP' })
    expect(assertActive(s).closedForInput).toBe(true)
    expect(selectFinalization(s.phase)).toEqual({ kind: 'pending' }) // vad not stopped

    s = reduce(s, { type: 'VAD_STOPPED', runId })
    expect(selectFinalization(s.phase)).toEqual({ kind: 'pending' }) // chunk still in flight

    s = reduce(s, { type: 'SEGMENT_RESOLVED', index: 0, text: 'done', runId })
    expect(selectFinalization(s.phase)).toEqual({ kind: 'format', text: 'done' })
  })

  it('STOP + late flush after Stop is a canonical segment, not a race', () => {
    const { state, runId } = startActive()
    // One in-flight chunk while still listening.
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    // User presses Stop.
    s = reduce(s, { type: 'STOP' })
    // vad.stop() flush emits the buffered remainder *after* Stop — accepted.
    s = reduce(s, { type: 'SEGMENT_PENDING', index: 1, runId })
    expect(assertActive(s).pendingCount).toBe(2)
    // vad.stop() resolves.
    s = reduce(s, { type: 'VAD_STOPPED', runId })
    expect(selectFinalization(s.phase)).toEqual({ kind: 'pending' }) // both still pending

    // Both transcriptions return.
    s = reduce(
      s,
      { type: 'SEGMENT_RESOLVED', index: 0, text: 'first', runId },
      { type: 'SEGMENT_RESOLVED', index: 1, text: 'last', runId },
    )
    // The late chunk is included in the final transcript.
    expect(selectFinalization(s.phase)).toEqual({ kind: 'format', text: 'first last' })
  })

  it('zero chunks ever detected → NO_SPEECH, distinct from FAIL', () => {
    const { state, runId } = startActive()
    const s = reduce(state, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    expect(selectFinalization(s.phase)).toEqual({ kind: 'no_speech' })
  })

  it('>=1 chunk but all dropped/failed → FAIL, distinct from NO_SPEECH', () => {
    const { state, runId } = startActive()
    let s = reduce(
      state,
      { type: 'SEGMENT_PENDING', index: 0, runId },
      { type: 'SEGMENT_PENDING', index: 1, runId },
    )
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    // Both chunks resolve empty (timeout / drop / failed /transcribe).
    s = reduce(
      s,
      { type: 'SEGMENT_RESOLVED', index: 0, text: '', runId },
      { type: 'SEGMENT_RESOLVED', index: 1, text: '', runId },
    )
    expect(selectFinalization(s.phase)).toEqual({ kind: 'failed' })
  })

  it('mixed failed + good chunks formats only the surviving text', () => {
    const { state, runId } = startActive()
    let s = reduce(
      state,
      { type: 'SEGMENT_PENDING', index: 0, runId },
      { type: 'SEGMENT_PENDING', index: 1, runId },
      { type: 'SEGMENT_PENDING', index: 2, runId },
    )
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    s = reduce(
      s,
      { type: 'SEGMENT_RESOLVED', index: 0, text: 'keep', runId },
      { type: 'SEGMENT_RESOLVED', index: 1, text: '', runId },
      { type: 'SEGMENT_RESOLVED', index: 2, text: 'this', runId },
    )
    expect(selectFinalization(s.phase)).toEqual({ kind: 'format', text: 'keep this' })
  })

  it('START_FORMAT closes the gate so it cannot re-fire, and rejects new chunks', () => {
    const { state, runId } = startActive()
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    s = reduce(s, { type: 'SEGMENT_RESOLVED', index: 0, text: 'ready', runId })
    expect(selectFinalization(s.phase)).toEqual({ kind: 'format', text: 'ready' })

    // Hook commits to formatting.
    s = reduce(s, { type: 'START_FORMAT' })
    expect(assertActive(s).formatting).toBe(true)
    expect(selectFinalization(s.phase)).toEqual({ kind: 'pending' }) // gate will not re-fire

    // A stray late pending after formatting is rejected.
    const ignored = voiceReducer(s, { type: 'SEGMENT_PENDING', index: 1, runId })
    expect(ignored).toBe(s)

    // /format resolves.
    const done = reduce(s, {
      type: 'COMPOSE_READY',
      runId,
      compose: { rawText: 'ready', displayText: 'Ready.', formattingStatus: 'formatted' },
    })
    expect(done.phase.phase).toBe('composing')
  })

  it('STOP is idempotent', () => {
    const { state } = startActive()
    const once = reduce(state, { type: 'STOP' })
    expect(voiceReducer(once, { type: 'STOP' })).toBe(once)
  })
})

describe('voiceReducer — events cannot bypass the finalization gate', () => {
  it('START_FORMAT is ignored unless finalization derives `format`', () => {
    const { state, runId } = startActive()
    // Mid-recording, no Stop: gate closed.
    const pending = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    expect(voiceReducer(pending, { type: 'START_FORMAT' })).toBe(pending)
    // Stop but chunk still in flight: still closed.
    const stopped = reduce(pending, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    expect(voiceReducer(stopped, { type: 'START_FORMAT' })).toBe(stopped)
  })

  it('COMPOSE_READY is ignored unless formatting is in flight (post-gate)', () => {
    const { state, runId } = startActive()
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    s = reduce(s, { type: 'SEGMENT_RESOLVED', index: 0, text: 'ready', runId })
    // Gate says `format` but START_FORMAT has not run — a COMPOSE_READY here
    // would bypass the gate and must be dropped.
    const bypass = voiceReducer(s, {
      type: 'COMPOSE_READY',
      runId,
      compose: { rawText: 'ready', displayText: 'Ready.', formattingStatus: 'formatted' },
    })
    expect(bypass).toBe(s)
    // Only after START_FORMAT does COMPOSE_READY land.
    const formatting = reduce(s, { type: 'START_FORMAT' })
    const composing = reduce(formatting, {
      type: 'COMPOSE_READY',
      runId,
      compose: { rawText: 'ready', displayText: 'Ready.', formattingStatus: 'formatted' },
    })
    expect(composing.phase.phase).toBe('composing')
  })

  it('NO_SPEECH is ignored unless finalization derives `no_speech`', () => {
    const { state, runId } = startActive()
    // Mid-recording: gate closed → dropped.
    const recording = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    expect(voiceReducer(recording, { type: 'NO_SPEECH', message: 'n', runId })).toBe(recording)
    // A chunk exists, so even at the gate the branch is `failed`, not `no_speech` → dropped.
    let withChunk = reduce(recording, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    withChunk = reduce(withChunk, { type: 'SEGMENT_RESOLVED', index: 0, text: '', runId })
    expect(selectFinalization(withChunk.phase)).toEqual({ kind: 'failed' })
    expect(voiceReducer(withChunk, { type: 'NO_SPEECH', message: 'n', runId })).toBe(withChunk)
    // Zero chunks at the gate → accepted.
    const empty = reduce(startActive().state, { type: 'STOP' }, { type: 'VAD_STOPPED', runId: 1 })
    const idle = voiceReducer(empty, { type: 'NO_SPEECH', message: 'No speech detected.', runId: 1 })
    expect(idle.phase).toEqual({ phase: 'idle', notice: 'No speech detected.' })
  })
})

describe('voiceReducer — target lost', () => {
  it('target lost before compose carries into composing → recoverable', () => {
    const { state, runId } = startActive()
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    s = reduce(s, { type: 'SEGMENT_RESOLVED', index: 0, text: 'hi', runId })

    // Target vanishes while still active (e.g. editor file closed).
    s = reduce(s, { type: 'TARGET_LOST' })
    expect(assertActive(s).targetLost).toBe(true)

    // Finalize → format → compose carries the lost flag through.
    s = reduce(s, { type: 'START_FORMAT' })
    s = reduce(s, {
      type: 'COMPOSE_READY',
      runId,
      compose: { rawText: 'hi', displayText: 'Hi.', formattingStatus: 'formatted' },
    })
    expect(s.phase.phase).toBe('composing')
    if (s.phase.phase === 'composing') expect(s.phase.targetLost).toBe(true)
    expect(selectInteractionState(s.phase)).toBe('recoverable')
  })

  it('target lost during composing flips to recoverable', () => {
    const { state, runId } = startActive()
    let s = reduce(state, { type: 'SEGMENT_PENDING', index: 0, runId })
    s = reduce(s, { type: 'STOP' }, { type: 'VAD_STOPPED', runId })
    s = reduce(s, { type: 'SEGMENT_RESOLVED', index: 0, text: 'hi', runId })
    s = reduce(s, { type: 'START_FORMAT' })
    s = reduce(s, {
      type: 'COMPOSE_READY',
      runId,
      compose: { rawText: 'hi', displayText: 'Hi.', formattingStatus: 'formatted' },
    })
    expect(selectInteractionState(s.phase)).toBe('composing')
    s = reduce(s, { type: 'TARGET_LOST' })
    expect(selectInteractionState(s.phase)).toBe('recoverable')
  })

  it('CONFIRM and DISCARD from composing return to idle', () => {
    const compose = { rawText: 'hi', displayText: 'Hi.', formattingStatus: 'formatted' as const }
    const composing: VoiceReducerState = {
      runCounter: 1,
      phase: { phase: 'composing', target: TARGET, compose, targetLost: false },
    }
    expect(reduce(composing, { type: 'CONFIRM' }).phase).toEqual({ phase: 'idle', notice: null })
    expect(reduce(composing, { type: 'DISCARD' }).phase).toEqual({ phase: 'idle', notice: null })
  })
})
