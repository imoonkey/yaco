import { extname } from 'node:path'
import {
  CodexTranscribeError,
  type CodexTranscribeErrorCode,
  type CodexTranscribeInput,
  type CodexTranscribeStatus,
} from '../src/index.ts'

export type LiveEnvironment = {
  readonly CODEX_TRANSCRIBE_LIVE?: string
  readonly CODEX_TRANSCRIBE_FIXTURES?: string
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
type LiveMimeType = 'audio/webm' | 'audio/mp4' | 'none' | 'unknown'

type LiveEvent = {
  readonly status: LiveStatus
  readonly mimeType: LiveMimeType
  readonly attempt: number
  readonly latencyMs: number
}

export type LiveDependencies = {
  readonly inspect: () => Promise<CodexTranscribeStatus>
  readonly readAudio: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  readonly transcribe: (input: CodexTranscribeInput) => Promise<string>
  readonly now: () => number
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
  if (attempts < 1 || attempts > 20) throw new Error('invalid attempt count')
  return attempts
}

export function parseFixturePaths(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') throw new Error('invalid fixture list')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('invalid fixture list')
  }
  if (
    !Array.isArray(value) || value.length < 1 || value.length > 2 ||
    value.some(path => typeof path !== 'string' || path.length === 0)
  ) {
    throw new Error('invalid fixture list')
  }
  return value
}

export function formatLiveEvent(
  event: LiveEvent & { readonly [key: string]: unknown },
): string {
  return JSON.stringify({
    status: event.status,
    mimeType: event.mimeType,
    attempt: event.attempt,
    latencyMs: event.latencyMs,
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

export async function runLive(
  environment: LiveEnvironment,
  dependencies: LiveDependencies,
): Promise<number> {
  if (environment.CODEX_TRANSCRIBE_LIVE !== '1') {
    emit(dependencies, { status: 'disabled', mimeType: 'none', attempt: 0, latencyMs: 0 })
    return 2
  }

  let paths: string[]
  let attempts: number
  try {
    paths = parseFixturePaths(environment.CODEX_TRANSCRIBE_FIXTURES)
    attempts = parseAttemptCount(environment.CODEX_TRANSCRIBE_ATTEMPTS)
  } catch {
    emit(dependencies, { status: 'error:input', mimeType: 'none', attempt: 0, latencyMs: 0 })
    return 2
  }

  const availability = await dependencies.inspect()
  if (!availability.available) {
    emit(dependencies, {
      status: `unavailable:${availability.reason}`,
      mimeType: 'none',
      attempt: 0,
      latencyMs: 0,
    })
    return 1
  }

  for (const path of paths) {
    let mimeType: 'audio/webm' | 'audio/mp4'
    let audio: Uint8Array<ArrayBuffer>
    try {
      mimeType = mimeTypeForPath(path)
      audio = await dependencies.readAudio(path)
    } catch {
      emit(dependencies, { status: 'error:input', mimeType: 'unknown', attempt: 0, latencyMs: 0 })
      return 2
    }

    const filename = mimeType === 'audio/webm' ? 'fixture.webm' : 'fixture.mp4'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const startedAt = dependencies.now()
      try {
        const transcript = await dependencies.transcribe({
          audio,
          filename,
          mimeType,
          signal: dependencies.timeout(60_000),
        })
        const latencyMs = Math.round(dependencies.now() - startedAt)
        if (transcript.trim().length === 0) {
          emit(dependencies, { status: 'error:empty', mimeType, attempt, latencyMs })
          return 1
        }
        emit(dependencies, { status: 'ok', mimeType, attempt, latencyMs })
      } catch (error) {
        emit(dependencies, {
          status: statusForError(error),
          mimeType,
          attempt,
          latencyMs: Math.round(dependencies.now() - startedAt),
        })
        return 1
      }
    }
  }
  return 0
}
