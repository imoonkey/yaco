// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startCaptureSession,
  filenameForMime,
  checkBrowserCapability,
  type PcmCaptureSink,
} from '../voiceCapture'

class FakeMediaRecorder {
  static isTypeSupported = (mime: string) => mime === 'audio/webm;codecs=opus'
  static instances: FakeMediaRecorder[] = []

  state: 'inactive' | 'recording' = 'inactive'
  readonly mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    lifecycleEvents.push('recorder:start')
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio-', 'bytes'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn<(message: unknown) => void>()
  readonly close = vi.fn()

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []

  readonly port = new FakeMessagePort()
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly name: string
  readonly options: AudioWorkletNodeOptions | undefined
  onprocessorerror: ((event: Event) => void) | null = null

  constructor(_context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    this.name = name
    this.options = options
    FakeAudioWorkletNode.instances.push(this)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static addModuleError: Error | null = null

  readonly sampleRate = 48_000
  readonly destination = {} as AudioDestinationNode
  readonly source = {
    connect: vi.fn(() => lifecycleEvents.push('source:connect')),
    disconnect: vi.fn(),
  }
  readonly audioWorklet = {
    addModule: vi.fn(async () => {
      lifecycleEvents.push('worklet:addModule')
      if (FakeAudioContext.addModuleError) throw FakeAudioContext.addModuleError
    }),
  }
  readonly createMediaStreamSource = vi.fn(() => this.source)
  readonly resume = vi.fn(async () => { lifecycleEvents.push('context:resume') })
  readonly close = vi.fn(async () => undefined)

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

let trackStop: ReturnType<typeof vi.fn>
let lifecycleEvents: string[]

function installPcmFakes(): void {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
}

function frame(...samples: number[]): Int16Array {
  return Int16Array.from(samples)
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeAudioContext.instances = []
  FakeAudioContext.addModuleError = null
  FakeAudioWorkletNode.instances = []
  lifecycleEvents = []
  trackStop = vi.fn()
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: trackStop }],
      }) as unknown as MediaStream),
    },
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

  it('keeps Groq capture free of AudioContext and worklet setup', async () => {
    installPcmFakes()

    const session = await startCaptureSession({})

    expect(FakeAudioContext.instances).toHaveLength(0)
    await session.release()
  })

  it('delivers the actual sample rate and ordered PCM frames before Stop resolves', async () => {
    installPcmFakes()
    const calls: Array<number | Int16Array> = []
    const sink: PcmCaptureSink = {
      start: sampleRateHz => {
        lifecycleEvents.push('sink:start')
        calls.push(sampleRateHz)
      },
      append: chunk => calls.push(chunk),
      fail: vi.fn(),
    }
    const session = await startCaptureSession({}, sink)
    const context = FakeAudioContext.instances[0]!
    const node = FakeAudioWorkletNode.instances[0]!

    node.port.emit({ type: 'frame', pcm16: frame(1, 2) })
    node.port.emit({ type: 'frame', pcm16: frame(3, 4) })

    let resolved = false
    const stopping = session.stop().then(blob => {
      resolved = true
      return blob
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'flush' })

    node.port.emit({ type: 'frame', pcm16: frame(5) })
    node.port.emit({ type: 'drained' })
    const blob = await stopping

    expect(calls).toEqual([48_000, frame(1, 2), frame(3, 4), frame(5)])
    expect(lifecycleEvents).toEqual([
      'worklet:addModule',
      'context:resume',
      'sink:start',
      'recorder:start',
      'source:connect',
    ])
    expect(node.options).toMatchObject({ channelCount: 1, channelCountMode: 'explicit' })
    expect(await blob!.text()).toBe('audio-bytes')
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(node.disconnect).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the MediaRecorder take usable when worklet initialization fails', async () => {
    installPcmFakes()
    FakeAudioContext.addModuleError = new Error('worklet unavailable')
    const sink: PcmCaptureSink = { start: vi.fn(), append: vi.fn(), fail: vi.fn() }

    const session = await startCaptureSession({}, sink)
    const blob = await session.stop()

    expect(await blob!.text()).toBe('audio-bytes')
    expect(sink.start).not.toHaveBeenCalled()
    expect(sink.append).not.toHaveBeenCalled()
    expect(sink.fail).toHaveBeenCalledTimes(1)
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
    await session.release()
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('stop() resolves the complete Blob once and is idempotent', async () => {
    const session = await startCaptureSession({})
    const blob = await session.stop()

    expect(await blob!.text()).toBe('audio-bytes')
    expect(await session.stop()).toBeNull()
    expect(FakeMediaRecorder.instances[0]!.state).toBe('inactive')
  })

  it('release() reclaims the recorder, mic, worklet, and context once', async () => {
    installPcmFakes()
    const session = await startCaptureSession({}, { start: vi.fn(), append: vi.fn(), fail: vi.fn() })
    const context = FakeAudioContext.instances[0]!
    const node = FakeAudioWorkletNode.instances[0]!

    await session.release()
    await session.release()

    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(node.disconnect).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(await session.stop()).toBeNull()
  })

  it('release() settles an in-flight Stop drain and closes everything once', async () => {
    installPcmFakes()
    const session = await startCaptureSession({}, { start: vi.fn(), append: vi.fn(), fail: vi.fn() })
    const context = FakeAudioContext.instances[0]!

    const stopping = session.stop()
    await session.release()

    expect(await (await stopping)!.text()).toBe('audio-bytes')
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('unmount-style cleanup closes partial PCM setup without leaking the mic', async () => {
    installPcmFakes()
    const session = await startCaptureSession({}, { start: vi.fn(), append: vi.fn(), fail: vi.fn() })

    const cleanup = session.release()

    expect(trackStop).toHaveBeenCalledTimes(1)
    await cleanup
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled drain, signals PCM failure, and still returns the Blob', async () => {
    vi.useFakeTimers()
    installPcmFakes()
    const sink: PcmCaptureSink = { start: vi.fn(), append: vi.fn(), fail: vi.fn() }
    const session = await startCaptureSession({}, sink)

    const stopping = session.stop()
    await vi.advanceTimersByTimeAsync(1000)

    expect(await (await stopping)!.text()).toBe('audio-bytes')
    expect(sink.fail).toHaveBeenCalledTimes(1)
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
    await session.release()
  })

  it('signals PCM failure and closes the graph when the processor errors', async () => {
    installPcmFakes()
    const sink: PcmCaptureSink = { start: vi.fn(), append: vi.fn(), fail: vi.fn() }
    const session = await startCaptureSession({}, sink)

    FakeAudioWorkletNode.instances[0]!.onprocessorerror?.(new Event('processorerror'))
    await vi.waitFor(() => expect(sink.fail).toHaveBeenCalledTimes(1))

    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
    expect(await (await session.stop())!.text()).toBe('audio-bytes')
    await session.release()
  })

  it('fails closed on an unknown worklet message', async () => {
    installPcmFakes()
    const sink: PcmCaptureSink = { start: vi.fn(), append: vi.fn(), fail: vi.fn() }
    const session = await startCaptureSession({}, sink)

    FakeAudioWorkletNode.instances[0]!.port.emit({ type: 'surprise' })
    await vi.waitFor(() => expect(sink.fail).toHaveBeenCalledTimes(1))

    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
    await session.release()
  })

  it('signals PCM failure when the sink rejects a frame', async () => {
    installPcmFakes()
    const sink: PcmCaptureSink = {
      start: vi.fn(),
      append: vi.fn(() => { throw new Error('stream unavailable') }),
      fail: vi.fn(),
    }
    const session = await startCaptureSession({}, sink)

    FakeAudioWorkletNode.instances[0]!.port.emit({ type: 'frame', pcm16: frame(1) })
    await vi.waitFor(() => expect(sink.fail).toHaveBeenCalledTimes(1))

    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1)
    expect(await (await session.stop())!.text()).toBe('audio-bytes')
    await session.release()
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

describe('codexPcmProcessor', () => {
  it('emits ordered little-endian PCM16 frames of at most 1024 samples and flushes the tail', async () => {
    vi.resetModules()
    const posted: Array<{ message: unknown; transfer?: Transferable[] }> = []
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(message: unknown, transfer?: Transferable[]) {
        posted.push({ message, transfer })
      },
    }
    type Processor = {
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
    }
    let ProcessorClass: (new () => Processor) | undefined
    vi.stubGlobal('AudioWorkletProcessor', class { readonly port = port })
    vi.stubGlobal('registerProcessor', (name: string, implementation: new () => Processor) => {
      expect(name).toBe('codex-pcm-processor')
      ProcessorClass = implementation
    })

    await import('../../audio/codexPcmProcessor')
    const processor = new ProcessorClass!()
    const input = new Float32Array(1025)
    input.set([-2, -1, -0.5, 0, 0.5, 1, 2])
    input[1024] = 0.25
    const output = new Float32Array(input.length).fill(1)

    expect(processor.process([[input]], [[output]])).toBe(true)
    expect(output.every(sample => sample === 0)).toBe(true)
    port.onmessage?.({ data: { type: 'flush' } } as MessageEvent)

    const frames = posted.filter(entry => (
      entry.message as { type?: string }
    ).type === 'frame')
    expect(frames).toHaveLength(2)
    const first = (frames[0]!.message as { pcm16: Int16Array }).pcm16
    const tail = (frames[1]!.message as { pcm16: Int16Array }).pcm16
    expect(first).toHaveLength(1024)
    expect(tail).toHaveLength(1)
    expect(frames[0]!.transfer).toEqual([first.buffer])
    expect(frames[1]!.transfer).toEqual([tail.buffer])

    const bytes = new DataView(first.buffer, first.byteOffset, first.byteLength)
    expect(Array.from({ length: 7 }, (_, index) => bytes.getInt16(index * 2, true)))
      .toEqual([-32768, -32768, -16384, 0, 16383, 32767, 32767])
    expect(new DataView(tail.buffer).getInt16(0, true)).toBe(8191)
    expect(posted.at(-1)!.message).toEqual({ type: 'drained' })
  })
})
