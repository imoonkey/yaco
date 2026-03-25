import { useState, useEffect, useRef, useCallback } from 'react'
import { API } from './useApi'

// --- Constants ---

const MIN_RECORDING_MS = 500
const MAX_RECORDING_SECONDS = 300
const ELAPSED_INTERVAL_MS = 1000

const MIME_PRIORITY = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

// --- Types ---

export type VoiceSurface = 'editor' | 'terminal'

export type CapabilityState =
  | { status: 'checking' }
  | { status: 'ready'; maxUploadBytes: number }
  | { status: 'unavailable'; reason: 'browser' | 'server'; message: string }

export type InteractionState =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'transcribing'
  | 'formatting'
  | 'composing'
  | 'recoverable'
  | 'error'

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

export interface UseVoiceReturn {
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
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

// --- Helpers ---

function selectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of MIME_PRIORITY) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return null
}

function checkBrowserCapability(): { ok: boolean; message?: string } {
  if (typeof window === 'undefined') {
    return { ok: false, message: 'No browser environment.' }
  }
  if (!window.isSecureContext) {
    return { ok: false, message: 'Secure context required (HTTPS or localhost).' }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, message: 'Browser does not support audio capture.' }
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, message: 'Browser does not support MediaRecorder.' }
  }
  if (!selectMimeType()) {
    return { ok: false, message: 'No supported audio format found.' }
  }
  return { ok: true }
}

interface VoiceStatusEnabled {
  enabled: true
  sttModel: string
  formatterModel: string
  maxUploadBytes: number
}

interface VoiceStatusDisabled {
  enabled: false
  reason: string
}

type VoiceStatusResponse = VoiceStatusEnabled | VoiceStatusDisabled

interface ComposeResponse {
  rawText: string
  displayText: string
  formattingStatus: string
  warning?: string
}

// --- Hook ---

