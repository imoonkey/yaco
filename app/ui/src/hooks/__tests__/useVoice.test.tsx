// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

type FakeVadCallbacks = {
  onChunk: (wav: Blob, index: number) => void
  onElapsed?: (ms: number) => void
  onError?: (message: string) => void
}

const checkBrowserCapabilityMock = vi.fn()
const startVadSessionMock = vi.fn()

vi.mock('../voiceVad', () => ({
  checkBrowserCapability: () => checkBrowserCapabilityMock(),
  startVadSession: (...args: unknown[]) => startVadSessionMock(...args),
  MAX_RECORDING_SECONDS: 300,
}))

const { useVoice } = await import('../useVoice')

let callbacks: FakeVadCallbacks
let fakeSession: { stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function okStatus() {
  return jsonResponse({
    enabled: true,
    sttModel: 'whisper-large-v3-turbo',
    formatterModel: 'llama',
    maxUploadBytes: 20_000_000,
  })
}

async function renderReadyVoice() {
  const hook = renderHook(() => useVoice())
  await waitFor(() => expect(hook.result.current.capability.status).toBe('ready'))
  return hook
}

async function startReady(hook: ReturnType<typeof renderHook<ReturnType<typeof useVoice>, unknown>>) {
  act(() => hook.result.current.start({ surface: 'editor', filePath: 'src/app.ts' }))
  await waitFor(() => expect(hook.result.current.state).toBe('active'))
}

function setupVadSession() {
  callbacks = undefined as unknown as FakeVadCallbacks
  fakeSession = {
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  }
  startVadSessionMock.mockImplementation(async (_maxBytes: number, cbs: FakeVadCallbacks) => {
    callbacks = cbs
    return fakeSession
  })
}

beforeEach(() => {
  checkBrowserCapabilityMock.mockReturnValue({ ok: true })
  setupVadSession()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useVoice streaming flow', () => {
  it('transcribes chunks live, stops VAD, then formats once', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) return jsonResponse({ text: 'hello world' })
      if (url.endsWith('/voice/format')) return jsonResponse({
        displayText: 'Hello world.',
        formattingStatus: 'formatted',
      })
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const hook = await renderReadyVoice()
    await startReady(hook)

    act(() => callbacks.onChunk(new Blob(['wav'], { type: 'audio/wav' }), 0))
    await waitFor(() => expect(hook.result.current.liveTranscript).toBe('hello world'))
    expect(hook.result.current.pendingCount).toBe(0)

    act(() => hook.result.current.stop())
    await waitFor(() => expect(fakeSession.stop).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(fakeSession.release).toHaveBeenCalledTimes(1)
    expect(hook.result.current.compose).toEqual({
      rawText: 'hello world',
      displayText: 'Hello world.',
      formattingStatus: 'formatted',
    })
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/voice/format'))).toHaveLength(1)
  })

  it('drops a chunk on /transcribe timeout and fails only after finalization sees all chunks failed', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return Promise.resolve(okStatus())
      if (url.endsWith('/voice/transcribe')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const hook = await renderReadyVoice()
    await startReady(hook)

    vi.useFakeTimers()
    act(() => callbacks.onChunk(new Blob(['wav'], { type: 'audio/wav' }), 0))
    expect(hook.result.current.pendingCount).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(hook.result.current.pendingCount).toBe(0)

    act(() => hook.result.current.stop())
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.state).toBe('error')
    expect(hook.result.current.errorMessage).toBe('Transcription failed. Try again.')
  })

  it('honors retry-after on 429 before retrying a chunk', async () => {
    let transcribeCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        transcribeCalls += 1
        if (transcribeCalls === 1) {
          return jsonResponse({ error: 'rate limit' }, { status: 429, headers: { 'retry-after': '1' } })
        }
        return jsonResponse({ text: 'after retry' })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const hook = await renderReadyVoice()
    await startReady(hook)

    vi.useFakeTimers()
    act(() => callbacks.onChunk(new Blob(['wav'], { type: 'audio/wav' }), 0))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transcribeCalls).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(transcribeCalls).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    vi.useRealTimers()
    await waitFor(() => expect(hook.result.current.liveTranscript).toBe('after retry'))
  })

  it('throttles /transcribe to 20 requests per rolling minute', async () => {
    let transcribeCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        transcribeCalls += 1
        return jsonResponse({ text: `chunk ${transcribeCalls}` })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const hook = await renderReadyVoice()
    await startReady(hook)

    vi.useFakeTimers()
    act(() => {
      for (let i = 0; i < 21; i++) {
        callbacks.onChunk(new Blob(['wav'], { type: 'audio/wav' }), i)
      }
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transcribeCalls).toBe(20)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001)
    })
    expect(transcribeCalls).toBe(21)
  })

  it('releases a VAD session that resolves after unmount', async () => {
    let resolveSession: (session: typeof fakeSession) => void = () => {}
    startVadSessionMock.mockImplementation((_maxBytes: number, cbs: FakeVadCallbacks) => {
      callbacks = cbs
      return new Promise(resolve => { resolveSession = resolve })
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    act(() => hook.result.current.start({ surface: 'terminal' }))
    await waitFor(() => expect(hook.result.current.state).toBe('requesting_permission'))

    hook.unmount()
    await act(async () => {
      resolveSession(fakeSession)
      await Promise.resolve()
    })

    await waitFor(() => expect(fakeSession.release).toHaveBeenCalledTimes(1))
  })
})
