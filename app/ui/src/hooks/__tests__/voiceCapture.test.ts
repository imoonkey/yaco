// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startCaptureSession, filenameForMime, checkBrowserCapability } from '../voiceCapture'

// Minimal MediaRecorder fake: stop() synchronously delivers a chunk then onstop,
// which is enough to exercise the session's finalize/idempotency paths.
class FakeMediaRecorder {
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus'
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_stream: MediaStream, opts?: MediaRecorderOptions) {
    this.mimeType = opts?.mimeType ?? ''
  }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

let trackStop: ReturnType<typeof vi.fn>

beforeEach(() => {
  trackStop = vi.fn()
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('voiceCapture', () => {
  it('maps recorder mime to an honest upload filename', () => {
    expect(filenameForMime('audio/webm;codecs=opus')).toBe('take.webm')
    expect(filenameForMime('audio/mp4')).toBe('take.mp4')
    expect(filenameForMime('audio/ogg')).toBe('take.ogg')
    expect(filenameForMime('')).toBe('take.webm')
  })

  it('flags an unsupported environment when MediaRecorder is missing', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    expect(checkBrowserCapability().ok).toBe(false)
  })

  it('stop() resolves the recorded blob and is idempotent', async () => {
    const session = await startCaptureSession({})
    const blob = await session.stop()
    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.size).toBeGreaterThan(0)
    // Second stop yields nothing (already finalized).
    expect(await session.stop()).toBeNull()
  })

  it('release() stops the mic tracks and is idempotent', async () => {
    const session = await startCaptureSession({})
    await session.release()
    await session.release()
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('reports elapsed time while recording', async () => {
    vi.useFakeTimers()
    const onElapsed = vi.fn()
    const session = await startCaptureSession({ onElapsed })
    await vi.advanceTimersByTimeAsync(2000)
    expect(onElapsed).toHaveBeenCalled()
    expect(onElapsed.mock.lastCall![0]).toBeGreaterThanOrEqual(2000)
    await session.release()
  })
})
