// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'

// SUPPORTED is evaluated when useSpeech is imported, off the global `Audio`
// constructor — which jsdom doesn't expose by default. So we stub the browser
// audio globals FIRST, then import the module fresh in each test.
let useSpeech: typeof import('../useSpeech').useSpeech

// --- Browser audio stubs -----------------------------------------------------
// jsdom implements none of <audio> playback, URL.createObjectURL, or the Web
// Speech API, so we install controllable fakes and observe the calls.

type FakeAudio = { src: string; play: Mock; pause: Mock }
let audioEl: FakeAudio
let speech: { speak: Mock; cancel: Mock }
let fetchMock: Mock
let urlCounter: number

/** A constructable <audio> stub: each `new Audio()` captures itself into `audioEl`
 *  (the hook only ever creates one) with observable play/pause. */
class FakeAudioElement {
  src = ''
  play = vi.fn(() => Promise.resolve())
  pause = vi.fn()
  constructor() { audioEl = this as unknown as FakeAudio }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function audioResponse(bytes: number[] = [1, 2, 3], status = 200): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
}

beforeEach(async () => {
  urlCounter = 0
  localStorage.clear()

  vi.stubGlobal('Audio', FakeAudioElement)

  speech = { speak: vi.fn(), cancel: vi.fn() }
  vi.stubGlobal('speechSynthesis', speech)
  vi.stubGlobal('SpeechSynthesisUtterance', vi.fn(function (this: Record<string, unknown>, text: string) {
    this.text = text
    this.lang = ''
    this.volume = 1
  }))

  URL.createObjectURL = vi.fn(() => `blob:fake-${++urlCounter}`)
  URL.revokeObjectURL = vi.fn()

  fetchMock = vi.fn(async () => audioResponse())
  vi.stubGlobal('fetch', fetchMock)

  vi.resetModules()
  ;({ useSpeech } = await import('../useSpeech'))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Enable read-back (a gesture: primes both paths), then clear the prime-time
 *  calls so a test asserts only what its `speak` produced. */
function enable(result: { current: ReturnType<typeof useSpeech> }) {
  act(() => result.current.setEnabled(true))
  audioEl.play.mockClear()
  audioEl.pause.mockClear()
  speech.speak.mockClear()
  speech.cancel.mockClear()
}

describe('useSpeech', () => {
  it('reports supported when the browser can play audio', () => {
    const { result } = renderHook(() => useSpeech())
    expect(result.current.supported).toBe(true)
  })

  it('persists and primes both paths when enabled from a gesture', () => {
    const { result } = renderHook(() => useSpeech())
    act(() => result.current.setEnabled(true))
    expect(result.current.enabled).toBe(true)
    expect(localStorage.getItem('yaco.voiceReadback')).toBe('1')
    // <audio> unlock + speechSynthesis unlock both attempted in the gesture.
    expect(audioEl.play).toHaveBeenCalled()
    expect(speech.speak).toHaveBeenCalled()
  })

  it('plays server neural audio and does not use the browser fallback', async () => {
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('Done. Refactored the parser.'))

    await waitFor(() => expect(audioEl.play).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/voice/speak'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(audioEl.src).toMatch(/^blob:/)
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('falls back to browser TTS on a 502', async () => {
    fetchMock.mockResolvedValueOnce(audioResponse([], 502))
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('Crashed (exit 1)'))

    await waitFor(() => expect(speech.speak).toHaveBeenCalledTimes(1))
    expect(speech.speak.mock.calls[0][0].text).toBe('Crashed (exit 1)')
    expect(audioEl.play).not.toHaveBeenCalled()
  })

  it('falls back to browser TTS on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('Your turn'))

    await waitFor(() => expect(speech.speak).toHaveBeenCalledTimes(1))
    expect(speech.speak.mock.calls[0][0].text).toBe('Your turn')
  })

  it('falls back to browser TTS when audio playback is rejected (unprimed)', async () => {
    const { result } = renderHook(() => useSpeech())
    enable(result)
    audioEl.play.mockReturnValueOnce(Promise.reject(new Error('not allowed')))

    act(() => result.current.speak('Needs approval'))

    await waitFor(() => expect(speech.speak).toHaveBeenCalledTimes(1))
    expect(speech.speak.mock.calls[0][0].text).toBe('Needs approval')
  })

  it('does NOT fall back over a newer speak when a stale request resolves late', async () => {
    const slow = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(slow.promise) // speak A — left pending
      .mockResolvedValueOnce(audioResponse()) // speak B — neural success
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('A — stale'))
    act(() => result.current.speak('B — newest'))
    await waitFor(() => expect(audioEl.play).toHaveBeenCalledTimes(1)) // B played
    speech.speak.mockClear()

    // The stale request now resolves with a failure — the generation guard must
    // suppress its browser fallback so it can't talk over B's fresh audio.
    await act(async () => {
      slow.resolve(audioResponse([], 502))
      await Promise.resolve()
    })
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('does not resurrect a stale speak across an off→on toggle', async () => {
    const slow = deferred<Response>()
    fetchMock.mockReturnValueOnce(slow.promise)
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('stale across toggle'))
    // Toggle off, then back on, while the request is still in flight. Re-enabling
    // flips enabledRef back true — the generation bump must keep the stale branch dead.
    act(() => result.current.setEnabled(false))
    act(() => result.current.setEnabled(true))
    audioEl.play.mockClear()
    speech.speak.mockClear()

    await act(async () => {
      slow.resolve(audioResponse([], 502))
      await Promise.resolve()
    })
    expect(speech.speak).not.toHaveBeenCalled()
    expect(audioEl.play).not.toHaveBeenCalled()
  })

  it('never falls back on an AbortError', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('aborted notice'))
    await act(async () => { await Promise.resolve() })
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('toggle-off pauses audio, cancels speech, and revokes the object URL', async () => {
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('Done.'))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())

    act(() => result.current.setEnabled(false))
    expect(audioEl.pause).toHaveBeenCalled()
    expect(speech.cancel).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    expect(result.current.enabled).toBe(false)
  })

  it('does not speak when disabled', () => {
    const { result } = renderHook(() => useSpeech())
    act(() => result.current.speak('ignored'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('primes both paths on the first pointerdown when enabled was restored from storage', () => {
    localStorage.setItem('yaco.voiceReadback', '1')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.enabled).toBe(true)
    // No gesture yet → not primed; the next pointerdown unlocks both paths.
    act(() => { window.dispatchEvent(new Event('pointerdown')) })
    expect(audioEl.play).toHaveBeenCalled()
    expect(speech.speak).toHaveBeenCalled()
  })

  it('still speaks under StrictMode when enabled was restored from storage', async () => {
    // StrictMode runs the unmount cleanup once at mount (setup→cleanup→setup). That
    // cleanup must NOT clear enabledRef, or speak() would no-op while the icon shows
    // enabled (restored from storage, no fresh toggle to re-set the ref).
    localStorage.setItem('yaco.voiceReadback', '1')
    const { result } = renderHook(() => useSpeech(), { wrapper: StrictMode })
    expect(result.current.enabled).toBe(true)
    act(() => result.current.speak('Done.'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('does nothing on a 204 (nothing to say): no audio, no fallback', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const { result } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('whitespace-only after rewrite'))
    await act(async () => { await Promise.resolve() })
    expect(audioEl.play).not.toHaveBeenCalled()
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('does not fall back when play() rejects with an AbortError', async () => {
    const { result } = renderHook(() => useSpeech())
    enable(result)
    audioEl.play.mockReturnValueOnce(Promise.reject(new DOMException('interrupted', 'AbortError')))

    act(() => result.current.speak('Done.'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('fully preempts on unmount (pause + cancel + revoke)', async () => {
    const { result, unmount } = renderHook(() => useSpeech())
    enable(result)

    act(() => result.current.speak('Done.'))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())

    unmount()
    expect(audioEl.pause).toHaveBeenCalled()
    expect(speech.cancel).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})
