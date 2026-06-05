import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  VadCoalescer,
  encodeWav,
  CHUNK_TARGET_SECONDS,
  MIN_FLUSH_INTERVAL_MS,
  startVadSession,
} from '../voiceVad'

const SAMPLE_RATE = 16000
const TEN_SEC = CHUNK_TARGET_SECONDS * SAMPLE_RATE
const BIG_MAX_BYTES = 20_000_000 // server cap; non-binding at 10s chunks

// One utterance of `seconds` worth of 16kHz samples (value is irrelevant here).
function utterance(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.5)
}

// blob.size for an N-sample PCM16 mono WAV.
function wavSize(samples: number): number {
  return 44 + samples * 2
}

function stubAudioContext() {
  const close = vi.fn(async () => {})
  class FakeAudioContext {
    state: AudioContextState = 'running'
    close = close
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return close
}

describe('encodeWav', () => {
  it('produces a PCM16 mono WAV blob of the right size and type', () => {
    const blob = encodeWav(utterance(1))
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(wavSize(SAMPLE_RATE))
  })
})

describe('VadCoalescer — size-driven flush', () => {
  it('buffers utterances under the target and flushes at ~10s', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)

    expect(c.push(utterance(4), 4000)).toBe(false)
    expect(c.push(utterance(4), 8000)).toBe(false)
    expect(emit).not.toHaveBeenCalled()

    // Crossing 10s flushes one coalesced chunk of everything buffered.
    expect(c.push(utterance(4), 12000)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    const [wav, index] = emit.mock.calls[0]
    expect(index).toBe(0)
    expect(wav.size).toBe(wavSize(12 * SAMPLE_RATE))
  })

  it('assigns monotonic indices across successive flushes', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)
    c.push(utterance(11), 11000) // flush 0
    c.push(utterance(11), 30000) // flush 1
    expect(emit.mock.calls.map(call => call[1])).toEqual([0, 1])
  })
})

describe('VadCoalescer — rate-gated pause flush', () => {
  it('gates a sub-10s pause flush until the min interval clears', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)

    c.push(utterance(3), 3000)
    // Only 4s since the start baseline — under the floor: keep buffering.
    expect(c.tryPauseFlush(4000)).toBe('gated')
    expect(emit).not.toHaveBeenCalled()

    // Past the floor: the buffered remainder flushes as one chunk.
    expect(c.tryPauseFlush(MIN_FLUSH_INTERVAL_MS + 1)).toBe('flushed')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][1]).toBe(0)
  })

  it('reports empty when there is nothing buffered', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)
    expect(c.tryPauseFlush(60000)).toBe('empty')
    expect(emit).not.toHaveBeenCalled()
  })

  it('re-floors the rate gate from the last flush, not session start', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)

    c.push(utterance(11), 11000) // flush 0 at t=11000, lastFlush=11000
    c.push(utterance(2), 14000) // buffered
    // 3s after the last flush — gated despite being far past session start.
    expect(c.tryPauseFlush(14000)).toBe('gated')
    expect(c.tryPauseFlush(11000 + MIN_FLUSH_INTERVAL_MS)).toBe('flushed')
    expect(emit.mock.calls.map(call => call[1])).toEqual([0, 1])
  })
})

describe('VadCoalescer — final flush', () => {
  it('flushes the remainder immediately, ignoring the rate floor', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)

    c.push(utterance(11), 11000) // flush 0
    c.push(utterance(2), 13000) // buffered; well under the 10s floor
    expect(c.flushRemainder(13500)).toBe(true) // final chunk is immediate
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][1]).toBe(1)
    expect(emit.mock.calls[1][0].size).toBe(wavSize(2 * SAMPLE_RATE))
  })

  it('emits nothing when the buffer is empty at stop', () => {
    const emit = vi.fn()
    const c = new VadCoalescer(BIG_MAX_BYTES, 0, emit)
    expect(c.flushRemainder(1000)).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('VadCoalescer — byte cap', () => {
  it('flushes early when the buffer would exceed the per-request byte cap', () => {
    const emit = vi.fn()
    // Cap at ~2s of audio so the target (10s) never governs.
    const twoSecBytes = wavSize(2 * SAMPLE_RATE)
    const c = new VadCoalescer(twoSecBytes, 0, emit)
    expect(c.push(utterance(2), 2000)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(TEN_SEC).toBeGreaterThan(2 * SAMPLE_RATE) // target would not have fired
  })
})

describe('startVadSession lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('flushes speech emitted by pause() before stop resolves', async () => {
    stubAudioContext()
    let options: { onSpeechEnd: (audio: Float32Array) => void } | null = null
    const vad = {
      pause: vi.fn(async () => {
        options?.onSpeechEnd(utterance(2))
      }),
      destroy: vi.fn(async () => {}),
    }
    const onChunk = vi.fn()
    const session = await startVadSession(BIG_MAX_BYTES, { onChunk }, async () => ({
      MicVAD: { new: vi.fn(async (opts) => {
        options = opts as typeof options
        return vad
      }) },
    }))

    await session.stop()

    expect(vad.pause).toHaveBeenCalledTimes(1)
    expect(onChunk).toHaveBeenCalledTimes(1)
    expect(onChunk.mock.calls[0][0].size).toBe(wavSize(2 * SAMPLE_RATE))
    expect(onChunk.mock.calls[0][1]).toBe(0)
  })

  it('ignores speech callbacks fired during release()', async () => {
    const closeAudioContext = stubAudioContext()
    let options: { onSpeechEnd: (audio: Float32Array) => void } | null = null
    const vad = {
      pause: vi.fn(async () => {}),
      destroy: vi.fn(async () => {
        options?.onSpeechEnd(utterance(11))
      }),
    }
    const onChunk = vi.fn()
    const session = await startVadSession(BIG_MAX_BYTES, { onChunk }, async () => ({
      MicVAD: { new: vi.fn(async (opts) => {
        options = opts as typeof options
        return vad
      }) },
    }))

    await session.release()

    expect(vad.destroy).toHaveBeenCalledTimes(1)
    expect(onChunk).not.toHaveBeenCalled()
    expect(closeAudioContext).toHaveBeenCalledTimes(1)
  })

  it('stops an acquired mic stream when MicVAD init fails', async () => {
    const closeAudioContext = stubAudioContext()
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    await expect(startVadSession(BIG_MAX_BYTES, { onChunk: vi.fn() }, async () => ({
      MicVAD: { new: vi.fn(async (opts) => {
        expect(opts.processorType).toBe('AudioWorklet')
        await opts.getStream?.()
        throw new Error('worklet failed')
      }) },
    }))).rejects.toThrow('worklet failed')

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(closeAudioContext).toHaveBeenCalledTimes(1)
  })
})
