import codexPcmProcessorUrl from '../audio/codexPcmProcessor.ts?worker&url'

// Single-take audio capture as a plain module (not a hook). MediaRecorder owns
// the canonical whole-take Blob. A caller may additionally request parallel
// PCM16 frames; failure of that optional path never invalidates the Blob.

const ELAPSED_INTERVAL_MS = 1000

// Overall session cap. The module reports elapsed time; the consuming hook
// enforces the cap by calling stop() (the single path that finalizes a take).
export const MAX_RECORDING_SECONDS = 300

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

// MediaRecorder container/codec preference: Opus-in-WebM is the smallest upload
// and Groq-accepted; Safari only records mp4/aac. Pick the first supported.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

// Upload filename for a recorder mime. The server allow-list falls back to the
// extension when a Blob carries no usable MIME, so the suffix must be honest.
export function filenameForMime(mime: string): string {
  if (mime.includes('ogg')) return 'take.ogg'
  if (mime.includes('mp4')) return 'take.mp4'
  return 'take.webm'
}

// PCM is optional, so browser capability remains the MediaRecorder baseline.
export function checkBrowserCapability(): { ok: boolean; message?: string } {
  if (typeof window === 'undefined') {
    return { ok: false, message: 'No browser environment.' }
  }
  if (!window.isSecureContext) {
    return { ok: false, message: 'Secure context required (HTTPS or localhost).' }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, message: 'Browser does not support audio capture.' }
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, message: 'Browser does not support audio recording.' }
  }
  return { ok: true }
}

export interface CaptureSession {
  /** Stop recording and resolve the complete take after optional PCM drain.
   *  Idempotent: a second call resolves null. */
  stop: () => Promise<Blob | null>
  /** Stop every owned browser audio resource. Idempotent and safe after stop(). */
  release: () => Promise<void>
}

export interface CaptureCallbacks {
  onElapsed?: (ms: number) => void
  onError?: (message: string) => void
  /** Reserved seam for a future silence auto-stop layer (an AnalyserNode RMS
   *  watcher would call the session's own stop()). Unused in v1. */
  onAutoStop?: (blob: Blob | null) => void
}

export interface PcmCaptureSink {
  start: (sampleRateHz: number) => void
  append: (chunk: Int16Array) => void
}

// The session constructor, narrowed so tests can inject a fake recorder without
// a real mic. The real implementation below satisfies it.
export type CaptureLoader = (
  callbacks: CaptureCallbacks,
  pcmSink?: PcmCaptureSink,
) => Promise<CaptureSession>

declare global {
  interface Window {
    __YACO_FAKE_CAPTURE__?: CaptureLoader
  }
}

/** Acquire the mic and start a whole-take recording plus optional PCM capture. */
export async function startCaptureSession(
  callbacks: CaptureCallbacks,
  pcmSink?: PcmCaptureSink,
): Promise<CaptureSession> {
  const fakeEnabled = import.meta.env.DEV || import.meta.env.VITE_YACO_E2E_FAKE_CAPTURE === '1'
  const fake = fakeEnabled && typeof window !== 'undefined'
    ? window.__YACO_FAKE_CAPTURE__
    : undefined
  if (fake) return fake(callbacks, pcmSink)

  const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
  const mimeType = pickMimeType()

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stream.getTracks().forEach(track => track.stop())
    throw error
  }

  const chunks: Blob[] = []
  let stopped = false
  let released = false
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let pcmCapture: PcmCapture | null = null

  const blobType = (): string => recorder.mimeType || mimeType || 'audio/webm'
  const assembled = (): Blob | null =>
    chunks.length ? new Blob(chunks, { type: blobType() }) : null
  const stopTracks = (): void => stream.getTracks().forEach(track => track.stop())

  const release = async (): Promise<void> => {
    if (released) return
    released = true
    if (elapsedTimer) clearInterval(elapsedTimer)
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      // The recorder is already unusable; the remaining resources still close.
    } finally {
      stopTracks()
      await pcmCapture?.close()
    }
  }

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  // A fatal recorder error must free the mic itself — the caller may not hold
  // the session yet while optional worklet initialization is in progress.
  recorder.onerror = () => {
    callbacks.onError?.('Recording failed.')
    void release()
  }

  try {
    recorder.start()
  } catch (error) {
    stopTracks()
    throw error
  }

  if (pcmSink) {
    pcmCapture = await startPcmCapture(stream, pcmSink)
    if (released) await pcmCapture?.close()
  }

  if (!released) {
    const startedAt = Date.now()
    elapsedTimer = setInterval(() => {
      callbacks.onElapsed?.(Date.now() - startedAt)
    }, ELAPSED_INTERVAL_MS)
  }

  const stopRecorder = (): Promise<Blob | null> => {
    if (recorder.state === 'inactive') return Promise.resolve(assembled())
    // onstop fires after the final dataavailable, so the blob is complete.
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => resolve(assembled())
      try {
        recorder.stop()
      } catch {
        resolve(assembled())
      }
    })
  }

  const stop = async (): Promise<Blob | null> => {
    if (stopped || released) return null
    stopped = true
    if (elapsedTimer) clearInterval(elapsedTimer)
    const [blob] = await Promise.all([
      stopRecorder(),
      pcmCapture?.flush(),
    ])
    return blob
  }

  return { stop, release }
}

interface PcmCapture {
  flush: () => Promise<void>
  close: () => Promise<void>
}

async function startPcmCapture(
  stream: MediaStream,
  sink: PcmCaptureSink,
): Promise<PcmCapture | null> {
  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    return null
  }

  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let closed = false
  let flushPromise: Promise<void> | null = null
  let resolveDrain: (() => void) | null = null

  const settleDrain = (): void => {
    resolveDrain?.()
    resolveDrain = null
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleDrain()
    node?.port.close()
    try {
      source?.disconnect()
      node?.disconnect()
    } catch {
      // A browser may already have disconnected a failed audio graph.
    }
    await context.close().catch(() => undefined)
  }

  try {
    await context.audioWorklet.addModule(codexPcmProcessorUrl)
    source = context.createMediaStreamSource(stream)
    node = new AudioWorkletNode(context, 'codex-pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
    })
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'frame'
        && 'pcm16' in message
        && message.pcm16 instanceof Int16Array
        && message.pcm16.length <= 1024
      ) {
        try {
          sink.append(message.pcm16)
        } catch {
          settleDrain()
          void close()
        }
        return
      }
      if (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'drained'
      ) {
        settleDrain()
        return
      }
      settleDrain()
      void close()
    }
    node.onprocessorerror = () => {
      settleDrain()
      void close()
    }
    await context.resume()
    sink.start(context.sampleRate)
    source.connect(node)
    node.connect(context.destination)
  } catch {
    await close()
    return null
  }

  const flush = async (): Promise<void> => {
    if (closed) return
    if (!flushPromise) {
      flushPromise = new Promise<void>((resolve) => {
        resolveDrain = resolve
        try {
          node!.port.postMessage({ type: 'flush' })
        } catch {
          settleDrain()
        }
      }).then(close)
    }
    await flushPromise
  }

  return { flush, close }
}
