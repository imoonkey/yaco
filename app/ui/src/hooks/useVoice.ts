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

export type VoiceProvider = 'codex' | 'groq'

/** A finished take's text, ready to append to the compose draft. The tray
 *  appends whenever `key` changes (mirrors the editorInsert/terminalSend pattern). */
export interface AppendText {
  text: string
  key: number
}

/** Outcome of a /voice/format call. `ok` is true only when the formatter
 *  actually polished the text (server `formattingStatus: 'formatted'`); a
 *  timeout / server-fallback / network failure is `ok: false` with `text` left
 *  as the best available (the input, or the server's raw fallback). */
export interface FormatResult {
  text: string
  ok: boolean
}

export interface UseVoiceReturn {
  capability: CapabilityState
  availableProviders: VoiceProvider[]
  provider: VoiceProvider | null
  setProvider: (provider: VoiceProvider) => void
  formatterAvailable: boolean
  autoFormat: boolean
  setAutoFormat: (enabled: boolean) => void
  state: InteractionState
  elapsedMs: number
  appendText: AppendText | null
  target: VoiceTargetContext | null
  errorMessage: string | null
  notice: string | null
  /** Open the tray idle (type / paste) for a surface. */
  open: (ctx: VoiceTargetContext) => void
  /** Start a take. From idle requires `ctx`; from composing/error reuses the
   *  run's current target. Ignored while a take is already in flight. */
  record: (ctx?: VoiceTargetContext) => void
  /** Re-point the open run at another instance (the tray's target selector). */
  retarget: (ctx: VoiceTargetContext) => void
  /** End the current take → transcribe. */
  stop: () => void
  /** Re-send the cached take after a transcription failure. */
  retry: () => void
  /** Run the LLM formatter over arbitrary draft text (the Format button).
   *  Resolves the polished text + whether formatting actually succeeded. */
  format: (text: string) => Promise<FormatResult>
  confirm: (text: string) => void
  copy: (text: string) => void
  discard: () => void
  markTargetLost: () => void
}

type VoiceStatusResponse = {
  enabled: boolean
  providers: Record<VoiceProvider, { available: boolean }>
  formatter: { available: boolean }
  maxUploadBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseVoiceStatus(value: unknown): VoiceStatusResponse | null {
  if (!isRecord(value) || !isRecord(value.providers) || !isRecord(value.formatter)) return null
  const codex = value.providers.codex
  const groq = value.providers.groq
  if (
    typeof value.enabled !== 'boolean' ||
    !isRecord(codex) || typeof codex.available !== 'boolean' ||
    !isRecord(groq) || typeof groq.available !== 'boolean' ||
    typeof value.formatter.available !== 'boolean' ||
    typeof value.maxUploadBytes !== 'number' ||
    !Number.isFinite(value.maxUploadBytes) || value.maxUploadBytes <= 0
  ) return null
  return {
    enabled: value.enabled,
    providers: {
      codex: { available: codex.available },
      groq: { available: groq.available },
    },
    formatter: { available: value.formatter.available },
    maxUploadBytes: value.maxUploadBytes,
  }
}

const DEFAULT_MAX_UPLOAD_BYTES = 20_000_000
const TRANSCRIBE_TIMEOUT_MS = 60_000
const FORMAT_TIMEOUT_MS = 30_000
const PROVIDER_STORAGE_KEY = 'yaco.voiceProvider'
const AUTO_FORMAT_STORAGE_KEY = 'yaco.voiceAutoFormat'
const PROVIDER_ORDER: VoiceProvider[] = ['codex', 'groq']

function loadProvider(): VoiceProvider | null {
  try {
    const value = localStorage.getItem(PROVIDER_STORAGE_KEY)
    return value === 'codex' || value === 'groq' ? value : null
  } catch {
    return null
  }
}

function loadAutoFormat(): boolean {
  try {
    const value = localStorage.getItem(AUTO_FORMAT_STORAGE_KEY)
    return value === null || value === '1'
  } catch {
    return true
  }
}

function persistPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable in a restricted browser context; the live
    // compose-session preference remains valid even when it cannot persist.
  }
}

