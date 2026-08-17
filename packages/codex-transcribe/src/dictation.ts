import WebSocket, { type RawData } from 'ws'
import { readCredentials } from './auth.js'
import {
  isRequestedMode,
  parseUpstreamEvent,
} from './dictation-events.js'
import { CodexTranscribeError } from './errors.js'

const STREAM_ENDPOINT = 'wss://chatgpt.com/backend-api/dictation/stream'
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const STARTUP_TIMEOUT_MS = 10_000
const FINISH_TIMEOUT_MS = 8_000

type SessionPhase =
  | 'starting'
  | 'streaming'
  | 'finishing'
  | 'closed'
  | 'failed'

export type CodexDictationSession = {
  appendPcm16(chunk: Uint8Array): void
  finish(): Promise<string>
  close(): void
}

export type CodexDictationSessionInput = {
  readonly sampleRateHz: number
  readonly signal?: AbortSignal
}

export async function openCodexDictationSession(
  input: CodexDictationSessionInput,
): Promise<CodexDictationSession> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  validateSampleRate(input.sampleRateHz)
  if (input.signal?.aborted) throw new CodexTranscribeError('network')

  const auth = await readCredentials()
  if (!('credentials' in auth)) {
    throw new CodexTranscribeError(
      auth.reason === 'expired_auth' ? 'expired_auth' : 'not_configured',
    )
  }
  if (input.signal?.aborted) throw new CodexTranscribeError('network')

  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) throw new CodexTranscribeError('network')

  const session = new UpstreamDictationSession(
    input.sampleRateHz,
    auth.credentials.accessToken,
    input.signal,
    timeoutMs,
  )
  await session.ready()
  session.throwIfFailed()
  return session
}

class UpstreamDictationSession implements CodexDictationSession {
  private readonly socket: WebSocket
  private readonly signal: AbortSignal | undefined
  private phase: SessionPhase = 'starting'
  private queuedAudioBytes = 0
  private terminalError: CodexTranscribeError | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private finishTimer: ReturnType<typeof setTimeout> | undefined
  private finishPromise: Promise<string> | undefined
  private resolveFinish: ((text: string) => void) | undefined
  private rejectFinish: ((error: CodexTranscribeError) => void) | undefined
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | undefined
  private rejectReady: ((error: CodexTranscribeError) => void) | undefined
  private readonly utteranceOrder: string[] = []
  private readonly finalByUtterance = new Map<string, string>()

