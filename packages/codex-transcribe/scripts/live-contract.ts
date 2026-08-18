import { extname } from 'node:path'
import {
  CodexTranscribeError,
  type CodexDictationSession,
  type CodexDictationSessionInput,
  type CodexTranscribeErrorCode,
  type CodexTranscribeInput,
  type CodexTranscribeStatus,
} from '../src/index.ts'

export const LIVE_SAMPLE_RATE_HZ = 48_000
export const LIVE_MAX_PCM_BYTES = LIVE_SAMPLE_RATE_HZ * 2 * 30

const LIVE_FRAME_SAMPLES = 1_024
const MAX_ENCODED_BYTES = 20_000_000
const REQUEST_TIMEOUT_MS = 60_000
const NON_TRANSIENT_STREAM_STATUSES = new Set<LiveStatus>([
  'error:not_configured',
  'error:expired_auth',
  'error:forbidden',
])

export type LiveEnvironment = {
  readonly CODEX_TRANSCRIBE_LIVE?: string
  readonly CODEX_TRANSCRIBE_FIXTURE?: string
  readonly CODEX_TRANSCRIBE_ATTEMPTS?: string
}

type UnavailableReason = Exclude<CodexTranscribeStatus, { available: true }>['reason']
type LiveStatus =
  | 'disabled'
  | 'error:input'
  | 'ok'
  | 'error:empty'
  | 'error:unexpected'
  | `unavailable:${UnavailableReason}`
  | `error:${CodexTranscribeErrorCode}`
type LiveMode = 'none' | 'batch' | 'stream'
type TranscriptComparison = 'not_applicable' | 'match' | 'different'

type LiveEvent = {
  readonly mode: LiveMode
  readonly status: LiveStatus
  readonly attempt: number
  readonly stopToRawMs: number
  readonly transcriptComparison: TranscriptComparison
}

export type LiveDependencies = {
  readonly inspect: () => Promise<CodexTranscribeStatus>
  readonly readAudio: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  readonly decodePcm16: (
    path: string,
    sampleRateHz: number,
    maxBytes: number,
  ) => Promise<Uint8Array<ArrayBuffer>>
  readonly openStream: (input: CodexDictationSessionInput) => Promise<CodexDictationSession>
  readonly transcribe: (input: CodexTranscribeInput) => Promise<string>
  readonly now: () => number
  readonly wait: (milliseconds: number) => Promise<void>
  readonly timeout: (milliseconds: number) => AbortSignal
  readonly emit: (line: string) => void
}

export function mimeTypeForPath(path: string): 'audio/webm' | 'audio/mp4' {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case '.webm':
      return 'audio/webm'
    case '.mp4':
    case '.m4a':
      return 'audio/mp4'
    default:
      throw new Error('unsupported audio type')
  }
}

export function parseAttemptCount(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 5
  if (!/^\d+$/.test(raw)) throw new Error('invalid attempt count')
  const attempts = Number(raw)
  if (attempts < 5 || attempts > 20) throw new Error('invalid attempt count')
  return attempts
}

export function parseFixturePath(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0 || raw.includes('\0')) {
    throw new Error('invalid fixture')
  }
  return raw.trim()
}

export function formatLiveEvent(
  event: LiveEvent & { readonly [key: string]: unknown },
): string {
  return JSON.stringify({
    mode: event.mode,
    status: event.status,
    attempt: event.attempt,
    stopToRawMs: event.stopToRawMs,
    transcriptComparison: event.transcriptComparison,
  })
}

export function statusForError(error: unknown): LiveStatus {
  return error instanceof CodexTranscribeError
    ? `error:${error.code}`
    : 'error:unexpected'
}

function emit(dependencies: LiveDependencies, event: LiveEvent): void {
  dependencies.emit(formatLiveEvent(event))
}

function terminalEvent(
  status: LiveStatus,
  mode: LiveMode = 'none',
  attempt = 0,
  stopToRawMs = 0,
): LiveEvent {
  return {
    mode,
    status,
    attempt,
    stopToRawMs,
    transcriptComparison: 'not_applicable',
  }
}

