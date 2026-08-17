const FRAME_SAMPLES = 1024

declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort }
}

declare function registerProcessor(
  name: string,
  implementation: new () => {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
  },
): void

function encodePcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

class CodexPcmProcessor extends AudioWorkletProcessor {
  private buffer = new ArrayBuffer(FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT)
  private view = new DataView(this.buffer)
  private length = 0
  private accepting = true

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (
        typeof message !== 'object'
        || message === null
        || !('type' in message)
        || message.type !== 'flush'
      ) return

      this.accepting = false
      if (this.length > 0) this.emitFrame(this.length)
      this.port.postMessage({ type: 'drained' })
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs[0] ?? []) output.fill(0)
    if (!this.accepting) return false

    const input = inputs[0]?.[0]
    if (!input) return true
    for (const sample of input) {
      this.view.setInt16(this.length * Int16Array.BYTES_PER_ELEMENT, encodePcm16(sample), true)
      this.length += 1
      if (this.length === FRAME_SAMPLES) this.emitFrame(FRAME_SAMPLES)
    }
    return true
  }

  private emitFrame(samples: number): void {
    const byteLength = samples * Int16Array.BYTES_PER_ELEMENT
    const buffer = samples === FRAME_SAMPLES
      ? this.buffer
      : this.buffer.slice(0, byteLength)
    const pcm16 = new Int16Array(buffer)
    this.port.postMessage({ type: 'frame', pcm16 }, [buffer])
    this.buffer = new ArrayBuffer(FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT)
    this.view = new DataView(this.buffer)
    this.length = 0
  }
}

registerProcessor('codex-pcm-processor', CodexPcmProcessor)