  constructor(
    sampleRateHz: number,
    accessToken: string,
    signal: AbortSignal | undefined,
    startupTimeoutMs: number,
  ) {
    this.signal = signal
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.socket = new WebSocket(STREAM_ENDPOINT, [
      'chatgpt-dictation',
      `openai-bearer.${accessToken}`,
      'codex-desktop',
    ])
    this.startupTimer = setTimeout(
      () => this.fail(new CodexTranscribeError('network')),
      startupTimeoutMs,
    )
    signal?.addEventListener('abort', this.onAbort, { once: true })
    this.socket.once('open', () => {
      this.send({
        type: 'session.start',
        config: {
          input_audio_format: 'pcm16',
          sample_rate_hz: sampleRateHz,
          num_channels: 1,
          max_buffer_size_bytes: MAX_AUDIO_BYTES,
          max_utterance_duration_ms: 30_000,
          session_ttl_ms: 300_000,
          provider_mode: 'streaming_sse',
          transcript_delivery_mode: 'final_only',
          vad: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    })
    this.socket.on('message', (data, isBinary) => this.onMessage(data, isBinary))
    this.socket.once('unexpected-response', (_request, response) => {
      response.resume()
      this.fail(errorForStatus(
        response.statusCode ?? 0,
        response.headers['retry-after'],
      ))
    })
    this.socket.on('error', () => {
      this.fail(new CodexTranscribeError('network'))
    })
    this.socket.once('close', () => {
      if (this.phase !== 'closed' && this.phase !== 'failed') {
        this.fail(new CodexTranscribeError('network'), false)
      }
    })
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  throwIfFailed(): void {
    if (this.terminalError !== undefined) throw this.terminalError
  }

  appendPcm16(chunk: Uint8Array): void {
    this.requirePhase('streaming')
    if (chunk.byteLength === 0) return
    if (
      chunk.byteLength % 2 !== 0 ||
      chunk.byteLength > MAX_AUDIO_BYTES - this.queuedAudioBytes
    ) {
      const error = new CodexTranscribeError('upstream')
      this.fail(error)
      throw error
    }

    this.sendAudio(chunk)
    this.throwIfFailed()
  }

  finish(): Promise<string> {
    if (this.finishPromise !== undefined) return this.finishPromise
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError)
    this.requirePhase('streaming')
    this.phase = 'finishing'
    this.finishPromise = new Promise((resolve, reject) => {
      this.resolveFinish = resolve
      this.rejectFinish = reject
    })
    this.finishTimer = setTimeout(
      () => this.fail(new CodexTranscribeError('network')),
      FINISH_TIMEOUT_MS,
    )
    this.send({ type: 'audio.flush', reason: 'client' })
    this.send({ type: 'session.close' })
    return this.finishPromise
  }

  close(): void {
    if (this.phase === 'closed' || this.phase === 'failed') return
    this.fail(new CodexTranscribeError('network'))
  }

  private readonly onAbort = (): void => {
    this.fail(new CodexTranscribeError('network'))
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.phase === 'closed' || this.phase === 'failed') return
    const upstreamEvent = isBinary
      ? undefined
      : parseUpstreamEvent(data.toString('utf8'))
    if (upstreamEvent === undefined) {
      this.fail(new CodexTranscribeError('upstream'))
      return
    }

    if (upstreamEvent.type === 'session.started') {
      if (
        this.phase !== 'starting' ||
        upstreamEvent.session.status !== 'active' ||
        !isRequestedMode(upstreamEvent.session)
      ) {
        this.fail(new CodexTranscribeError('upstream'))
        return
      }
      this.phase = 'streaming'
      this.clearStartupTimer()
      this.resolveReady?.()
      this.resolveReady = undefined
      this.rejectReady = undefined
      return
    }

    if (upstreamEvent.type === 'transcript.failed') {
      this.fail(new CodexTranscribeError('upstream'))
      return
    }
    if (upstreamEvent.type === 'session.error') {
      if (upstreamEvent.fatal) this.fail(new CodexTranscribeError('upstream'))
      return
    }
    if (this.phase === 'starting') {
      this.fail(new CodexTranscribeError('upstream'))
      return
    }

    if (upstreamEvent.type === 'session.updated') {
      if (!isRequestedMode(upstreamEvent.session)) {
        this.fail(new CodexTranscribeError('upstream'))
        return
      }
      if (upstreamEvent.session.status === 'closed') {
        if (this.phase !== 'finishing') {
          this.fail(new CodexTranscribeError('upstream'))
          return
        }
        this.complete()
      }
      return
    }
    if (
      upstreamEvent.type === 'speech.started' ||
      upstreamEvent.type === 'speech.stopped'
    ) {
      this.recordUtterance(upstreamEvent.utteranceId)
      return
    }
    if (upstreamEvent.type === 'transcript.final') {
      this.recordUtterance(upstreamEvent.utteranceId)
      this.finalByUtterance.set(upstreamEvent.utteranceId, upstreamEvent.text)
    }
  }

  private recordUtterance(utteranceId: string): void {
    if (this.finalByUtterance.has(utteranceId)) return
    this.finalByUtterance.set(utteranceId, '')
    this.utteranceOrder.push(utteranceId)
  }

  private complete(): void {
    const text = this.utteranceOrder
      .map((utteranceId) => this.finalByUtterance.get(utteranceId) ?? '')
      .filter(Boolean)
      .join(' ')
      .trim()
    this.phase = 'closed'
    this.clearTimers()
    this.detachAbort()
    this.resolveFinish?.(text)
    this.resolveFinish = undefined
    this.rejectFinish = undefined
    this.socket.close(1_000)
  }

  private requirePhase(expected: SessionPhase): void {
    if (this.terminalError !== undefined) throw this.terminalError
    if (this.phase === expected) return
    const error = new CodexTranscribeError('upstream')
    this.fail(error)
    throw error
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.fail(new CodexTranscribeError('network'))
      return
    }
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      this.fail(new CodexTranscribeError('network'))
    }
  }

  private sendAudio(chunk: Uint8Array): void {
    const byteLength = chunk.byteLength
    this.queuedAudioBytes += byteLength
    try {
      this.socket.send(JSON.stringify({
        type: 'audio.append',
        audio: Buffer.from(chunk).toString('base64'),
      }), (error) => {
        this.queuedAudioBytes = Math.max(
          0,
          this.queuedAudioBytes - byteLength,
        )
        if (error) this.fail(new CodexTranscribeError('network'))
      })
    } catch {
      this.queuedAudioBytes -= byteLength
      this.fail(new CodexTranscribeError('network'))
    }
  }

  private fail(error: CodexTranscribeError, stopSocket = true): void {
    if (this.phase === 'closed' || this.phase === 'failed') return
    this.phase = 'failed'
    this.terminalError = error
    this.clearTimers()
    this.detachAbort()
    this.queuedAudioBytes = 0
    this.utteranceOrder.length = 0
    this.finalByUtterance.clear()
    this.rejectReady?.(error)
    this.rejectFinish?.(error)
    this.resolveReady = undefined
    this.rejectReady = undefined
    this.resolveFinish = undefined
    this.rejectFinish = undefined
    if (!stopSocket) return
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.terminate()
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  private clearTimers(): void {
    this.clearStartupTimer()
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer)
    this.finishTimer = undefined
  }

  private detachAbort(): void {
    this.signal?.removeEventListener('abort', this.onAbort)
  }
}

function validateSampleRate(sampleRateHz: number): void {
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new CodexTranscribeError('upstream')
  }
}

function errorForStatus(
  status: number,
  retryAfter: string | string[] | undefined,
): CodexTranscribeError {
  if (status === 401) return new CodexTranscribeError('expired_auth')
  if (status === 403) return new CodexTranscribeError('forbidden')
  if (status === 429) {
    return new CodexTranscribeError('rate_limited', {
      retryAfter: Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
    })
  }
  return new CodexTranscribeError('upstream')
}
