import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientOptions,
  VerifyClientCallbackAsync,
} from 'ws'

const websocketRedirect = vi.hoisted(() => ({
  url: '',
  requested: [] as Array<{ readonly url: string; readonly protocols: readonly string[] }>,
}))

vi.mock('ws', async () => {
  const actual = await vi.importActual<typeof import('ws')>('ws')

  class RedirectedWebSocket extends actual.default {
    constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: ClientOptions,
    ) {
      const protocolList =
        protocols === undefined
          ? []
          : typeof protocols === 'string'
            ? [protocols]
            : protocols
      websocketRedirect.requested.push({
        url: String(url),
        protocols: protocolList,
      })
      super(websocketRedirect.url, protocols, options)
    }
  }

  return { ...actual, default: RedirectedWebSocket }
})

import WebSocket, { WebSocketServer } from 'ws'
import {
  CodexTranscribeError,
  openCodexDictationSession,
} from '../src/index.js'

const CLAIM = 'https://api.openai.com/auth.chatgpt_account_id'
const ACCOUNT_ID = 'account-from-auth'
const PRIVATE_TRANSCRIPT = 'private transcript content'
const PRIVATE_AUDIO = Uint8Array.from([19, 87, 42, 201])
const PRIVATE_AUDIO_BASE64 = Buffer.from(PRIVATE_AUDIO).toString('base64')
const STREAM_ENDPOINT = 'wss://chatgpt.com/backend-api/dictation/stream'
const MAX_AUDIO_BYTES = 4 * 1024 * 1024

type ServerHarness = {
  readonly server: WebSocketServer
  readonly sockets: Set<WebSocket>
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

function futureToken(extra: Record<string, unknown> = {}): string {
  return jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600, ...extra })
}

function auth(accessToken: string): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      account_id: ACCOUNT_ID,
      refresh_token: 'must-never-be-read-or-sent',
    },
  }
}

function event(
  type: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({ type, sequence_no: 1, ...fields })
}

function startedEvent(): string {
  return event('session.started', {
    session: {
      session_id: 'local-session',
      status: 'active',
      config: {
        provider_mode: 'streaming_sse',
        transcript_delivery_mode: 'final_only',
      },
    },
  })
}

function closedEvent(): string {
  return event('session.updated', {
    session: {
      session_id: 'local-session',
      status: 'closed',
      config: {
        provider_mode: 'streaming_sse',
        transcript_delivery_mode: 'final_only',
      },
    },
  })
}

function parseMessage(data: WebSocket.RawData): Record<string, unknown> {
  return JSON.parse(data.toString()) as Record<string, unknown>
}

async function startServer(
  onConnection: (socket: WebSocket) => void,
  verifyClient?: VerifyClientCallbackAsync,
): Promise<ServerHarness> {
  const sockets = new Set<WebSocket>()
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onConnection(socket)
  })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected local TCP address')
  }
  websocketRedirect.url = `ws://127.0.0.1:${address.port}`
  return { server, sockets }
}

async function closeServer(harness: ServerHarness | undefined): Promise<void> {
  if (harness === undefined) return
  for (const socket of harness.sockets) socket.terminate()
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

async function expectError(
  promise: Promise<unknown>,
  code: CodexTranscribeError['code'],
): Promise<CodexTranscribeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTranscribeError)
    expect(error).toMatchObject({ code })
    return error as CodexTranscribeError
  }
  throw new Error(`Expected CodexTranscribeError with code ${code}`)
}

