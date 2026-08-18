// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexVoiceStream } from '../codexVoiceStream'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: Array<string | Uint8Array> = []
  readyState = FakeWebSocket.CONNECTING
  bufferedAmount = 0
  binaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.sent.push(data)
      return
    }
    if (ArrayBuffer.isView(data)) {
      this.sent.push(Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
      return
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(Uint8Array.from(new Uint8Array(data)))
      return
    }
    throw new Error('unexpected Blob send')
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code: 1000 }))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receive(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: value }))
  }

  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

function socket(): FakeWebSocket {
  return FakeWebSocket.instances.at(-1)!
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createCodexVoiceStream', () => {
  it('queues PCM until ready, drains it in order, and accepts one final after finish', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    stream.append(new Int16Array([1, -2]))
    stream.append(new Int16Array([3]))

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    expect(socket().url).toBe(`${protocol}//${window.location.host}/ws/voice/codex`)
    expect(socket().sent).toEqual([])

    socket().open()
    expect(socket().sent).toEqual([JSON.stringify({ type: 'start', sampleRateHz: 48_000 })])

    socket().receive(JSON.stringify({ type: 'ready' }))
    expect(socket().sent.slice(1)).toEqual([
      new Uint8Array([1, 0, 254, 255]),
      new Uint8Array([3, 0]),
    ])

    const final = stream.finish()
    expect(socket().sent.at(-1)).toBe(JSON.stringify({ type: 'finish' }))
    socket().receive(JSON.stringify({ type: 'final', text: 'ordered words' }))

    await expect(final).resolves.toBe('ordered words')
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED)
  })

  it.each([
    ['server failure', () => socket().receive(JSON.stringify({ type: 'failed' }))],
    ['socket error', () => socket().fail()],
    ['malformed terminal payload', () => socket().receive(JSON.stringify({ type: 'final', text: 'secret', extra: true }))],
  ])('normalizes %s to an unavailable stream', async (_label, fail) => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    fail()
    await expect(stream.finish()).resolves.toBeNull()
  })

  it('preserves an empty final so orchestration can choose batch fallback', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    socket().receive(JSON.stringify({ type: 'ready' }))
    const final = stream.finish()
    socket().receive(JSON.stringify({ type: 'final', text: '   ' }))
    await expect(final).resolves.toBe('   ')
  })

  it('uses one startup deadline that is not reset by finish', async () => {
    vi.useFakeTimers()
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    const final = stream.finish()

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(final).resolves.toBeNull()
  })

  it('times out waiting for a final after a ready stream is finished', async () => {
    vi.useFakeTimers()
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    socket().receive(JSON.stringify({ type: 'ready' }))
    const final = stream.finish()

    await vi.advanceTimersByTimeAsync(8_000)
    await expect(final).resolves.toBeNull()
  })

  it('fails closed when the pre-ready PCM queue exceeds 4 MiB', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    stream.append(new Int16Array((4 * 1024 * 1024) / 2 + 1))

    await expect(stream.finish()).resolves.toBeNull()
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('fails closed when 1024 pre-ready frames are already queued', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    for (let index = 0; index < 1_025; index++) stream.append(new Int16Array([index]))

    await expect(stream.finish()).resolves.toBeNull()
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('shares the 4 MiB cap with the browser send buffer after ready', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    socket().receive(JSON.stringify({ type: 'ready' }))
    socket().bufferedAmount = 4 * 1024 * 1024
    stream.append(new Int16Array([1]))

    await expect(stream.finish()).resolves.toBeNull()
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('ignores stale duplicate terminal events and closes idempotently', async () => {
    const stream = createCodexVoiceStream()
    stream.start(48_000)
    socket().open()
    socket().receive(JSON.stringify({ type: 'ready' }))
    const final = stream.finish()
    socket().receive(JSON.stringify({ type: 'final', text: 'first' }))
    socket().receive(JSON.stringify({ type: 'final', text: 'second' }))
    stream.close()
    stream.close()

    await expect(final).resolves.toBe('first')
  })
})
