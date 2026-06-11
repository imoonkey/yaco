import { useReducer, useEffect, useRef, useCallback, useState } from 'react'
import { API } from './useApi'
import { writeTextToClipboard } from '../lib/clipboard'
import {
  voiceReducer, INITIAL_STATE,
  selectInteractionState, selectTarget, selectErrorMessage, selectNotice,
  type VoiceTargetContext, type InteractionState,
} from './voiceStateMachine'
import {
  checkBrowserCapability, startCaptureSession, filenameForMime,
  MAX_RECORDING_SECONDS, type CaptureSession,
} from './voiceCapture'

// Re-export shared types so consumers keep importing from './useVoice'
export type { VoiceSurface, VoiceTargetContext, InteractionState } from './voiceStateMachine'

export type CapabilityState =
  | { status: 'checking' }
  | { status: 'ready'; maxUploadBytes: number }
  | { status: 'unavailable'; reason: 'browser' | 'server'; message: string }

/** A finished take's text, ready to append to the compose draft. The tray
 *  appends whenever `key` changes (mirrors the editorInsert/terminalSend pattern). */
export interface AppendText {
  text: string
  key: number
}

export interface UseVoiceReturn {
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  appendText: AppendText | null
  target: VoiceTargetContext | null
  errorMessage: string | null
  notice: string | null
  /** Open the tray idle (type / paste) for a surface. */
  open: (ctx: VoiceTargetContext) => void
  /** Start a take. From idle requires `ctx`; from composing/error reuses the
   *  frozen target. Ignored while a take is already in flight. */
  record: (ctx?: VoiceTargetContext) => void
  /** End the current take → transcribe. */
  stop: () => void
  /** Re-send the cached take after a transcription failure. */
  retry: () => void
  /** Run the LLM formatter over arbitrary draft text (the Format button).
   *  Returns the polished text, or the input unchanged if formatting failed. */
  format: (text: string) => Promise<string>
  confirm: (text: string) => void
  copy: (text: string) => void
  discard: () => void
  markTargetLost: () => void
}

type VoiceStatusResponse =
  | { enabled: true; sttModel: string; maxUploadBytes: number }
  | { enabled: false; reason: string }

const DEFAULT_MAX_UPLOAD_BYTES = 20_000_000
const TRANSCRIBE_TIMEOUT_MS = 60_000
const FORMAT_TIMEOUT_MS = 30_000

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

type TranscribeResult = { ok: true; text: string } | { ok: false }

