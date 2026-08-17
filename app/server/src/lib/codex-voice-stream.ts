import {
  openCodexDictationSession,
  type CodexDictationSession,
} from 'yaco-codex-transcribe'
import { WebSocket, type RawData } from 'ws'

export const CODEX_VOICE_MAX_PENDING_BYTES = 4 * 1024 * 1024

const MIN_SAMPLE_RATE_HZ = 8_000
const MAX_SAMPLE_RATE_HZ = 96_000
const START_IDLE_TIMEOUT_MS = 10_000
const AUDIO_IDLE_TIMEOUT_MS = 30_000

export type CodexVoiceStreamBridge = {
  accept(ws: WebSocket): void
  close(): void
}

/** Owns every browser-side Codex voice take without exposing upstream details. */
export function createCodexVoiceStreamBridge(): CodexVoiceStreamBridge {
  const connections = new Set<VoiceConnection>()
  let closed = false

  return {
    accept(ws) {
      if (closed) {
        ws.terminate()
        return
      }
      const connection = new VoiceConnection(ws, () => connections.delete(connection))
      connections.add(connection)
    },
    close() {
      if (closed) return
      closed = true
      for (const connection of [...connections]) connection.shutdown()
    },
  }
}

class VoiceConnection {
  private readonly abort = new AbortController()
  private readonly pending: Uint8Array[] = []
  private pendingBytes = 0
  private started = false
  private finishRequested = false
  private terminal = false
  private session: CodexDictationSession | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly ws: WebSocket,
    private readonly onTerminal: () => void,
  ) {
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary))
    ws.once('close', () => this.cancel())
    ws.once('error', () => this.cancel())
    this.armIdleTimeout(START_IDLE_TIMEOUT_MS)
  }

  shutdown(): void {
    this.cancel(true)
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.terminal) return
    if (isBinary) {
      this.onAudio(data)
      return
    }

    const message = parseControl(data)
    if (isStart(message) && !this.started) {
      this.started = true
      this.armIdleTimeout(AUDIO_IDLE_TIMEOUT_MS)
      void this.open(message.sampleRateHz)
      return
    }
    if (isFinish(message) && this.started && !this.finishRequested) {
      this.finishRequested = true
      this.clearIdleTimeout()
      this.finishUpstream()
      return
    }
    this.fail(1002)
  }

  private onAudio(data: RawData): void {
    if (!this.started || this.finishRequested) {
      this.fail(1002)
      return
    }

    const byteLength = rawDataLength(data)
    if (
      byteLength % 2 !== 0 ||
      (this.session === undefined && byteLength > CODEX_VOICE_MAX_PENDING_BYTES - this.pendingBytes)
    ) {
      this.fail(1002)
      return
    }

    const chunk = copyRawData(data)
    this.armIdleTimeout(AUDIO_IDLE_TIMEOUT_MS)
    if (this.session === undefined) {
      this.pending.push(chunk)
      this.pendingBytes += byteLength
      return
    }
    try {
      this.session.appendPcm16(chunk)
    } catch {
      this.fail(1011)
    }
  }

  private async open(sampleRateHz: number): Promise<void> {
    let session: CodexDictationSession
    try {
      session = await openCodexDictationSession({
        sampleRateHz,
        signal: this.abort.signal,
      })
    } catch {
      this.fail(1011)
      return
    }

    if (this.terminal) {
      session.close()
      return
    }
    this.session = session

    const pending = this.pending.splice(0)
    this.pendingBytes = 0
    try {
      for (const chunk of pending) session.appendPcm16(chunk)
    } catch {
      this.fail(1011)
      return
    }

    if (!this.send({ type: 'ready' })) return
    this.finishUpstream()
  }

  private finishUpstream(): void {
    if (!this.finishRequested || this.session === undefined || this.terminal) return
    let final: Promise<string>
    try {
      final = this.session.finish()
    } catch {
      this.fail(1011)
      return
    }
    void final.then(
      (text) => this.finish({ type: 'final', text }, 1000),
      () => this.fail(1011),
    )
  }

  private fail(closeCode: number): void {
    this.finish({ type: 'failed' }, closeCode)
  }

  private finish(payload: Record<string, unknown>, closeCode: number): void {
    if (this.terminal) return
    this.terminal = true
    this.cleanup()
    if (this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(payload))
      this.ws.close(closeCode)
    } catch {
      this.ws.terminate()
    }
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.cancel(true)
      return false
    }
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      this.cancel(true)
      return false
    }
  }

  private cancel(terminate = false): void {
    if (this.terminal) return
    this.terminal = true
    this.cleanup()
    if (terminate && this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate()
  }

  private cleanup(): void {
    this.clearIdleTimeout()
    this.abort.abort()
    this.session?.close()
    this.session = undefined
    this.pending.length = 0
    this.pendingBytes = 0
    this.onTerminal()
  }

  private armIdleTimeout(timeoutMs: number): void {
    this.clearIdleTimeout()
    this.idleTimer = setTimeout(() => this.fail(1002), timeoutMs)
    this.idleTimer.unref()
  }

  private clearIdleTimeout(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

type StartMessage = {
  readonly type: 'start'
  readonly sampleRateHz: number
}

type FinishMessage = {
  readonly type: 'finish'
}

function parseControl(data: RawData): unknown {
  try {
    return JSON.parse(rawDataBuffer(data).toString('utf8'))
  } catch {
    return undefined
  }
}

function isStart(value: unknown): value is StartMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 &&
    record.type === 'start' &&
    Number.isInteger(record.sampleRateHz) &&
    (record.sampleRateHz as number) >= MIN_SAMPLE_RATE_HZ &&
    (record.sampleRateHz as number) <= MAX_SAMPLE_RATE_HZ
}

function isFinish(value: unknown): value is FinishMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && record.type === 'finish'
}

function rawDataLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, part) => total + part.byteLength, 0)
    : data.byteLength
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function copyRawData(data: RawData): Uint8Array {
  return Uint8Array.from(rawDataBuffer(data))
}
