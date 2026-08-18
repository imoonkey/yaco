const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_PENDING_FRAMES = 1_024
const START_TIMEOUT_MS = 10_000
const FINISH_TIMEOUT_MS = 8_000
const MIN_SAMPLE_RATE_HZ = 8_000
const MAX_SAMPLE_RATE_HZ = 96_000

export interface CodexVoiceStream {
  start: (sampleRateHz: number) => void
  append: (chunk: Int16Array) => void
  finish: () => Promise<string | null>
  close: () => void
}

type StreamState = 'idle' | 'connecting' | 'ready' | 'terminal'

/** One browser-to-YACO socket for one Codex take. Credentials and the hidden
 * upstream protocol remain wholly owned by the server. */
export function createCodexVoiceStream(): CodexVoiceStream {
  let state: StreamState = 'idle'
  let socket: WebSocket | null = null
  let opened = false
  let finishRequested = false
  let finishSent = false
  let pendingBytes = 0
  let pending: Uint8Array[] = []
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let finishTimer: ReturnType<typeof setTimeout> | null = null
  let resolveResult: (text: string | null) => void = () => {}
  const result = new Promise<string | null>((resolve) => { resolveResult = resolve })

  const clearTimers = (): void => {
    if (startTimer) clearTimeout(startTimer)
    if (finishTimer) clearTimeout(finishTimer)
    startTimer = null
    finishTimer = null
  }

  const settle = (text: string | null): void => {
    if (state === 'terminal') return
    state = 'terminal'
    clearTimers()
    pending = []
    pendingBytes = 0
    resolveResult(text)

    const current = socket
    socket = null
    if (!current) return
    current.onopen = null
    current.onmessage = null
    current.onerror = null
    current.onclose = null
    if (current.readyState < WebSocket.CLOSING) current.close()
  }

  const send = (data: string | Uint8Array): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      settle(null)
      return false
    }
    if (
      typeof data !== 'string' &&
      data.byteLength > MAX_PENDING_BYTES - socket.bufferedAmount
    ) {
      settle(null)
      return false
    }
    try {
      socket.send(data)
      return true
    } catch {
      settle(null)
      return false
    }
  }

  const sendFinish = (): void => {
    if (state !== 'ready' || finishSent) return
    finishSent = true
    if (!send(JSON.stringify({ type: 'finish' }))) return
    finishTimer = setTimeout(() => settle(null), FINISH_TIMEOUT_MS)
  }

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (state === 'terminal' || typeof event.data !== 'string') {
      settle(null)
      return
    }

    const message = parseServerMessage(event.data)
    if (message?.type === 'failed') {
      settle(null)
      return
    }
    if (message?.type === 'ready' && state === 'connecting') {
      state = 'ready'
      if (startTimer) clearTimeout(startTimer)
      startTimer = null
      const frames = pending
      pending = []
      pendingBytes = 0
      for (const frame of frames) {
        if (!send(frame)) return
      }
      if (finishRequested) sendFinish()
      return
    }
    if (message?.type === 'final' && state === 'ready' && finishSent) {
      settle(message.text)
      return
    }
    settle(null)
  }

  const start = (sampleRateHz: number): void => {
    if (
      state !== 'idle' ||
      !Number.isInteger(sampleRateHz) ||
      sampleRateHz < MIN_SAMPLE_RATE_HZ ||
      sampleRateHz > MAX_SAMPLE_RATE_HZ
    ) {
      settle(null)
      return
    }

    state = 'connecting'
    startTimer = setTimeout(() => settle(null), START_TIMEOUT_MS)
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/voice/codex`)
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        if (state !== 'connecting' || opened) {
          settle(null)
          return
        }
        opened = true
        send(JSON.stringify({ type: 'start', sampleRateHz }))
      }
      socket.onmessage = onMessage
      socket.onerror = () => settle(null)
      socket.onclose = () => settle(null)
    } catch {
      settle(null)
    }
  }

  const append = (chunk: Int16Array): void => {
    if ((state !== 'connecting' && state !== 'ready') || finishRequested || chunk.byteLength === 0) {
      settle(null)
      return
    }
    const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (state === 'ready') {
      send(view)
      return
    }
    const bytes = Uint8Array.from(view)
    if (pending.length >= MAX_PENDING_FRAMES || bytes.byteLength > MAX_PENDING_BYTES - pendingBytes) {
      settle(null)
      return
    }
    pending.push(bytes)
    pendingBytes += bytes.byteLength
  }

  const finish = (): Promise<string | null> => {
    if (state === 'idle') settle(null)
    if (state === 'terminal' || finishRequested) return result
    finishRequested = true
    sendFinish()
    return result
  }

  return { start, append, finish, close: () => settle(null) }
}

type ServerMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'failed' }
  | { readonly type: 'final'; readonly text: string }

function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && record.type === 'ready') return { type: 'ready' }
  if (keys.length === 1 && record.type === 'failed') return { type: 'failed' }
  if (keys.length === 2 && record.type === 'final' && typeof record.text === 'string') {
    return { type: 'final', text: record.text }
  }
  return null
}
