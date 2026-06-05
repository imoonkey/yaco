import { useReducer, useEffect, useRef, useCallback, useState } from 'react'
import { API } from './useApi'
import {
  voiceReducer, INITIAL_STATE,
  selectInteractionState, selectCompose, selectTarget, selectErrorMessage, selectNotice,
  selectLiveTranscript, selectPendingCount, selectFinalization,
  type FormattingStatus, type VoiceTargetContext, type InteractionState, type ComposeData,
} from './voiceStateMachine'
import { checkBrowserCapability, startVadSession, MAX_RECORDING_SECONDS, type VadSession } from './voiceVad'

// Re-export shared types so consumers keep importing from './useVoice'
export type { VoiceSurface, FormattingStatus, ComposeData, VoiceTargetContext, InteractionState } from './voiceStateMachine'

export type CapabilityState =
  | { status: 'checking' }
  | { status: 'ready'; maxUploadBytes: number }
  | { status: 'unavailable'; reason: 'browser' | 'server'; message: string }

export interface UseVoiceReturn {
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  liveTranscript: string
  pendingCount: number
  compose: ComposeData | null
  target: VoiceTargetContext | null
  errorMessage: string | null
  noSpeechMessage: string | null
  start: (ctx: VoiceTargetContext) => void
  stop: () => void
  confirm: (text: string) => void
  discard: () => void
  copy: (text: string) => void
  dismiss: () => void
  retry: () => void
  markTargetLost: () => void
}

interface TranscribeResponse {
  text: string
}

interface FormatResponse {
  displayText: string
  formattingStatus: string
  warning?: string
}

type VoiceStatusResponse =
  | { enabled: true; sttModel: string; formatterModel: string; maxUploadBytes: number }
  | { enabled: false; reason: string }

const DEFAULT_MAX_UPLOAD_BYTES = 20_000_000
const TRANSCRIBE_TIMEOUT_MS = 30_000
const FORMAT_TIMEOUT_MS = 30_000
const REQUEST_WINDOW_MS = 60_000
const MAX_TRANSCRIBE_REQUESTS_PER_WINDOW = 20

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 1000
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 1000
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getResponseMessage(res: Response, fallback: string): Promise<string> {
  return res.json()
    .then((body: { error?: string; message?: string }) => body.error || body.message || fallback)
    .catch(() => fallback)
}

