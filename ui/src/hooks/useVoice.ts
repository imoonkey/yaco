import { useReducer, useEffect, useRef, useCallback, useState } from 'react'
import { API } from './useApi'
import {
  voiceReducer, INITIAL_STATE,
  selectInteractionState, selectCompose, selectTarget, selectErrorMessage, selectNotice,
  type FormattingStatus, type VoiceTargetContext, type InteractionState, type ComposeData,
} from './voiceStateMachine'
import { checkBrowserCapability, startRecordingSession, type RecordingSession } from './voiceRecording'

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

interface ComposeResponse {
  rawText: string
  displayText: string
  formattingStatus: string
  warning?: string
}

type VoiceStatusResponse =
  | { enabled: true; sttModel: string; formatterModel: string; maxUploadBytes: number }
  | { enabled: false; reason: string }

export function useVoice(): UseVoiceReturn {
  const [capability, setCapability] = useState<CapabilityState>({ status: 'checking' })
  const [voiceState, dispatch] = useReducer(voiceReducer, INITIAL_STATE)
  const [elapsedMs, setElapsedMs] = useState(0)
  const sessionRef = useRef<RecordingSession | null>(null)
  const runCounterRef = useRef(0)
  const phaseRef = useRef(voiceState.phase)
  phaseRef.current = voiceState.phase
  const maxUploadBytesRef = useRef(20_000_000)

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
  useEffect(() => () => { sessionRef.current?.release() }, [])

  // Submit audio to server
  const submitAudio = useCallback(async (blob: Blob, ctx: VoiceTargetContext, runId: number) => {
    dispatch({ type: 'STOP' })
    const formData = new FormData()
    formData.append('audio', blob, 'audio.webm')
    formData.append('surface', ctx.surface)
    if (ctx.filePath) formData.append('filePath', ctx.filePath)

    try {
      const res = await fetch(`${API}/voice/compose`, { method: 'POST', body: formData })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed.' })) as { error?: string; message?: string }
        dispatch({ type: 'FAIL', message: body.error || body.message || `Server error (${res.status}).`, runId })
        return
      }
      const data = await res.json() as ComposeResponse
      if (data.formattingStatus === 'empty') {
        dispatch({ type: 'NO_SPEECH', message: 'No speech detected.', runId })
        return
      }
      const validStatuses: FormattingStatus[] = ['formatted', 'fallback_raw', 'empty']
      const fmtStatus: FormattingStatus = validStatuses.includes(data.formattingStatus as FormattingStatus)
        ? data.formattingStatus as FormattingStatus
        : 'fallback_raw'
      dispatch({
        type: 'COMPOSE_READY', runId,
        compose: { rawText: data.rawText, displayText: data.displayText, formattingStatus: fmtStatus, warning: data.warning },
      })
    } catch {
      if (phaseRef.current.phase === 'idle') return
      dispatch({ type: 'FAIL', message: 'Network error. Check your connection.', runId })
    }
  }, [])

  const start = useCallback((ctx: VoiceTargetContext) => {
    if (capability.status !== 'ready') return
    if (phaseRef.current.phase !== 'idle') return

    // Compute runId before dispatch (mirrors reducer: counter + 1)
    const runId = ++runCounterRef.current
    setElapsedMs(0)
    dispatch({ type: 'START', target: ctx })

    startRecordingSession(maxUploadBytesRef.current, {
      onElapsed: setElapsedMs,
      onStopped: (blob) => submitAudio(blob, ctx, runId),
      onTooShort: () => dispatch({ type: 'TOO_SHORT' }),
      onByteLimit: () => { /* stop already called by recording module */ },
      onError: (message) => dispatch({ type: 'FAIL', message, runId }),
    })
      .then(session => {
        if (phaseRef.current.phase !== 'requesting_permission') { session.release(); return }
        sessionRef.current = session
        dispatch({ type: 'PERMISSION_GRANTED', startedAt: Date.now() })
      })
      .catch(() => {
        if (phaseRef.current.phase !== 'requesting_permission') return
        dispatch({ type: 'PERMISSION_DENIED', message: 'Microphone permission denied.' })
      })
  }, [capability, submitAudio])

  const stop = useCallback(() => { sessionRef.current?.stop(); sessionRef.current = null }, [])
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
    compose: selectCompose(phase),
    target: selectTarget(phase),
    errorMessage: selectErrorMessage(phase),
    noSpeechMessage: selectNotice(phase),
    start, stop, confirm, discard, copy, dismiss, retry, markTargetLost,
  }
}
