// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const checkBrowserCapabilityMock = vi.fn()
const startCaptureSessionMock = vi.fn()

vi.mock('../voiceCapture', () => ({
  checkBrowserCapability: () => checkBrowserCapabilityMock(),
  startCaptureSession: (...args: unknown[]) => startCaptureSessionMock(...args),
  filenameForMime: () => 'take.webm',
  MAX_RECORDING_SECONDS: 300,
}))

const { useVoice } = await import('../useVoice')

let fakeSession: { stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function okStatus() {
  return jsonResponse({ enabled: true, sttModel: 'whisper-large-v3-turbo', maxUploadBytes: 20_000_000 })
}

async function renderReadyVoice() {
  const hook = renderHook(() => useVoice())
  await waitFor(() => expect(hook.result.current.capability.status).toBe('ready'))
  return hook
}

async function recordThenStop(hook: ReturnType<typeof renderHook<ReturnType<typeof useVoice>, unknown>>) {
  act(() => hook.result.current.record({ surface: 'editor', filePath: 'src/app.ts' }))
  await waitFor(() => expect(hook.result.current.state).toBe('recording'))
  act(() => hook.result.current.stop())
}

function setupCapture(stopBlob: Blob | null = new Blob(['audio'], { type: 'audio/webm' })) {
  fakeSession = {
    stop: vi.fn(async () => stopBlob),
    release: vi.fn(async () => {}),
  }
  startCaptureSessionMock.mockImplementation(async () => fakeSession)
}

beforeEach(() => {
  checkBrowserCapabilityMock.mockReturnValue({ ok: true })
  setupCapture()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useVoice single-take flow', () => {
  it('records one take, transcribes once, formats, and appends', async () => {
    let transcribeCalls = 0
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) { transcribeCalls++; return jsonResponse({ text: 'hello world' }) }
      if (url.endsWith('/voice/format')) { formatCalls++; return jsonResponse({ displayText: 'Hello world.', formattingStatus: 'formatted' }) }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)

    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(fakeSession.release).toHaveBeenCalledTimes(1)
    expect(hook.result.current.appendText?.text).toBe('Hello world.')
    expect(transcribeCalls).toBe(1)
    expect(formatCalls).toBe(1)
  })

  it('keeps the cached take and re-sends it on Retry after a transcribe failure', async () => {
    let transcribeCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        transcribeCalls++
        return transcribeCalls === 1
          ? jsonResponse({ error: 'boom' }, { status: 500 })
          : jsonResponse({ text: 'recovered' })
      }
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Recovered.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('error'))

    act(() => hook.result.current.retry())
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(hook.result.current.appendText?.text).toBe('Recovered.')
    expect(transcribeCalls).toBe(2)
  })

  it('falls back to the raw transcript when /format fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) return jsonResponse({ text: 'raw words here' })
      if (url.endsWith('/voice/format')) return jsonResponse({ error: 'down' }, { status: 500 })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(hook.result.current.appendText?.text).toBe('raw words here')
  })

  it('shows a no-speech notice for an empty take without calling /transcribe', async () => {
    setupCapture(null) // stop() yields nothing recorded
    let transcribeCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) { transcribeCalls++; return jsonResponse({ text: '' }) }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(hook.result.current.notice).toBe('No speech detected.')
    expect(transcribeCalls).toBe(0)
  })

  it('releases a capture session that resolves after unmount', async () => {
    let resolveSession: (session: typeof fakeSession) => void = () => {}
    startCaptureSessionMock.mockImplementation(() => new Promise(resolve => { resolveSession = resolve }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    act(() => hook.result.current.record({ surface: 'terminal', sessionName: 's1' }))
    await waitFor(() => expect(hook.result.current.state).toBe('requesting_permission'))

    hook.unmount()
    await act(async () => {
      resolveSession(fakeSession)
      await Promise.resolve()
    })
    await waitFor(() => expect(fakeSession.release).toHaveBeenCalledTimes(1))
  })
})