export function useVoice(): UseVoiceReturn {
  const [capability, setCapability] = useState<CapabilityState>(() => {
    const browserCheck = checkBrowserCapability()
    return browserCheck.ok
      ? { status: 'checking' }
      : { status: 'unavailable', reason: 'browser', message: browserCheck.message! }
  })
  const [voiceState, dispatch] = useReducer(voiceReducer, INITIAL_STATE)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [appendText, setAppendText] = useState<AppendText | null>(null)

  const sessionRef = useRef<CaptureSession | null>(null)
  const audioRef = useRef<Blob | null>(null) // cached take, kept for Retry until appended
  const runCounterRef = useRef(0)
  const phaseRef = useRef(voiceState.phase)
  useEffect(() => { phaseRef.current = voiceState.phase })
  const maxUploadBytesRef = useRef(DEFAULT_MAX_UPLOAD_BYTES)
  const stopRef = useRef<() => void>(() => {})
  const mountedRef = useRef(true)

  // Capability check on mount
  useEffect(() => {
    if (!checkBrowserCapability().ok) return
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

  // One whole-take blob → raw transcript. ok:false means a transient failure
  // (network / timeout / 5xx) the caller can Retry from the cached blob; ok with
  // empty text means the recording held no speech.
  const postTranscribe = useCallback(async (blob: Blob): Promise<TranscribeResult> => {
    const formData = new FormData()
    formData.append('audio', blob, filenameForMime(blob.type))

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(`${API}/voice/transcribe`, {
          method: 'POST',
          body: formData,
        }, TRANSCRIBE_TIMEOUT_MS)

        if (res.status === 429 && attempt === 0) {
          await delay(parseRetryAfterMs(res.headers.get('retry-after')))
          continue
        }
        if (!res.ok) return { ok: false }
        const data = await res.json() as { text?: string }
        return { ok: true, text: data.text ?? '' }
      } catch {
        return { ok: false }
      }
    }
    return { ok: false }
  }, [fetchWithTimeout])

  // Whole transcript → polished text. Never throws: a failed /format falls back
  // to the raw transcript so the user's words are never lost.
  const formatTranscript = useCallback(async (text: string, target: VoiceTargetContext): Promise<string> => {
    try {
      const res = await fetchWithTimeout(`${API}/voice/format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, surface: target.surface, filePath: target.filePath }),
      }, FORMAT_TIMEOUT_MS)
      if (!res.ok) return text
      const data = await res.json() as { displayText?: string }
      const out = (data.displayText ?? '').trim()
      return out || text
    } catch {
      return text
    }
  }, [fetchWithTimeout])

  // transcribe → (no-speech | fail | format → append). Shared by stop() and
  // retry(); guards every async hop on the run id and live phase.
  const processTake = useCallback(async (blob: Blob, runId: number, target: VoiceTargetContext) => {
    const result = await postTranscribe(blob)
    if (!mountedRef.current) return
    if (phaseRef.current.phase !== 'transcribing' || phaseRef.current.runId !== runId) return

    if (!result.ok) {
      dispatch({ type: 'FAIL', message: 'Transcription failed. Try again.', runId })
      return
    }
    const text = result.text.trim()
    if (text === '') {
      audioRef.current = null
      dispatch({ type: 'NO_SPEECH', message: 'No speech detected.', runId })
      return
    }

    const displayText = await formatTranscript(text, target)
    if (!mountedRef.current) return
    if (phaseRef.current.phase !== 'transcribing' || phaseRef.current.runId !== runId) return
    audioRef.current = null
    dispatch({ type: 'TRANSCRIBED', runId })
    setAppendText({ text: displayText, key: runId })
  }, [postTranscribe, formatTranscript])

  const open = useCallback((ctx: VoiceTargetContext) => {
    if (phaseRef.current.phase !== 'idle') return
    dispatch({ type: 'OPEN', target: ctx })
  }, [])

  const record = useCallback((ctx?: VoiceTargetContext) => {
    if (capability.status !== 'ready') return
    const phase = phaseRef.current
    const target = phase.phase === 'idle'
      ? ctx
      : (phase.phase === 'composing' || phase.phase === 'error') ? phase.target : undefined
    if (!target) return // a take is already in flight, or no target to record into

    const runId = ++runCounterRef.current
    setElapsedMs(0)
    dispatch({ type: 'START_RECORD', target, runId })

    startCaptureSession({
      onElapsed: setElapsedMs,
      // The capture session self-releases the mic on a recorder error (see
      // voiceCapture). The hook only surfaces it — and must NOT touch sessionRef,
      // which a late stale-run error could otherwise steal from a newer take. The
      // reducer drops the FAIL if this run is no longer current.
      onError: (message) => dispatch({ type: 'FAIL', message, runId }),
    })
      .then(session => {
        setTimeout(() => {
          const p = phaseRef.current
          if (!mountedRef.current || p.phase !== 'requesting_permission' || p.runId !== runId) {
            session.release()
            return
          }
          sessionRef.current = session
          dispatch({ type: 'PERMISSION_GRANTED', startedAt: Date.now(), runId })
        }, 0)
      })
      .catch(() => {
        const p = phaseRef.current
        if (!mountedRef.current || p.phase !== 'requesting_permission' || p.runId !== runId) return
        dispatch({ type: 'PERMISSION_DENIED', message: 'Microphone permission denied.', runId })
      })
  }, [capability])

  const stop = useCallback(() => {
    const phase = phaseRef.current
    if (phase.phase !== 'recording') return
    const session = sessionRef.current
    const runId = phase.runId
    const target = phase.target

    dispatch({ type: 'STOP', runId })
    void (async () => {
      let blob: Blob | null = null
      try {
        blob = session ? await session.stop() : null
      } catch {
        blob = null
      } finally {
        await session?.release().catch(() => {})
        if (sessionRef.current === session) sessionRef.current = null
      }
      if (!mountedRef.current) return
      if (phaseRef.current.phase !== 'transcribing' || phaseRef.current.runId !== runId) return

      if (!blob || blob.size === 0) {
        audioRef.current = null
        dispatch({ type: 'NO_SPEECH', message: 'No speech detected.', runId })
        return
      }
      if (blob.size > maxUploadBytesRef.current) {
        audioRef.current = null
        dispatch({ type: 'FAIL', message: 'Recording too long. Keep it shorter.', runId })
        return
      }
      audioRef.current = blob
      await processTake(blob, runId, target)
    })()
  }, [processTake])
  useEffect(() => { stopRef.current = stop })

  const retry = useCallback(() => {
    const phase = phaseRef.current
    if (phase.phase !== 'error') return
    const blob = audioRef.current
    if (!blob) { dispatch({ type: 'DISCARD' }); return }
    const runId = ++runCounterRef.current
    dispatch({ type: 'RETRY', runId })
    void processTake(blob, runId, phase.target)
  }, [processTake])

  // Enforce the session cap by ending the take (the only finalizing path).
  useEffect(() => {
    if (voiceState.phase.phase !== 'recording') return
    if (elapsedMs >= MAX_RECORDING_SECONDS * 1000) stopRef.current()
  }, [elapsedMs, voiceState.phase])

  const confirm = useCallback((_text: string) => { dispatch({ type: 'CONFIRM' }) }, [])
  const copy = useCallback((text: string) => {
    void writeTextToClipboard(text)
    dispatch({ type: 'COPY' })
  }, [])
  const discard = useCallback(() => {
    const session = sessionRef.current
    if (session) { void session.release().catch(() => {}); sessionRef.current = null }
    audioRef.current = null
    dispatch({ type: 'DISCARD' })
  }, [])
  const markTargetLost = useCallback(() => { dispatch({ type: 'TARGET_LOST' }) }, [])

  // Format arbitrary draft text (the tray's Format button) using the run's
  // frozen target for surface/file context. Returns the input unchanged on
  // failure (formatTranscript's raw fallback), so the caller can no-op safely.
  const format = useCallback(async (text: string): Promise<string> => {
    const p = phaseRef.current
    const target = 'target' in p ? p.target : null
    if (!target || !text.trim()) return text
    return formatTranscript(text, target)
  }, [formatTranscript])

  const { phase } = voiceState
  return {
    capability,
    state: selectInteractionState(phase),
    elapsedMs,
    appendText,
    target: selectTarget(phase),
    errorMessage: selectErrorMessage(phase),
    notice: selectNotice(phase),
    open, record, stop, retry, format, confirm, copy, discard, markTargetLost,
  }
}
