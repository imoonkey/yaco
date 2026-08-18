// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const checkBrowserCapabilityMock = vi.fn()
const startCaptureSessionMock = vi.fn()
const createCodexVoiceStreamMock = vi.fn()

vi.mock('../voiceCapture', () => ({
  checkBrowserCapability: () => checkBrowserCapabilityMock(),
  startCaptureSession: (...args: unknown[]) => startCaptureSessionMock(...args),
  filenameForMime: () => 'take.webm',
  MAX_RECORDING_SECONDS: 300,
}))

vi.mock('../codexVoiceStream', () => ({
  createCodexVoiceStream: () => createCodexVoiceStreamMock(),
}))

const { useVoice } = await import('../useVoice')

let fakeSession: { stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
let fakeStream: {
  start: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function okStatus({
  codex = true,
  groq = true,
  formatter = true,
}: {
  codex?: boolean
  groq?: boolean
  formatter?: boolean
} = {}) {
  return jsonResponse({
    enabled: codex || groq,
    providers: {
      codex: codex ? { available: true } : { available: false, reason: 'missing_auth' },
      groq: groq
        ? { available: true, model: 'whisper-large-v3-turbo' }
        : { available: false, reason: 'missing_api_key' },
    },
    formatter: formatter
      ? { available: true, models: ['openai/gpt-oss-120b'] }
      : { available: false, reason: 'missing_api_key' },
    maxUploadBytes: 20_000_000,
    tts: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' },
  })
}

function requestForm(init: RequestInit | undefined): FormData {
  expect(init?.body).toBeInstanceOf(FormData)
  return init!.body as FormData
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
  startCaptureSessionMock.mockImplementation(async (_callbacks, pcmSink) => {
    pcmSink?.start(48_000)
    pcmSink?.append(new Int16Array([1, 2]))
    return fakeSession
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  checkBrowserCapabilityMock.mockReturnValue({ ok: true })
  fakeStream = {
    start: vi.fn(),
    append: vi.fn(),
    finish: vi.fn(async () => null),
    close: vi.fn(),
  }
  createCodexVoiceStreamMock.mockImplementation(() => fakeStream)
  setupCapture()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useVoice single-take flow', () => {
  it('uses a non-empty Codex stream final without calling batch and formats once', async () => {
    fakeStream.finish.mockResolvedValue('stream raw')
    let transcribeCalls = 0
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) { transcribeCalls++; throw new Error('batch must not run') }
      if (url.endsWith('/voice/format')) {
        formatCalls++
        return jsonResponse({ displayText: 'Stream raw.', formattingStatus: 'formatted' })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(fakeStream.start).toHaveBeenCalledWith(48_000)
    expect(fakeStream.append).toHaveBeenCalledTimes(1)
    expect(fakeStream.finish).toHaveBeenCalledTimes(1)
    expect(transcribeCalls).toBe(0)
    expect(formatCalls).toBe(1)
    expect(hook.result.current.appendText?.text).toBe('Stream raw.')
  })

  it('finishes the drained stream before capture release completes', async () => {
    const events: string[] = []
    let resolveRelease: () => void = () => {}
    fakeSession = {
      stop: vi.fn(async () => {
        events.push('drain-done')
        return new Blob(['audio'], { type: 'audio/webm' })
      }),
      release: vi.fn(() => new Promise<void>(resolve => {
        events.push('release-started')
        resolveRelease = resolve
      })),
    }
    startCaptureSessionMock.mockImplementation(async (_callbacks, pcmSink) => {
      pcmSink?.start(48_000)
      return fakeSession
    })
    fakeStream.finish.mockImplementation(() => {
      events.push('finish-called')
      return Promise.resolve('stream raw')
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) throw new Error('batch must not run')
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Stream raw.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(events).toEqual(['drain-done', 'finish-called', 'release-started']))
    expect(hook.result.current.state).toBe('transcribing')

    act(() => resolveRelease())
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
  })

  it.each([
    ['unavailable stream', null],
    ['empty stream final', '   '],
  ])('falls back from %s to cached-Blob Codex batch exactly once', async (_label, streamText) => {
    fakeStream.finish.mockResolvedValue(streamText)
    const forms: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        forms.push(requestForm(init))
        return jsonResponse({ text: 'batch raw' })
      }
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Batch raw.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(forms).toHaveLength(1)
    expect(forms[0].get('provider')).toBe('codex')
    expect(await (forms[0].get('audio') as File).text()).toBe('audio')
    expect(hook.result.current.appendText?.text).toBe('Batch raw.')
  })

  it('keeps Groq batch-only and does not create a stream or PCM sink', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        forms.push(requestForm(init))
        return jsonResponse({ text: 'groq raw' })
      }
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Groq raw.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    act(() => hook.result.current.setProvider('groq'))
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(createCodexVoiceStreamMock).not.toHaveBeenCalled()
    expect(startCaptureSessionMock.mock.calls[0][1]).toBeUndefined()
    expect(forms).toHaveLength(1)
    expect(forms[0].get('provider')).toBe('groq')
  })

  it.each([
    ['non-empty', 'stale final'],
    ['unavailable', null],
  ])('drops a stale %s stream final before batch or formatting can run', async (_label, staleFinal) => {
    let resolveFinal: (text: string | null) => void = () => {}
    fakeStream.finish.mockImplementation(() => new Promise(resolve => { resolveFinal = resolve }))
    let transcribeCalls = 0
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) { transcribeCalls++; return jsonResponse({ text: 'stale batch' }) }
      if (url.endsWith('/voice/format')) { formatCalls++; return jsonResponse({ displayText: 'Stale.' }) }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('transcribing'))
    act(() => hook.result.current.discard())
    act(() => resolveFinal(staleFinal))
    await waitFor(() => expect(hook.result.current.state).toBe('idle'))

    expect(fakeStream.close).toHaveBeenCalledTimes(1)
    expect(transcribeCalls).toBe(0)
    expect(formatCalls).toBe(0)
    expect(hook.result.current.appendText).toBeNull()
  })

  it('defaults to Codex and sends the explicit captured provider', async () => {
    const transcribeForms: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        transcribeForms.push(requestForm(init))
        return jsonResponse({ text: 'raw words' })
      }
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Raw words.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    expect(hook.result.current.availableProviders).toEqual(['codex', 'groq'])
    expect(hook.result.current.provider).toBe('codex')
    expect(localStorage.getItem('yaco.voiceProvider')).toBe('codex')

    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(transcribeForms[0].get('provider')).toBe('codex')
  })

  it('restores an available provider and persists provider and auto-format changes', async () => {
    localStorage.setItem('yaco.voiceProvider', 'groq')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/voice/status')) return okStatus()
      throw new Error(`unexpected fetch ${String(input)}`)
    }))

    const hook = await renderReadyVoice()
    expect(hook.result.current.provider).toBe('groq')

    act(() => {
      hook.result.current.setProvider('codex')
      hook.result.current.setAutoFormat(false)
    })
    expect(hook.result.current.provider).toBe('codex')
    expect(hook.result.current.autoFormat).toBe(false)
    expect(localStorage.getItem('yaco.voiceProvider')).toBe('codex')
    expect(localStorage.getItem('yaco.voiceAutoFormat')).toBe('0')
  })

  it('locks provider and auto-format while a take is in flight', async () => {
    const providers: FormDataEntryValue[] = []
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        providers.push(requestForm(init).get('provider')!)
        return jsonResponse({ text: 'frozen take' })
      }
      if (url.endsWith('/voice/format')) {
        formatCalls++
        return jsonResponse({ displayText: 'Frozen take.', formattingStatus: 'formatted' })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    act(() => hook.result.current.record({ surface: 'editor', filePath: 'src/app.ts' }))
    await waitFor(() => expect(hook.result.current.state).toBe('recording'))
    act(() => {
      hook.result.current.setProvider('groq')
      hook.result.current.setAutoFormat(false)
      hook.result.current.stop()
    })
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(providers).toEqual(['codex'])
    expect(formatCalls).toBe(1)
  })

  it('reconciles an unavailable persisted provider to the first available provider', async () => {
    localStorage.setItem('yaco.voiceProvider', 'groq')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/voice/status')) return okStatus({ groq: false, formatter: false })
      throw new Error(`unexpected fetch ${String(input)}`)
    }))

    const hook = await renderReadyVoice()
    expect(hook.result.current.availableProviders).toEqual(['codex'])
    expect(hook.result.current.provider).toBe('codex')
    expect(localStorage.getItem('yaco.voiceProvider')).toBe('codex')
  })

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

  it('retries the same cached audio with the provider explicitly selected after error', async () => {
    const requests: Array<{ provider: FormDataEntryValue | null; audio: Uint8Array }> = []
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        const form = requestForm(init)
        const audio = form.get('audio') as File
        requests.push({
          provider: form.get('provider'),
          audio: new Uint8Array(await audio.arrayBuffer()),
        })
        return requests.length === 1
          ? jsonResponse({ error: 'boom' }, { status: 502 })
          : jsonResponse({ text: 'recovered raw' })
      }
      if (url.endsWith('/voice/format')) {
        formatCalls++
        return jsonResponse({ displayText: 'Recovered.', formattingStatus: 'formatted' })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('error'))

    act(() => {
      hook.result.current.setProvider('groq')
      hook.result.current.setAutoFormat(false)
    })
    act(() => hook.result.current.retry())
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))

    expect(requests.map(request => request.provider)).toEqual(['codex', 'groq'])
    expect(requests[1].audio).toEqual(requests[0].audio)
    expect(hook.result.current.appendText?.text).toBe('recovered raw')
    expect(formatCalls).toBe(0)
  })

  it('does not format when auto-format is off', async () => {
    localStorage.setItem('yaco.voiceAutoFormat', '0')
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) return jsonResponse({ text: 'raw words here' })
      if (url.endsWith('/voice/format')) { formatCalls++; return jsonResponse({ displayText: 'Formatted.' }) }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(hook.result.current.appendText?.text).toBe('raw words here')
    expect(formatCalls).toBe(0)
  })

  it('keeps raw transcription and refuses manual formatting when formatter is unavailable', async () => {
    let formatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus({ formatter: false })
      if (url.endsWith('/voice/transcribe')) return jsonResponse({ text: 'raw only' })
      if (url.endsWith('/voice/format')) { formatCalls++; return jsonResponse({ displayText: 'should not happen' }) }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    expect(hook.result.current.formatterAvailable).toBe(false)
    expect(hook.result.current.autoFormat).toBe(false)
    expect(localStorage.getItem('yaco.voiceAutoFormat')).toBeNull()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(hook.result.current.appendText?.text).toBe('raw only')
    expect(await hook.result.current.format('manual words')).toEqual({ text: 'manual words', ok: false })
    expect(formatCalls).toBe(0)
  })

  it('preserves auto-format preference across temporary formatter unavailability', async () => {
    let formatterAvailable = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/voice/status')) {
        return okStatus({ formatter: formatterAvailable })
      }
      throw new Error(`unexpected fetch ${String(input)}`)
    }))

    const first = await renderReadyVoice()
    expect(first.result.current.autoFormat).toBe(false)
    expect(localStorage.getItem('yaco.voiceAutoFormat')).toBeNull()
    first.unmount()

    formatterAvailable = true
    const second = await renderReadyVoice()
    expect(second.result.current.formatterAvailable).toBe(true)
    expect(second.result.current.autoFormat).toBe(true)
  })

  it('reports an invalid status response separately from an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ enabled: true })))

    const hook = renderHook(() => useVoice())
    await waitFor(() => expect(hook.result.current.capability).toEqual({
      status: 'unavailable',
      reason: 'server',
      message: 'Voice service returned an invalid status.',
    }))
  })

  it('preserves the exact single 429 retry with the captured provider', async () => {
    const providers: FormDataEntryValue[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/voice/status')) return okStatus()
      if (url.endsWith('/voice/transcribe')) {
        providers.push(requestForm(init).get('provider')!)
        return providers.length === 1
          ? jsonResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } })
          : jsonResponse({ text: 'second try' })
      }
      if (url.endsWith('/voice/format')) return jsonResponse({ displayText: 'Second try.', formattingStatus: 'formatted' })
      throw new Error(`unexpected fetch ${url}`)
    }))

    const hook = await renderReadyVoice()
    await recordThenStop(hook)
    await waitFor(() => expect(hook.result.current.state).toBe('composing'))
    expect(providers).toEqual(['codex', 'codex'])
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
