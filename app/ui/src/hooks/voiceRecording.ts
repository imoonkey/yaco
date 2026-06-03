// Recording lifecycle as a plain module (not a hook).
// Handles MediaRecorder setup, MIME selection, chunk collection, and cleanup.

// --- Constants ---

export const MIN_RECORDING_MS = 500
export const MAX_RECORDING_SECONDS = 300
const ELAPSED_INTERVAL_MS = 1000

const MIME_PRIORITY = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

// --- Browser capability check ---

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
    return { ok: false, message: 'Browser does not support MediaRecorder.' }
  }
  if (!selectMimeType()) {
    return { ok: false, message: 'No supported audio format found.' }
  }
  return { ok: true }
}

function selectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of MIME_PRIORITY) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return null
}

// --- Recording session ---

export interface RecordingSession {
  stop: () => void
  release: () => void
}

export interface RecordingCallbacks {
  onElapsed: (ms: number) => void
  onStopped: (blob: Blob, durationMs: number) => void
  onTooShort: () => void
  onByteLimit: () => void
  onError: (message: string) => void
}

/**
 * Request mic permission and start recording.
 * Returns a promise that resolves to a RecordingSession on success,
 * or rejects with an Error on permission denial / setup failure.
 */
export async function startRecordingSession(
  maxUploadBytes: number,
  callbacks: RecordingCallbacks,
): Promise<RecordingSession> {
  const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)

  const mimeType = selectMimeType()
  if (!mimeType) {
    stream.getTracks().forEach(t => t.stop())
    throw new Error('No supported audio format found.')
  }

  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  let bytes = 0
  const startTime = Date.now()

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data)
      bytes += e.data.size
      if (bytes > maxUploadBytes) {
        session.stop()
      }
    }
  }

  // Elapsed timer
  const elapsedTimer = setInterval(() => {
    callbacks.onElapsed(Date.now() - startTime)
  }, ELAPSED_INTERVAL_MS)

  // Max duration auto-stop
  const maxTimer = setTimeout(() => {
    session.stop()
  }, MAX_RECORDING_SECONDS * 1000)

  function clearTimers() {
    clearInterval(elapsedTimer)
    clearTimeout(maxTimer)
  }

  let stopped = false

  const session: RecordingSession = {
    stop() {
      if (stopped) return
      stopped = true
      clearTimers()

      if (recorder.state === 'inactive') return

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const duration = Date.now() - startTime
        if (duration < MIN_RECORDING_MS) {
          callbacks.onTooShort()
          return
        }
        const blob = new Blob(chunks, { type: recorder.mimeType })
        callbacks.onStopped(blob, duration)
      }

      recorder.stop()
    },

    release() {
      clearTimers()
      if (recorder.state !== 'inactive') {
        recorder.onstop = null
        recorder.stop()
      }
      stream.getTracks().forEach(t => t.stop())
    },
  }

  recorder.start(1000) // 1s chunks

  return session
}
