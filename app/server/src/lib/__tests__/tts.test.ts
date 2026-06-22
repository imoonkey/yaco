import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { PassThrough } from 'node:stream'

// Mock the unofficial edge-tts client: we drive a fake audio stream and assert
// the collect / cleanup behavior without opening a real WSS connection.
let mockSetMetadata: Mock
let mockToStream: Mock
let mockClose: Mock

vi.mock('msedge-tts', () => ({
  MsEdgeTTS: class {
    setMetadata(...args: unknown[]) { return mockSetMetadata(...args) }
    toStream(...args: unknown[]) { return mockToStream(...args) }
    close() { return mockClose() }
  },
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' },
}))

import { synthesizeSpeech, resolveTtsVoice, escapeForSsml } from '../tts'

/** Let the internal `await setMetadata` microtask resolve so the stream
 *  listeners are attached before the test emits. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  mockSetMetadata = vi.fn().mockResolvedValue(undefined)
  mockClose = vi.fn()
  mockToStream = vi.fn()
})

afterEach(() => {
  // Always restore real timers, even if a fake-timer test bailed mid-assertion.
  vi.useRealTimers()
})

describe('resolveTtsVoice', () => {
  afterEach(() => { delete process.env.VOICE_TTS_VOICE })

  it('defaults to the zh-CN Xiaoxiao neural voice', () => {
    delete process.env.VOICE_TTS_VOICE
    expect(resolveTtsVoice()).toBe('zh-CN-XiaoxiaoNeural')
  })

  it('honors VOICE_TTS_VOICE override', () => {
    process.env.VOICE_TTS_VOICE = 'en-US-AvaMultilingualNeural'
    expect(resolveTtsVoice()).toBe('en-US-AvaMultilingualNeural')
  })

  it('falls back to default for a blank override', () => {
    process.env.VOICE_TTS_VOICE = '   '
    expect(resolveTtsVoice()).toBe('zh-CN-XiaoxiaoNeural')
  })
})

describe('escapeForSsml', () => {
  it('escapes the five XML entities (ampersand first)', () => {
    expect(escapeForSsml('a < b & > "c" \'d\'')).toBe('a &lt; b &amp; &gt; &quot;c&quot; &apos;d&apos;')
  })

  it('does not double-escape an ampersand into a broken entity', () => {
    expect(escapeForSsml('A & B')).toBe('A &amp; B')
  })
})

describe('synthesizeSpeech', () => {
  it('sets the voice + mp3 format and collects the audio stream into a Buffer', async () => {
    const stream = new PassThrough()
    mockToStream.mockReturnValue({ audioStream: stream, metadataStream: null })

    const promise = synthesizeSpeech('hello', 'voice-x')
    stream.write(Buffer.from([1, 2]))
    stream.write(Buffer.from([3]))
    stream.end()

    const buffer = await promise
    expect([...buffer]).toEqual([1, 2, 3])
    expect(mockSetMetadata).toHaveBeenCalledWith('voice-x', 'audio-24khz-48kbitrate-mono-mp3')
    expect(mockClose).toHaveBeenCalled()
  })

  it('XML-escapes the text before handing it to the SSML builder', async () => {
    const stream = new PassThrough()
    mockToStream.mockReturnValue({ audioStream: stream, metadataStream: null })

    const promise = synthesizeSpeech('a < b & "c"', 'v')
    stream.end(Buffer.from([1]))
    await promise

    expect(mockToStream).toHaveBeenCalledWith('a &lt; b &amp; &quot;c&quot;')
  })

  it('rejects when the stream ends with no audio', async () => {
    const stream = new PassThrough()
    mockToStream.mockReturnValue({ audioStream: stream, metadataStream: null })

    const promise = synthesizeSpeech('hello', 'v')
    stream.end()
    await expect(promise).rejects.toThrow(/no audio/i)
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects and tears down the stream + socket on a stream error', async () => {
    const stream = new PassThrough()
    const destroy = vi.spyOn(stream, 'destroy')
    mockToStream.mockReturnValue({ audioStream: stream, metadataStream: null })

    const promise = synthesizeSpeech('hello', 'v')
    await flush()
    stream.emit('error', new Error('socket boom'))

    await expect(promise).rejects.toThrow('socket boom')
    expect(destroy).toHaveBeenCalled()
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects and closes the socket when setMetadata fails (connect error)', async () => {
    mockSetMetadata.mockRejectedValue(new Error('connect fail'))
    await expect(synthesizeSpeech('hi', 'v')).rejects.toThrow('connect fail')
    expect(mockClose).toHaveBeenCalled()
    expect(mockToStream).not.toHaveBeenCalled()
  })

  it('rejects and cleans up when synthesis exceeds the timeout', async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    const destroy = vi.spyOn(stream, 'destroy')
    mockToStream.mockReturnValue({ audioStream: stream, metadataStream: null })

    const promise = synthesizeSpeech('hello', 'v')
    const assertion = expect(promise).rejects.toThrow(/timed out/i)
    // Drain the setMetadata microtask, then trip the timeout.
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(destroy).toHaveBeenCalled()
    expect(mockClose).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('times out and closes the socket when the WSS connect hangs', async () => {
    vi.useFakeTimers()
    // setMetadata (the connect) never settles — the single timer must still fire.
    mockSetMetadata.mockReturnValue(new Promise<void>(() => {}))

    const promise = synthesizeSpeech('hello', 'v')
    const assertion = expect(promise).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(mockClose).toHaveBeenCalled()
    expect(mockToStream).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