function preferencesLocked(phase: InteractionState): boolean {
  return phase === 'requesting_permission' || phase === 'recording' || phase === 'transcribing'
}

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
  const [availableProviders, setAvailableProviders] = useState<VoiceProvider[]>([])
  const [provider, setProviderState] = useState<VoiceProvider | null>(loadProvider)
  const [formatterAvailable, setFormatterAvailable] = useState(false)
  const [autoFormat, setAutoFormatState] = useState(loadAutoFormat)

  const sessionRef = useRef<CaptureSession | null>(null)
  const audioRef = useRef<Blob | null>(null) // cached take, kept for Retry until appended
  const runCounterRef = useRef(0)
  const phaseRef = useRef(voiceState.phase)
  useEffect(() => { phaseRef.current = voiceState.phase })
  const maxUploadBytesRef = useRef(DEFAULT_MAX_UPLOAD_BYTES)
  const stopRef = useRef<() => void>(() => {})
  const mountedRef = useRef(true)
  const providerRef = useRef(provider)
  const autoFormatRef = useRef(autoFormat)

  // Capability check on mount
  useEffect(() => {
    if (!checkBrowserCapability().ok) return
    let cancelled = false
    fetch(`${API}/voice/status`)
      .then(res => res.json() as Promise<unknown>)
      .then(value => {
        if (cancelled) return
        const data = parseVoiceStatus(value)
        if (!data) {
          setCapability({
            status: 'unavailable',
            reason: 'server',
            message: 'Voice service returned an invalid status.',
          })
          return
        }
        const providers = PROVIDER_ORDER.filter(provider => data.providers[provider].available)
        const selected = providerRef.current && providers.includes(providerRef.current)
          ? providerRef.current
          : providers[0] ?? null

        setAvailableProviders(providers)
        providerRef.current = selected
        setProviderState(selected)
        if (selected) persistPreference(PROVIDER_STORAGE_KEY, selected)
        setFormatterAvailable(data.formatter.available)
        if (!data.formatter.available) {
          autoFormatRef.current = false
          setAutoFormatState(false)
        }

        if (data.enabled && providers.length > 0) {
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
  const postTranscribe = useCallback(async (blob: Blob, provider: VoiceProvider): Promise<TranscribeResult> => {
    const formData = new FormData()
    formData.append('audio', blob, filenameForMime(blob.type))
    formData.append('provider', provider)

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

  // Whole transcript → polished text. Never throws: on any failure it returns
  // the best available text (server raw fallback, or the input) with ok:false so
  // callers can both keep the words AND report that formatting didn't run.
  const requestFormat = useCallback(async (text: string, target: VoiceTargetContext): Promise<FormatResult> => {
    try {
      const res = await fetchWithTimeout(`${API}/voice/format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, surface: target.surface, filePath: target.filePath }),
      }, FORMAT_TIMEOUT_MS)
      if (!res.ok) return { text, ok: false }
      const data = await res.json() as { displayText?: string; formattingStatus?: string }
      const out = (data.displayText ?? '').trim()
      if (!out) return { text, ok: false }
      return { text: out, ok: data.formattingStatus === 'formatted' }
    } catch {
      return { text, ok: false }
    }
  }, [fetchWithTimeout])

  // transcribe → (no-speech | fail | format → append). Shared by stop() and
  // retry(); guards every async hop on the run id and live phase.
  const processTake = useCallback(async (
    blob: Blob,
    runId: number,
    target: VoiceTargetContext,
    provider: VoiceProvider,
    shouldAutoFormat: boolean,
  ) => {
    const result = await postTranscribe(blob, provider)
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

    let output = text
    if (shouldAutoFormat) {
      const formatted = await requestFormat(text, target)
      if (!mountedRef.current) return
      if (phaseRef.current.phase !== 'transcribing' || phaseRef.current.runId !== runId) return
      output = formatted.text
    }
    audioRef.current = null
    dispatch({ type: 'TRANSCRIBED', runId })
    setAppendText({ text: output, key: runId })
  }, [postTranscribe, requestFormat])

  const setProvider = useCallback((nextProvider: VoiceProvider) => {
    if (preferencesLocked(selectInteractionState(phaseRef.current))) return
    if (!availableProviders.includes(nextProvider)) return
    providerRef.current = nextProvider
    setProviderState(nextProvider)
    persistPreference(PROVIDER_STORAGE_KEY, nextProvider)
  }, [availableProviders])

  const setAutoFormat = useCallback((enabled: boolean) => {
    if (preferencesLocked(selectInteractionState(phaseRef.current))) return
    if (enabled && !formatterAvailable) return
    autoFormatRef.current = enabled
    setAutoFormatState(enabled)
    persistPreference(AUTO_FORMAT_STORAGE_KEY, enabled ? '1' : '0')
  }, [formatterAvailable])

  const open = useCallback((ctx: VoiceTargetContext) => {
    if (phaseRef.current.phase !== 'idle') return
    dispatch({ type: 'OPEN', target: ctx })
  }, [])

  const retarget = useCallback((ctx: VoiceTargetContext) => {
    dispatch({ type: 'RETARGET', target: ctx })
  }, [])

  const record = useCallback((ctx?: VoiceTargetContext) => {
    if (capability.status !== 'ready') return
    const phase = phaseRef.current
    const target = phase.phase === 'idle'
      ? ctx
      : (phase.phase === 'composing' || phase.phase === 'error') ? phase.target : undefined
    if (!target) return // a take is already in flight, or no target to record into

    const selectedProvider = providerRef.current
    if (!selectedProvider) return

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
    const selectedProvider = providerRef.current
    if (!selectedProvider) return
    const shouldAutoFormat = autoFormatRef.current

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
      await processTake(
        blob,
        runId,
        target,
        selectedProvider,
        shouldAutoFormat,
      )
    })()
  }, [processTake])
  useEffect(() => { stopRef.current = stop })

  const retry = useCallback(() => {
    const phase = phaseRef.current
    if (phase.phase !== 'error') return
    const blob = audioRef.current
    if (!blob) { dispatch({ type: 'DISCARD' }); return }
    const selectedProvider = providerRef.current
    if (!selectedProvider || !availableProviders.includes(selectedProvider)) return
    const runId = ++runCounterRef.current
    dispatch({ type: 'RETRY', runId })
    void processTake(
      blob,
      runId,
      phase.target,
      selectedProvider,
      autoFormatRef.current,
    )
  }, [availableProviders, processTake])

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
  // frozen target for surface/file context.
  const format = useCallback(async (text: string): Promise<FormatResult> => {
    const p = phaseRef.current
    const target = 'target' in p ? p.target : null
    if (!formatterAvailable || !target || !text.trim()) return { text, ok: false }
    return requestFormat(text, target)
  }, [formatterAvailable, requestFormat])

  const { phase } = voiceState
  return {
    capability,
    availableProviders,
    provider,
    setProvider,
    formatterAvailable,
    autoFormat,
    setAutoFormat,
    state: selectInteractionState(phase),
    elapsedMs,
    appendText,
    target: selectTarget(phase),
    errorMessage: selectErrorMessage(phase),
    notice: selectNotice(phase),
    open, record, retarget, stop, retry, format, confirm, copy, discard, markTargetLost,
  }
}
