// Single-take audio capture as a plain module (not a hook). Wraps the native
// MediaRecorder: one continuous take, ended by the user (Stop / F5) or the
// session cap. The Whisper-ready blob (Opus-in-WebM, or mp4/aac on Safari) is
// produced once on stop — no mid-recording chunking, no VAD. Replaces
// voiceVad.ts (Silero/onnxruntime), which is gone.

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

// --- Browser capability check ---
//
// MediaRecorder + getUserMedia are both gated on a secure context. No
// AudioWorklet/AudioContext requirement now that the neural VAD is gone.
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

// --- Capture session ---

export interface CaptureSession {
  /** Stop recording and resolve the take as one Blob (null if nothing was
   *  captured). Idempotent: a second call resolves null. */
  stop: () => Promise<Blob | null>
  /** Stop the mic tracks. Idempotent; safe after a failed init or after stop(). */
  release: () => Promise<void>
}

export interface CaptureCallbacks {
  onElapsed?: (ms: number) => void
  onError?: (message: string) => void
  /** Reserved seam for a future silence auto-stop layer (an AnalyserNode RMS
   *  watcher would call the session's own stop()). Unused in v1. */
  onAutoStop?: (blob: Blob | null) => void
}

// The session constructor, narrowed so tests can inject a fake recorder without
// a real mic. The real implementation below satisfies it.
export type CaptureLoader = (callbacks: CaptureCallbacks) => Promise<CaptureSession>

declare global {
  interface Window {
    __YACO_FAKE_CAPTURE__?: CaptureLoader
  }
}

/**
 * Acquire the mic and start a single-take recording.
 *
 * getUserMedia runs first, so a denied mic rejects this promise (the caller maps
 * it to its error state). If MediaRecorder construction throws after the mic is
 * acquired, we stop the stream before rethrowing. The returned session's stop()
 * resolves the recorded blob; release() is always safe to call.
 */
export async function startCaptureSession(
  callbacks: CaptureCallbacks,
): Promise<CaptureSession> {
  const fake = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__YACO_FAKE_CAPTURE__
    : undefined
  if (fake) return fake(callbacks)

  const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
  const mimeType = pickMimeType()

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (e) {
    stream.getTracks().forEach(track => track.stop())
    throw e
  }

  const chunks: Blob[] = []
  let stopped = false
  let released = false
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  const blobType = () => recorder.mimeType || mimeType || 'audio/webm'
  const assembled = (): Blob | null =>
    chunks.length ? new Blob(chunks, { type: blobType() }) : null
  const stopTracks = () => stream.getTracks().forEach(track => track.stop())

  // Idempotent teardown — reused by release(), recorder errors, and start-failure.
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    if (elapsedTimer) clearInterval(elapsedTimer)
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      // Best effort; teardown is already underway.
    } finally {
      stopTracks()
    }
  }

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  // A fatal recorder error must free the mic itself — the caller only learns of
  // it via onError and may not yet hold the session handle.
  recorder.onerror = () => {
    callbacks.onError?.('Recording failed.')
    void release()
  }

  // start() can throw; reclaim the mic before rethrowing (no timer armed yet).
  try {
    recorder.start()
  } catch (e) {
    stopTracks()
    throw e
  }

  const startedAt = Date.now()
  elapsedTimer = setInterval(() => {
    callbacks.onElapsed?.(Date.now() - startedAt)
  }, ELAPSED_INTERVAL_MS)

  const stop = (): Promise<Blob | null> => {
    if (stopped || released) return Promise.resolve(null)
    stopped = true
    if (elapsedTimer) clearInterval(elapsedTimer)
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

  return { stop, release }
}