export async function runLive(
  environment: LiveEnvironment,
  dependencies: LiveDependencies,
): Promise<number> {
  if (environment.CODEX_TRANSCRIBE_LIVE !== '1') {
    emit(dependencies, terminalEvent('disabled'))
    return 2
  }

  let path: string
  let attempts: number
  let mimeType: 'audio/webm' | 'audio/mp4'
  try {
    path = parseFixturePath(environment.CODEX_TRANSCRIBE_FIXTURE)
    attempts = parseAttemptCount(environment.CODEX_TRANSCRIBE_ATTEMPTS)
    mimeType = mimeTypeForPath(path)
  } catch {
    emit(dependencies, terminalEvent('error:input'))
    return 2
  }

  const availability = await dependencies.inspect()
  if (!availability.available) {
    emit(dependencies, terminalEvent(`unavailable:${availability.reason}`))
    return 1
  }

  let audio: Uint8Array<ArrayBuffer>
  let pcm: Uint8Array<ArrayBuffer>
  try {
    [audio, pcm] = await Promise.all([
      dependencies.readAudio(path),
      dependencies.decodePcm16(path, LIVE_SAMPLE_RATE_HZ, LIVE_MAX_PCM_BYTES),
    ])
    if (
      audio.byteLength === 0 || audio.byteLength > MAX_ENCODED_BYTES ||
      pcm.byteLength === 0 || pcm.byteLength % 2 !== 0 || pcm.byteLength > LIVE_MAX_PCM_BYTES
    ) {
      throw new Error('invalid fixture')
    }
  } catch {
    emit(dependencies, terminalEvent('error:input'))
    return 2
  }

  const filename = mimeType === 'audio/webm' ? 'fixture.webm' : 'fixture.mp4'
  let streamDisabled = false
  let streamFailed = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const batchStartedAt = dependencies.now()
    let batchTranscript: string
    try {
      batchTranscript = await dependencies.transcribe({
        audio,
        filename,
        mimeType,
        signal: dependencies.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      emit(dependencies, terminalEvent(
        statusForError(error),
        'batch',
        attempt,
        Math.round(dependencies.now() - batchStartedAt),
      ))
      return 1
    }
    const batchLatencyMs = Math.round(dependencies.now() - batchStartedAt)
    if (batchTranscript.trim().length === 0) {
      emit(dependencies, terminalEvent('error:empty', 'batch', attempt, batchLatencyMs))
      return 1
    }
    emit(dependencies, {
      mode: 'batch',
      status: 'ok',
      attempt,
      stopToRawMs: batchLatencyMs,
      transcriptComparison: 'not_applicable',
    })

    if (streamDisabled) continue

    const streamResult = await runStreamingAttempt(pcm, dependencies)
    if (!streamResult.ok) {
      streamFailed = true
      emit(dependencies, terminalEvent(
        streamResult.status,
        'stream',
        attempt,
        streamResult.stopToRawMs,
      ))
      streamDisabled = NON_TRANSIENT_STREAM_STATUSES.has(streamResult.status)
      continue
    }
    emit(dependencies, {
      mode: 'stream',
      status: 'ok',
      attempt,
      stopToRawMs: streamResult.stopToRawMs,
      transcriptComparison:
        normalizeTranscript(streamResult.transcript) === normalizeTranscript(batchTranscript)
          ? 'match'
          : 'different',
    })
  }
  return streamFailed ? 1 : 0
}

type StreamingResult =
  | { readonly ok: true; readonly transcript: string; readonly stopToRawMs: number }
  | { readonly ok: false; readonly status: LiveStatus; readonly stopToRawMs: number }

async function runStreamingAttempt(
  pcm: Uint8Array<ArrayBuffer>,
  dependencies: LiveDependencies,
): Promise<StreamingResult> {
  let session: CodexDictationSession | undefined
  let stopStartedAt: number | undefined
  try {
    session = await dependencies.openStream({
      sampleRateHz: LIVE_SAMPLE_RATE_HZ,
      signal: dependencies.timeout(REQUEST_TIMEOUT_MS),
    })
    const frameBytes = LIVE_FRAME_SAMPLES * 2
    for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
      const chunk = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength))
      session.appendPcm16(chunk)
      await dependencies.wait((chunk.byteLength / 2 / LIVE_SAMPLE_RATE_HZ) * 1_000)
    }

    stopStartedAt = dependencies.now()
    const transcript = await session.finish()
    const stopToRawMs = Math.round(dependencies.now() - stopStartedAt)
    return transcript.trim().length > 0
      ? { ok: true, transcript, stopToRawMs }
      : { ok: false, status: 'error:empty', stopToRawMs }
  } catch (error) {
    return {
      ok: false,
      status: statusForError(error),
      stopToRawMs: stopStartedAt === undefined
        ? 0
        : Math.round(dependencies.now() - stopStartedAt),
    }
  } finally {
    session?.close()
  }
}

function normalizeTranscript(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}