export function useVoice(): UseVoiceReturn {
  const [capability, setCapability] = useState<CapabilityState>({ status: 'checking' })
  const [state, setState] = useState<InteractionState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [compose, setCompose] = useState<ComposeData | null>(null)
  const [target, setTarget] = useState<VoiceTargetContext | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noSpeechMessage, setNoSpeechMessage] = useState<string | null>(null)

  // Refs for recording resources — cleaned up on stop/unmount
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const bytesRef = useRef(0)
  const startTimeRef = useRef(0)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<InteractionState>('idle')
  const maxUploadBytesRef = useRef(20_000_000)
  // Track the target context that was active when recording started
  const pendingTargetRef = useRef<VoiceTargetContext | null>(null)

  // Keep stateRef in sync
  stateRef.current = state

  // --- Capability check on mount ---
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
          setCapability({
            status: 'unavailable',
            reason: 'server',
            message: 'Voice input is unavailable. Server not configured.',
          })
        }
      })
      .catch(() => {
        if (cancelled) return
        setCapability({
          status: 'unavailable',
          reason: 'server',
          message: 'Could not reach voice service.',
        })
      })

    return () => { cancelled = true }
  }, [])

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      releaseRecording()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function releaseRecording() {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    chunksRef.current = []
    bytesRef.current = 0
  }

  // --- Submit audio to server ---
  const submitAudio = useCallback(async (blob: Blob, ctx: VoiceTargetContext) => {
    // Guard: if state has moved to idle (e.g. unmount), discard late response
    if (stateRef.current !== 'transcribing' && stateRef.current !== 'recording') return

    setState('transcribing')

    const formData = new FormData()
    formData.append('audio', blob, 'audio.webm')
    formData.append('surface', ctx.surface)
    if (ctx.filePath) formData.append('filePath', ctx.filePath)
    // Language hint from browser
    const lang = navigator.language?.split('-')[0]
    if (lang) formData.append('language', lang)

    try {
      const res = await fetch(`${API}/voice/compose`, { method: 'POST', body: formData })

      // Late response guard
      if (stateRef.current !== 'transcribing') return

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Request failed.' })) as { message?: string }
        setState('error')
        setErrorMessage(body.message || `Server error (${res.status}).`)
        return
      }

      setState('formatting')

      const data = await res.json() as ComposeResponse

      // Late response guard
      if (stateRef.current !== 'formatting') return

      if (data.formattingStatus === 'empty') {
        setState('idle')
        setNoSpeechMessage('No speech detected.')
        return
      }

      setCompose({
        rawText: data.rawText,
        displayText: data.displayText,
        formattingStatus: data.formattingStatus as FormattingStatus,
        warning: data.warning,
      })
      setTarget(ctx)
      setState('composing')
    } catch {
      if (stateRef.current === 'idle') return // unmounted
      setState('error')
      setErrorMessage('Network error. Check your connection.')
    }
  }, [])

  // --- Actions ---

  const start = useCallback((ctx: VoiceTargetContext) => {
    if (capability.status !== 'ready') return
    if (stateRef.current !== 'idle') return

    setNoSpeechMessage(null)
    setErrorMessage(null)
    setCompose(null)
    setTarget(null)
    pendingTargetRef.current = ctx
    setState('requesting_permission')

    navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
      .then(stream => {
        // Guard: user may have navigated away
        if (stateRef.current !== 'requesting_permission') {
          stream.getTracks().forEach(t => t.stop())
          return
        }

        streamRef.current = stream
        chunksRef.current = []
        bytesRef.current = 0
        startTimeRef.current = Date.now()
        setElapsedMs(0)

        const mimeType = selectMimeType()!
        const recorder = new MediaRecorder(stream, { mimeType })
        mediaRecorderRef.current = recorder

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data)
            bytesRef.current += e.data.size

            // Client-side byte guard
            if (bytesRef.current > maxUploadBytesRef.current) {
              stopRecordingAndSubmit()
            }
          }
        }

        recorder.onstop = () => {
          // Handled by stopRecordingAndSubmit — no-op here
        }

        recorder.start(1000) // 1s chunks
        setState('recording')

        // Elapsed timer
        elapsedTimerRef.current = setInterval(() => {
          setElapsedMs(Date.now() - startTimeRef.current)
        }, ELAPSED_INTERVAL_MS)

        // Max duration auto-stop
        maxTimerRef.current = setTimeout(() => {
          stopRecordingAndSubmit()
        }, MAX_RECORDING_SECONDS * 1000)
      })
      .catch(() => {
        if (stateRef.current !== 'requesting_permission') return
        setState('error')
        setErrorMessage('Microphone permission denied.')
      })
  }, [capability])

  function stopRecordingAndSubmit() {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    const duration = Date.now() - startTimeRef.current
    const ctx = pendingTargetRef.current

    // Clear timers
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }

    // Request final data chunk then build blob
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data)
        bytesRef.current += e.data.size
      }
    }

    recorder.onstop = () => {
      // Release media tracks
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      mediaRecorderRef.current = null

      // Min duration check
      if (duration < MIN_RECORDING_MS) {
        setState('idle')
        chunksRef.current = []
        bytesRef.current = 0
        return
      }

      if (!ctx) {
        setState('idle')
        return
      }

      const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
      chunksRef.current = []
      bytesRef.current = 0

      submitAudio(blob, ctx)
    }

    recorder.stop()
  }

  const stop = useCallback(() => {
    if (stateRef.current !== 'recording') return
    stopRecordingAndSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = useCallback((text: string) => {
    if (stateRef.current !== 'composing') return
    // Caller is responsible for checking target validity and dispatching the text.
    // If target is invalid, caller should call markTargetLost instead.
    void text // consumed by the calling surface component
    setCompose(null)
    setTarget(null)
    setState('idle')
  }, [])

  const discard = useCallback(() => {
    if (stateRef.current !== 'composing' && stateRef.current !== 'recoverable') return
    setCompose(null)
    setTarget(null)
    setState('idle')
  }, [])

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    if (stateRef.current === 'recoverable') {
      setCompose(null)
      setTarget(null)
      setState('idle')
    }
  }, [])

  const dismiss = useCallback(() => {
    if (stateRef.current !== 'error') return
    setErrorMessage(null)
    setState('idle')
  }, [])

  const retry = useCallback(() => {
    if (stateRef.current !== 'error') return
    setErrorMessage(null)
    setState('idle')
  }, [])

  const markTargetLost = useCallback(() => {
    if (stateRef.current !== 'composing') return
    setState('recoverable')
  }, [])

  return {
    capability,
    state,
    elapsedMs,
    compose,
    target,
    errorMessage,
    noSpeechMessage,

    start,
    stop,
    confirm,
    discard,
    copy,
    dismiss,
    retry,
    markTargetLost,
  }
}