export function useVoice(): UseVoiceReturn {
  const [capability, setCapability] = useState<CapabilityState>({ status: 'checking' })
  const [voiceState, dispatch] = useReducer(voiceReducer, INITIAL_STATE)
  const [elapsedMs, setElapsedMs] = useState(0)
  const sessionRef = useRef<VadSession | null>(null)
  const runCounterRef = useRef(0)
  const phaseRef = useRef(voiceState.phase)
  phaseRef.current = voiceState.phase
  const maxUploadBytesRef = useRef(DEFAULT_MAX_UPLOAD_BYTES)
  const transcribeTimestampsRef = useRef<number[]>([])
  const retryAfterUntilRef = useRef(0)
  const formattingRunRef = useRef<number | null>(null)
  const stopRef = useRef<() => void>(() => {})
  const mountedRef = useRef(true)

  // Capability check on mount
  useEffect(() => {
    const browserCheck = checkBrowserCapability()
    if (!browserCheck.ok) {
      setCapability({ status: 'unavailable', reason: 'browser', message: browserCheck.message! })
      return
    }
    let cancelled = false
    fetch(`${API}/voice/status`)
      .then(res => res.json() as Promise<VoiceStatusResponse>)
      .then(data => {
        if (cancelled) return
        if (data.enabled) {
          maxUploadBytesRef.current = data.maxUploadBytes
          setCapability({ status: 'ready', maxUploadBytes: data.maxUploadBytes })
        } else {
          setCapability({ status: 'unavailable', reason: 'server', message: 'Voice input is unavailable. Server not configured.' })
        }
      })
      .catch(() => {
        if (cancelled) return
        setCapability({ status: 'unavailable', reason: 'server', message: 'Could not reach voice service.' })
      })
    return () => { cancelled = true }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionRef.current?.release()
    }
  }, [])

  const waitForTranscribeSlot = useCallback(async () => {
    while (true) {
      const now = Date.now()
      transcribeTimestampsRef.current = transcribeTimestampsRef.current.filter(t => now - t < REQUEST_WINDOW_MS)

      const retryWait = retryAfterUntilRef.current - now
      if (retryWait > 0) {
        await delay(retryWait)
        continue
      }

      if (transcribeTimestampsRef.current.length < MAX_TRANSCRIBE_REQUESTS_PER_WINDOW) {
        transcribeTimestampsRef.current.push(now)
        return
      }

      const oldest = transcribeTimestampsRef.current[0]
      await delay(Math.max(0, REQUEST_WINDOW_MS - (now - oldest) + 1))
    }
  }, [])

  const fetchWithTimeout = useCallback(async (
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }, [])

  const postTranscribe = useCallback(async (wav: Blob): Promise<string> => {
    const formData = new FormData()
    formData.append('audio', wav, 'chunk.wav')

    for (let attempt = 0; attempt < 2; attempt++) {
      await waitForTranscribeSlot()
      const res = await fetchWithTimeout(`${API}/voice/transcribe`, {
        method: 'POST',
        body: formData,
      }, TRANSCRIBE_TIMEOUT_MS)

      if (res.status === 429 && attempt === 0) {
        const waitMs = parseRetryAfterMs(res.headers.get('retry-after'))
        retryAfterUntilRef.current = Date.now() + waitMs
        await delay(waitMs)
        continue
      }

      if (!res.ok) {
        return ''
      }

      const data = await res.json() as TranscribeResponse
      return data.text ?? ''
    }

    return ''
  }, [fetchWithTimeout, waitForTranscribeSlot])

  const transcribeChunk = useCallback((wav: Blob, index: number, runId: number) => {
    dispatch({ type: 'SEGMENT_PENDING', index, runId })

    void postTranscribe(wav)
      .then(text => {
        dispatch({ type: 'SEGMENT_RESOLVED', index, text, runId })
      })
      .catch(() => {
        // A timeout or transient network failure drops only this chunk. If every
        // chunk drops, the reducer's finalization branch becomes FAIL.
        dispatch({ type: 'SEGMENT_RESOLVED', index, text: '', runId })
      })
  }, [postTranscribe])

  const formatTranscript = useCallback(async (text: string, target: VoiceTargetContext, runId: number) => {
    dispatch({ type: 'START_FORMAT' })
    try {
      const res = await fetchWithTimeout(`${API}/voice/format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, surface: target.surface, filePath: target.filePath }),
      }, FORMAT_TIMEOUT_MS)
      if (!res.ok) {
        const message = await getResponseMessage(res, `Server error (${res.status}).`)
        dispatch({ type: 'FAIL', message, runId })
        return
      }
      const data = await res.json() as FormatResponse
      const validStatuses: FormattingStatus[] = ['formatted', 'fallback_raw', 'empty']
      const formattingStatus: FormattingStatus = validStatuses.includes(data.formattingStatus as FormattingStatus)
        ? data.formattingStatus as FormattingStatus
        : 'fallback_raw'
      dispatch({
        type: 'COMPOSE_READY',
        runId,
        compose: {
          rawText: text,
          displayText: data.displayText,
          formattingStatus,
          warning: data.warning,
        },
      })
    } catch {
      dispatch({ type: 'FAIL', message: 'Network error. Check your connection.', runId })
    }
  }, [fetchWithTimeout])

  const start = useCallback((ctx: VoiceTargetContext) => {
    if (capability.status !== 'ready') return
    if (phaseRef.current.phase !== 'idle') return

    // Compute runId before dispatch (mirrors reducer: counter + 1)
    const runId = ++runCounterRef.current
    setElapsedMs(0)
    dispatch({ type: 'START', target: ctx })

    startVadSession(maxUploadBytesRef.current, {
      onElapsed: setElapsedMs,
      onChunk: (wav, index) => transcribeChunk(wav, index, runId),
      onError: (message) => dispatch({ type: 'FAIL', message, runId }),
    })
      .then(session => {
        setTimeout(() => {
          if (!mountedRef.current) {
            session.release()
            return
          }
          sessionRef.current = session
          dispatch({ type: 'PERMISSION_GRANTED', startedAt: Date.now(), runId })
        }, 0)
      })
      .catch(() => {
        const phase = phaseRef.current
        if (!mountedRef.current || phase.phase !== 'requesting_permission' || phase.runId !== runId) return
        dispatch({ type: 'PERMISSION_DENIED', message: 'Microphone permission denied.', runId })
      })
  }, [capability, transcribeChunk])

  const stop = useCallback(() => {
    const phase = phaseRef.current
    if (phase.phase !== 'active') return
    const session = sessionRef.current
    if (!session) return
    const runId = phase.runId

    dispatch({ type: 'STOP' })
    void (async () => {
      try {
        await session.stop()
        dispatch({ type: 'VAD_STOPPED', runId })
      } catch {
        dispatch({ type: 'FAIL', message: 'Could not stop voice capture.', runId })
      } finally {
        await session.release().catch(() => {})
        if (sessionRef.current === session) sessionRef.current = null
      }
    })()
  }, [])
  stopRef.current = stop

  useEffect(() => {
    const phase = voiceState.phase
    if (phase.phase !== 'active') {
      formattingRunRef.current = null
      return
    }

    const finalization = selectFinalization(phase)
    if (finalization.kind === 'pending') return
    if (finalization.kind === 'no_speech') {
      dispatch({ type: 'NO_SPEECH', message: 'No speech detected.', runId: phase.runId })
      return
    }
    if (finalization.kind === 'failed') {
      dispatch({ type: 'FAIL', message: 'Transcription failed. Try again.', runId: phase.runId })
      return
    }
    if (formattingRunRef.current === phase.runId) return
    formattingRunRef.current = phase.runId
    void formatTranscript(finalization.text, phase.target, phase.runId)
  }, [voiceState.phase, formatTranscript])

  useEffect(() => {
    const phase = voiceState.phase
    if (phase.phase !== 'active') return
    if (elapsedMs >= MAX_RECORDING_SECONDS * 1000) stopRef.current()
  }, [elapsedMs, voiceState.phase])

  const confirm = useCallback((_text: string) => { dispatch({ type: 'CONFIRM' }) }, [])
  const discard = useCallback(() => { dispatch({ type: 'DISCARD' }) }, [])
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    dispatch({ type: 'COPY' })
  }, [])
  const dismiss = useCallback(() => { dispatch({ type: 'DISMISS' }) }, [])
  const retry = useCallback(() => { dispatch({ type: 'DISMISS' }) }, [])
  const markTargetLost = useCallback(() => { dispatch({ type: 'TARGET_LOST' }) }, [])

  const { phase } = voiceState
  return {
    capability,
    state: selectInteractionState(phase),
    elapsedMs,
    liveTranscript: selectLiveTranscript(phase),
    pendingCount: selectPendingCount(phase),
    compose: selectCompose(phase),
    target: selectTarget(phase),
    errorMessage: selectErrorMessage(phase),
    noSpeechMessage: selectNotice(phase),
    start, stop, confirm, discard, copy, dismiss, retry, markTargetLost,
  }
}
