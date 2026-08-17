import { isRecord } from './json.js'

export type SessionDescription = {
  readonly status: 'active' | 'closed'
  readonly providerMode: 'buffered' | 'streaming_sse'
  readonly transcriptDeliveryMode: 'final_only' | 'segment' | 'delta'
}

export type UpstreamEvent =
  | { readonly type: 'session.started'; readonly session: SessionDescription }
  | { readonly type: 'session.updated'; readonly session: SessionDescription }
  | {
      readonly type: 'speech.started' | 'speech.stopped'
      readonly utteranceId: string
    }
  | {
      readonly type: 'transcript.delta' | 'transcript.segment' | 'transcript.final'
      readonly utteranceId: string
      readonly text: string
    }
  | { readonly type: 'transcript.failed' }
  | { readonly type: 'session.error'; readonly fatal: boolean }

export function parseUpstreamEvent(raw: string): UpstreamEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isSequenceNumber(value.sequence_no)) return undefined

  if (value.type === 'session.started' || value.type === 'session.updated') {
    const session = parseSession(value.session)
    return session === undefined ? undefined : { type: value.type, session }
  }
  if (value.type === 'speech.started' || value.type === 'speech.stopped') {
    const utteranceId = wireString(value.utterance_id)
    return utteranceId === undefined
      ? undefined
      : { type: value.type, utteranceId }
  }
  if (
    value.type === 'transcript.delta' ||
    value.type === 'transcript.segment' ||
    value.type === 'transcript.final'
  ) {
    const utteranceId = wireString(value.utterance_id)
    if (
      utteranceId === undefined ||
      !isSequenceNumber(value.revision) ||
      typeof value.text !== 'string'
    ) {
      return undefined
    }
    return { type: value.type, utteranceId, text: value.text }
  }
  if (value.type === 'transcript.failed') {
    const validUtterance =
      value.utterance_id === undefined ||
      value.utterance_id === null ||
      wireString(value.utterance_id) !== undefined
    return validUtterance && isUpstreamError(value.error)
      ? { type: value.type }
      : undefined
  }
  if (value.type === 'session.error') {
    return typeof value.fatal === 'boolean' && isUpstreamError(value.error)
      ? { type: value.type, fatal: value.fatal }
      : undefined
  }
  return undefined
}

export function isRequestedMode(session: SessionDescription): boolean {
  return (
    session.providerMode === 'streaming_sse' &&
    session.transcriptDeliveryMode === 'final_only'
  )
}

function parseSession(value: unknown): SessionDescription | undefined {
  if (
    !isRecord(value) ||
    wireString(value.session_id) === undefined ||
    (value.status !== 'active' && value.status !== 'closed') ||
    !isRecord(value.config)
  ) {
    return undefined
  }
  const providerMode = value.config.provider_mode
  const transcriptDeliveryMode = value.config.transcript_delivery_mode
  if (
    (providerMode !== 'buffered' && providerMode !== 'streaming_sse') ||
    (transcriptDeliveryMode !== 'final_only' &&
      transcriptDeliveryMode !== 'segment' &&
      transcriptDeliveryMode !== 'delta')
  ) {
    return undefined
  }
  return { status: value.status, providerMode, transcriptDeliveryMode }
}

function isUpstreamError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  )
}

function isSequenceNumber(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0
}

function wireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