describe.sequential('Codex dictation session', () => {
  let codexHome: string
  let harness: ServerHarness | undefined
  let token: string

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-dictation-'))
    token = futureToken({ [CLAIM]: ACCOUNT_ID })
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify(auth(token)), 'utf8')
    vi.stubEnv('CODEX_HOME', codexHome)
    websocketRedirect.requested.length = 0
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await closeServer(harness)
    harness = undefined
  })

  it('uses the fixed private protocol and returns ordered final utterances', async () => {
    const received: Array<Record<string, unknown>> = []
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        received.push(message)
        if (message.type === 'session.start') socket.send(startedEvent())
        if (message.type === 'session.close') {
          socket.send(event('speech.started', { utterance_id: 'utterance-1' }))
          socket.send(event('transcript.final', {
            utterance_id: 'utterance-1', revision: 0, text: 'draft',
          }))
          socket.send(event('transcript.final', {
            utterance_id: 'utterance-1', revision: 1, text: 'first',
          }))
          socket.send(event('speech.started', { utterance_id: 'utterance-2' }))
          socket.send(event('transcript.final', {
            utterance_id: 'utterance-2', revision: 0, text: 'second',
          }))
          socket.send(closedEvent())
        }
      })
    })
    const authPath = join(codexHome, 'auth.json')
    const authBefore = await readFile(authPath, 'utf8')
    await chmod(authPath, 0o400)

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    session.appendPcm16(Uint8Array.from([1, 2, 3, 4]))
    await expect(session.finish()).resolves.toBe('first second')
    session.close()
    session.close()

    expect(websocketRedirect.requested).toEqual([{
      url: STREAM_ENDPOINT,
      protocols: [
        'chatgpt-dictation',
        `openai-bearer.${token}`,
        'codex-desktop',
      ],
    }])
    expect(received).toEqual([
      {
        type: 'session.start',
        config: {
          input_audio_format: 'pcm16',
          sample_rate_hz: 48_000,
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
      },
      { type: 'audio.append', audio: 'AQIDBA==' },
      { type: 'audio.flush', reason: 'client' },
      { type: 'session.close' },
    ])
    expect(await readFile(authPath, 'utf8')).toBe(authBefore)
  })

  it.each([
    ['malformed final', event('transcript.final', {
      utterance_id: 'utterance-1', revision: 0,
    })],
    ['unknown terminal', event('transcript.done', {
      text: PRIVATE_TRANSCRIPT,
    })],
  ])('fails closed on %s events', async (_name, terminalEvent) => {
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        if (message.type === 'session.start') socket.send(startedEvent())
        if (message.type === 'session.close') socket.send(terminalEvent)
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 44_100 })
    const error = await expectError(session.finish(), 'upstream')
    expect(error.message).not.toContain(PRIVATE_TRANSCRIPT)
  })

  it.each([
    event('transcript.failed', {
      utterance_id: 'utterance-1',
      error: { code: 'private', message: PRIVATE_TRANSCRIPT, retryable: false },
    }),
    event('session.error', {
      fatal: true,
      error: { code: 'private', message: PRIVATE_TRANSCRIPT, retryable: false },
    }),
  ])('maps explicit upstream failure without its private body', async (failure) => {
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        if (message.type === 'session.start') socket.send(startedEvent())
        if (message.type === 'session.close') socket.send(failure)
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    const error = await expectError(session.finish(), 'upstream')
    expect(error.message).not.toContain(PRIVATE_TRANSCRIPT)
    expect(String(error.cause)).not.toContain(PRIVATE_TRANSCRIPT)
  })

  it('rejects unavailable auth before opening a websocket', async () => {
    vi.stubEnv('CODEX_HOME', join(codexHome, 'missing'))

    await expectError(
      openCodexDictationSession({ sampleRateHz: 48_000 }),
      'not_configured',
    )
    expect(websocketRedirect.requested).toEqual([])
  })

  it('rejects expired auth before opening a websocket', async () => {
    await chmod(join(codexHome, 'auth.json'), 0o600)
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify(auth(jwt({ exp: 0, [CLAIM]: ACCOUNT_ID }))),
      'utf8',
    )

    await expectError(
      openCodexDictationSession({ sampleRateHz: 48_000 }),
      'expired_auth',
    )
    expect(websocketRedirect.requested).toEqual([])
  })

  it('maps an HTTP 401 websocket handshake without response details', async () => {
    harness = await startServer(
      () => undefined,
      (_info, accept) => accept(false, 401, 'private response body'),
    )

    const error = await expectError(
      openCodexDictationSession({ sampleRateHz: 48_000 }),
      'expired_auth',
    )
    expect(error.message).not.toContain('private response body')
    expect(String(error.cause)).not.toContain('private response body')
  })

  it('enforces the ten-second startup deadline', async () => {
    vi.useFakeTimers()
    let connected!: () => void
    const connection = new Promise<void>((resolve) => { connected = resolve })
    harness = await startServer(() => connected())

    const opening = openCodexDictationSession({ sampleRateHz: 48_000 })
    const openingError = expectError(opening, 'network')
    await connection
    await vi.advanceTimersByTimeAsync(10_000)
    await openingError
  })

  it('enforces the eight-second finish deadline after startup', async () => {
    vi.useFakeTimers()
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') socket.send(startedEvent())
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    await vi.advanceTimersByTimeAsync(9_000)
    const finishingError = expectError(session.finish(), 'network')
    await vi.advanceTimersByTimeAsync(8_000)
    await finishingError
  })

  it('maps an upstream disconnect after startup', async () => {
    let disconnected!: () => void
    const socketDisconnected = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    harness = await startServer((socket) => {
      socket.on('close', () => disconnected())
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') {
          socket.send(startedEvent())
          setImmediate(() => socket.terminate())
        }
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    await socketDisconnected
    await expectError(session.finish(), 'network')
  })

  it('keeps a non-fatal session error non-terminal', async () => {
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        if (message.type === 'session.start') {
          socket.send(startedEvent())
          socket.send(event('session.error', {
            fatal: false,
            error: { code: 'warning', message: 'private warning', retryable: true },
          }))
        }
        if (message.type === 'session.close') socket.send(closedEvent())
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    await expect(session.finish()).resolves.toBe('')
  })

  it('closes and rejects when aborted', async () => {
    const controller = new AbortController()
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => { closed = resolve })
    harness = await startServer((socket) => {
      socket.on('close', () => closed())
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') socket.send(startedEvent())
      })
    })

    const session = await openCodexDictationSession({
      sampleRateHz: 48_000,
      signal: controller.signal,
    })
    controller.abort()
    await socketClosed
    await expectError(session.finish(), 'network')
    expect(() => session.appendPcm16(new Uint8Array())).toThrowError(
      expect.objectContaining({ code: 'network' }),
    )
  })

  it('closes an active session idempotently', async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => { closed = resolve })
    harness = await startServer((socket) => {
      socket.on('close', () => closed())
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') socket.send(startedEvent())
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    session.close()
    session.close()
    await socketClosed
    await expectError(session.finish(), 'network')
  })

  it('allows more than four MiB over time after queued audio drains', async () => {
    let resolveAudio!: () => void
    let audioReceived = new Promise<void>((resolve) => { resolveAudio = resolve })
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        if (message.type === 'session.start') socket.send(startedEvent())
        if (message.type === 'audio.append') resolveAudio()
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    session.appendPcm16(new Uint8Array(MAX_AUDIO_BYTES / 2))
    await audioReceived
    await new Promise<void>((resolve) => setImmediate(resolve))

    audioReceived = new Promise<void>((resolve) => { resolveAudio = resolve })
    expect(() => session.appendPcm16(new Uint8Array(MAX_AUDIO_BYTES / 2 + 2)))
      .not.toThrow()
    await audioReceived
    session.close()
  })

  it('rejects more than four MiB of simultaneously queued audio', async () => {
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') socket.send(startedEvent())
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    session.appendPcm16(new Uint8Array(MAX_AUDIO_BYTES))
    expect(() => session.appendPcm16(Uint8Array.from([1, 2])))
      .toThrowError(expect.objectContaining({ code: 'upstream' }))
    await expectError(session.finish(), 'upstream')
  })

  it.each([0, -1, 48_000.5, Number.NaN])(
    'rejects invalid sample rate %s before opening a websocket',
    async (sampleRateHz) => {
      await expectError(openCodexDictationSession({ sampleRateHz }), 'upstream')
      expect(websocketRedirect.requested).toEqual([])
    },
  )

  it('rejects an odd-length PCM16 chunk', async () => {
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        if (parseMessage(data).type === 'session.start') socket.send(startedEvent())
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    expect(() => session.appendPcm16(Uint8Array.from([1])))
      .toThrowError(expect.objectContaining({ code: 'upstream' }))
    await expectError(session.finish(), 'upstream')
  })

  it('never puts token, audio, transcript, or upstream detail in errors or logs', async () => {
    const logSpies = ['debug', 'error', 'info', 'log', 'warn'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    )
    harness = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = parseMessage(data)
        if (message.type === 'session.start') socket.send(startedEvent())
        if (message.type === 'session.close') {
          socket.send(JSON.stringify({
            type: 'private.terminal',
            token,
            audio: PRIVATE_AUDIO_BASE64,
            transcript: PRIVATE_TRANSCRIPT,
          }))
        }
      })
    })

    const session = await openCodexDictationSession({ sampleRateHz: 48_000 })
    session.appendPcm16(PRIVATE_AUDIO)
    const error = await expectError(session.finish(), 'upstream')
    const exposed = JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      cause: String(error.cause),
    })

    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(exposed).not.toContain(token)
    expect(exposed).not.toContain(PRIVATE_AUDIO_BASE64)
    expect(exposed).not.toContain(PRIVATE_TRANSCRIPT)
  })
})
