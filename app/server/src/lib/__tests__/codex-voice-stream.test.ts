import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { CodexDictationSession } from 'yaco-codex-transcribe'

const { openCodexDictationSession } = vi.hoisted(() => ({
  openCodexDictationSession: vi.fn(),
}))

vi.mock('yaco-codex-transcribe', async (importOriginal) => ({
  ...await importOriginal<typeof import('yaco-codex-transcribe')>(),
  openCodexDictationSession,
}))

import {
  CODEX_VOICE_MAX_PENDING_BYTES,
  createCodexVoiceStreamBridge,
  type CodexVoiceStreamBridge,
} from '../codex-voice-stream.js'

const PRIVATE_AUDIO = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
const PRIVATE_TRANSCRIPT = 'private transcript contents'
const PRIVATE_UPSTREAM_ERROR = 'bearer.private-token upstream body private transcript contents'

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

type Client = {
  readonly ws: WebSocket
  readonly messages: unknown[]
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type FakeSession = CodexDictationSession & {
  appendPcm16: Mock<(chunk: Uint8Array) => void>
  finish: Mock<() => Promise<string>>
  close: Mock<() => void>
}

function fakeSession(text = PRIVATE_TRANSCRIPT): FakeSession {
  return {
    appendPcm16: vi.fn<(chunk: Uint8Array) => void>(),
    finish: vi.fn<() => Promise<string>>(async () => text),
    close: vi.fn<() => void>(),
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true))
}

async function waitForIo(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(check()).toBe(true)
}

describe('Codex voice WebSocket bridge', () => {
  let server: Server
  let wss: WebSocketServer
  let bridge: CodexVoiceStreamBridge
  let url: string
  const clients: WebSocket[] = []

  beforeEach(async () => {
    openCodexDictationSession.mockReset()
    bridge = createCodexVoiceStreamBridge()
    server = createServer()
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => bridge.accept(ws))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    url = `ws://127.0.0.1:${port}`
  })

  afterEach(async () => {
    vi.useRealTimers()
    bridge.close()
    for (const client of clients) client.terminate()
    clients.length = 0
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.restoreAllMocks()
  })

  async function connect(): Promise<Client> {
    const ws = new WebSocket(url)
    clients.push(ws)
    const messages: unknown[] = []
    ws.on('message', (data, isBinary) => {
      expect(isBinary).toBe(false)
      messages.push(JSON.parse(data.toString()))
    })
    await once(ws, 'open')
    return { ws, messages }
  }

  it('drains pre-ready PCM in order, then returns ready and the final transcript', async () => {
    const opening = deferred<CodexDictationSession>()
    const session = fakeSession()
    openCodexDictationSession.mockReturnValue(opening.promise)
    const client = await connect()

    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    client.ws.send(PRIVATE_AUDIO.subarray(0, 2))
    client.ws.send(PRIVATE_AUDIO.subarray(2))
    client.ws.send(JSON.stringify({ type: 'finish' }))

    await waitFor(() => openCodexDictationSession.mock.calls.length === 1)
    const input = openCodexDictationSession.mock.calls[0]![0]
    expect(input.sampleRateHz).toBe(48_000)
    expect(input.signal).toBeInstanceOf(AbortSignal)
    expect(session.appendPcm16).not.toHaveBeenCalled()

    opening.resolve(session)
    await waitFor(() => client.messages.length === 2)

    expect(session.appendPcm16.mock.calls.map(([chunk]) => [...chunk])).toEqual([
      [0xde, 0xad],
      [0xbe, 0xef],
    ])
    expect(session.finish).toHaveBeenCalledOnce()
    expect(session.close).toHaveBeenCalledOnce()
    expect(client.messages).toEqual([
      { type: 'ready' },
      { type: 'final', text: PRIVATE_TRANSCRIPT },
    ])
  })

  it('forwards post-ready PCM without retaining it', async () => {
    const session = fakeSession('')
    openCodexDictationSession.mockResolvedValue(session)
    const client = await connect()

    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 44_100 }))
    await waitFor(() => client.messages.length === 1)
    client.ws.send(PRIVATE_AUDIO)
    client.ws.send(JSON.stringify({ type: 'finish' }))
    await waitFor(() => client.messages.length === 2)

    expect(session.appendPcm16).toHaveBeenCalledOnce()
    expect([...session.appendPcm16.mock.calls[0]![0]]).toEqual([...PRIVATE_AUDIO])
    expect(client.messages).toEqual([
      { type: 'ready' },
      { type: 'final', text: '' },
    ])
  })

  it('accepts exactly four MiB pending and rejects the next PCM sample', async () => {
    const opening = deferred<CodexDictationSession>()
    openCodexDictationSession.mockReturnValue(opening.promise)
    const client = await connect()

    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    client.ws.send(new Uint8Array(CODEX_VOICE_MAX_PENDING_BYTES))
    client.ws.send(Uint8Array.from([1, 2]))
    await waitFor(() => client.messages.length === 1)

    expect(client.messages).toEqual([{ type: 'failed' }])
    expect(openCodexDictationSession.mock.calls[0]![0].signal.aborted).toBe(true)
    const lateSession = fakeSession()
    opening.resolve(lateSession)
    await waitFor(() => lateSession.close.mock.calls.length === 1)
  })

  it.each([
    ['binary before start', (client: Client) => client.ws.send(PRIVATE_AUDIO)],
    ['malformed JSON', (client: Client) => client.ws.send('{')],
    ['unknown control', (client: Client) => client.ws.send(JSON.stringify({ type: 'cancel' }))],
    ['finish before start', (client: Client) => client.ws.send(JSON.stringify({ type: 'finish' }))],
    ['extra start field', (client: Client) => client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000, extra: true }))],
    ['fractional sample rate', (client: Client) => client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 44_100.5 }))],
    ['low sample rate', (client: Client) => client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 7_999 }))],
    ['high sample rate', (client: Client) => client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 96_001 }))],
  ])('fails closed on %s', async (_name, violate) => {
    const client = await connect()
    violate(client)
    await waitFor(() => client.messages.length === 1)

    expect(client.messages).toEqual([{ type: 'failed' }])
    expect(openCodexDictationSession).not.toHaveBeenCalled()
  })

  it('rejects duplicate start, duplicate finish, odd PCM, and PCM after finish', async () => {
    for (const violate of [
      (client: Client) => client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 })),
      (client: Client) => client.ws.send(Uint8Array.from([1])),
      (client: Client) => {
        client.ws.send(JSON.stringify({ type: 'finish' }))
        client.ws.send(JSON.stringify({ type: 'finish' }))
      },
      (client: Client) => {
        client.ws.send(JSON.stringify({ type: 'finish' }))
        client.ws.send(PRIVATE_AUDIO)
      },
    ]) {
      const opening = deferred<CodexDictationSession>()
      openCodexDictationSession.mockReturnValueOnce(opening.promise)
      const client = await connect()
      client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
      violate(client)
      await waitFor(() => client.messages.length === 1)
      expect(client.messages).toEqual([{ type: 'failed' }])
      opening.reject(new Error('cancelled'))
    }
  })

  it('maps private upstream failures to one stable failed payload', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    openCodexDictationSession.mockRejectedValue(new Error(PRIVATE_UPSTREAM_ERROR))
    const client = await connect()

    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    await waitFor(() => client.messages.length === 1)

    const observable = JSON.stringify({
      messages: client.messages,
      errors: errorSpy.mock.calls,
      warnings: warnSpy.mock.calls,
    })
    expect(client.messages).toEqual([{ type: 'failed' }])
    expect(observable).not.toContain(PRIVATE_UPSTREAM_ERROR)
    expect(observable).not.toContain(Buffer.from(PRIVATE_AUDIO).toString('hex'))
    expect(observable).not.toContain(PRIVATE_TRANSCRIPT)
  })

  it('aborts and returns failed when upstream startup times out', async () => {
    openCodexDictationSession.mockRejectedValue(new Error('startup timeout'))
    const client = await connect()
    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    await waitFor(() => client.messages.length === 1)

    expect(client.messages).toEqual([{ type: 'failed' }])
    expect(openCodexDictationSession.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it('fails a connection that never sends start after ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = await connect()
    const failed = once(client.ws, 'message')

    await vi.advanceTimersByTimeAsync(9_999)
    expect(client.messages).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await failed

    expect(client.messages).toEqual([{ type: 'failed' }])
    expect(openCodexDictationSession).not.toHaveBeenCalled()
  })

  it('fails a started stream after thirty silent seconds and resets on PCM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const session = fakeSession()
    openCodexDictationSession.mockResolvedValue(session)
    const client = await connect()
    const ready = once(client.ws, 'message')
    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    await ready

    await vi.advanceTimersByTimeAsync(29_000)
    client.ws.send(PRIVATE_AUDIO)
    await waitForIo(() => session.appendPcm16.mock.calls.length === 1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(session.close).not.toHaveBeenCalled()

    const failed = once(client.ws, 'message')
    await vi.advanceTimersByTimeAsync(1)
    await failed

    expect(client.messages).toEqual([{ type: 'ready' }, { type: 'failed' }])
    expect(session.close).toHaveBeenCalledOnce()
    expect(openCodexDictationSession.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it('cleans up once when append or finish fails', async () => {
    for (const failAt of ['append', 'finish', 'finish-sync'] as const) {
      const session = fakeSession()
      if (failAt === 'append') session.appendPcm16.mockImplementation(() => { throw new Error(PRIVATE_UPSTREAM_ERROR) })
      else if (failAt === 'finish') session.finish.mockRejectedValue(new Error(PRIVATE_UPSTREAM_ERROR))
      else session.finish.mockImplementation(() => { throw new Error(PRIVATE_UPSTREAM_ERROR) })
      openCodexDictationSession.mockResolvedValueOnce(session)
      const client = await connect()
      client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
      await waitFor(() => client.messages.length === 1)
      if (failAt === 'append') client.ws.send(PRIVATE_AUDIO)
      else client.ws.send(JSON.stringify({ type: 'finish' }))
      await waitFor(() => client.messages.length === 2)

      expect(client.messages.at(-1)).toEqual({ type: 'failed' })
      expect(session.close).toHaveBeenCalledOnce()
    }
  })

  it('aborts an opening session when downstream disconnects', async () => {
    const opening = deferred<CodexDictationSession>()
    openCodexDictationSession.mockReturnValue(opening.promise)
    const client = await connect()
    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    await waitFor(() => openCodexDictationSession.mock.calls.length === 1)

    client.ws.terminate()
    await waitFor(() => openCodexDictationSession.mock.calls[0]![0].signal.aborted)
    const session = fakeSession()
    opening.resolve(session)
    await waitFor(() => session.close.mock.calls.length === 1)
  })

  it('closes every upstream exactly once on repeated server shutdown', async () => {
    const first = fakeSession()
    const second = fakeSession()
    openCodexDictationSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const clientsForShutdown = await Promise.all([connect(), connect()])
    for (const client of clientsForShutdown) {
      client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    }
    await waitFor(() => clientsForShutdown.every((client) => client.messages.length === 1))

    bridge.close()
    bridge.close()

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('aborts startup and closes a late upstream on server shutdown', async () => {
    const opening = deferred<CodexDictationSession>()
    openCodexDictationSession.mockReturnValue(opening.promise)
    const client = await connect()
    client.ws.send(JSON.stringify({ type: 'start', sampleRateHz: 48_000 }))
    await waitFor(() => openCodexDictationSession.mock.calls.length === 1)

    bridge.close()
    bridge.close()
    expect(openCodexDictationSession.mock.calls[0]![0].signal.aborted).toBe(true)

    const session = fakeSession()
    opening.resolve(session)
    await waitFor(() => session.close.mock.calls.length === 1)
  })
})
