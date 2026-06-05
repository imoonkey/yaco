// VAD capture as a plain module (not a hook). Wraps @ricky0123/vad-web's MicVAD
// and owns chunk coalescing: VAD hands us one complete utterance per natural
// pause; we accumulate utterances and emit a coalesced ~10s WAV per request so
// transcription stays under Groq's ~20 RPM free-tier wall (see design doc,
// plan/active/voice-streaming/design_claude.md). Replaces voiceRecording.ts.

import type { RealTimeVADOptions } from '@ricky0123/vad-web'

// __VAD_ASSET_BASE__ is injected by vite (app/ui/vite.config.ts) and is the
// single source of truth for where the self-hosted worklet/model/ort wasm live.
declare const __VAD_ASSET_BASE__: string

// --- Constants ---

const SAMPLE_RATE = 16000 // MicVAD emits Float32 PCM at 16kHz
const ELAPSED_INTERVAL_MS = 1000

// Coalescing: flush a chunk once the buffer reaches the target length, or on a
// genuine end-of-thought pause — but never more often than the min interval, so
// the request rate stays at ~6/min regardless of how the user phrases things.
export const CHUNK_TARGET_SECONDS = 10
const CHUNK_TARGET_SAMPLES = CHUNK_TARGET_SECONDS * SAMPLE_RATE
export const MIN_FLUSH_INTERVAL_MS = 10_000
// How long after an utterance ends (on top of VAD's redemption silence) we wait
// before treating the gap as end-of-thought. A new utterance cancels it.
const PAUSE_FLUSH_MS = 1000

// Overall session cap. The wrapper reports elapsed time; the consuming hook
// enforces the cap by calling stop() — the only way a cap fits the hook-driven
// finalize gate, since stop() is what flushes the remainder and finalizes.
export const MAX_RECORDING_SECONDS = 300

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

// --- WAV encoding (PCM16 mono) ---

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // channels = mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate = rate * blockAlign
  view.setUint16(32, 2, true) // block align = channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

// --- Coalescer ---
//
// Pure (no timers, no MicVAD): the session below drives it with wall-clock
// times so it stays unit-testable. Buffers VAD utterances and decides when a
// coalesced WAV should be emitted. Exported for tests.
export type PauseFlush = 'flushed' | 'gated' | 'empty'

export class VadCoalescer {
  private parts: Float32Array[] = []
  private length = 0
  private index = 0
  /** Wall-clock ms of the last emitted chunk; seeded with session start so the
   * very first chunk also respects the rate floor. */
  lastFlushMs: number
  private readonly flushThreshold: number
  private readonly emit: (wav: Blob, index: number) => void

  constructor(
    maxBytes: number,
    startMs: number,
    emit: (wav: Blob, index: number) => void,
  ) {
    this.emit = emit
    this.lastFlushMs = startMs
    // Flush at the ~10s target, but never let a single coalesced WAV exceed the
    // server's per-request byte cap (non-binding at 10s; a guard if tuned up).
    const maxSamples = Math.floor((maxBytes - 44) / 2)
    this.flushThreshold = Math.min(CHUNK_TARGET_SAMPLES, maxSamples)
  }

  /** Append a completed utterance. Returns true if it triggered a flush. */
  push(samples: Float32Array, nowMs: number): boolean {
    this.parts.push(samples)
    this.length += samples.length
    if (this.length >= this.flushThreshold) {
      this.flush(nowMs)
      return true
    }
    return false
  }

  /** End-of-thought pause elapsed: flush only if the rate floor has cleared. */
  tryPauseFlush(nowMs: number): PauseFlush {
    if (this.length === 0) return 'empty'
    if (nowMs - this.lastFlushMs < MIN_FLUSH_INTERVAL_MS) return 'gated'
    this.flush(nowMs)
    return 'flushed'
  }

  /** Final flush at Stop: emit whatever remains, ignoring the rate floor. */
  flushRemainder(nowMs: number): boolean {
    if (this.length === 0) return false
    this.flush(nowMs)
    return true
  }

  private flush(nowMs: number) {
    const merged = new Float32Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      merged.set(part, offset)
      offset += part.length
    }
    this.emit(encodeWav(merged), this.index)
    this.index += 1
    this.parts = []
    this.length = 0
    this.lastFlushMs = nowMs
  }
}

// --- Browser capability check ---
//
// MicVAD needs a secure context (getUserMedia + AudioWorklet are both gated on
// it), getUserMedia for the mic, and AudioWorklet for the VAD processor node.
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
  if (typeof AudioWorkletNode === 'undefined') {
    return { ok: false, message: 'Browser does not support AudioWorklet.' }
  }
  return { ok: true }
}

// --- VAD session ---

export interface VadSession {
  /** Stop capture: flush the buffered remainder as the final chunk, then
   * resolve. Resolves only after every final onChunk has been registered. */
  stop: () => Promise<void>
  /** Destroy the VAD and release the mic. Idempotent; safe after a failed init. */
  release: () => Promise<void>
}

export interface VadCallbacks {
  onChunk: (wav: Blob, index: number) => void
  onSpeechStart?: () => void
  onElapsed?: (ms: number) => void
  onError?: (message: string) => void
}

// The slice of MicVAD this wrapper actually drives. Narrowing it (instead of the
// full vad-web type) gives tests a tiny seam to inject a fake module without a
// real browser/worklet. The real `{ MicVAD }` export satisfies it structurally.
interface VadController {
  pause: () => Promise<void>
  destroy: () => Promise<void>
}
interface MicVadModule {
  MicVAD: { new: (options: Partial<RealTimeVADOptions>) => Promise<VadController> }
}
type MicVadLoader = () => Promise<MicVadModule>

declare global {
  interface Window {
    __YACO_FAKE_MIC_VAD__?: MicVadModule
  }
}

const loadMicVad: MicVadLoader = () => {
  const fake = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__YACO_FAKE_MIC_VAD__
    : undefined
  return fake ? Promise.resolve(fake) : import('@ricky0123/vad-web')
}

/**
 * Request the mic and start a VAD capture session.
 *
 * The loader lazy-imports vad-web + onnxruntime-web (kept out of the main bundle)
 * and, with startOnLoad defaulting true, MicVAD.new() auto-starts — so we never
 * call start() ourselves. getUserMedia runs inside new() via our getStream, so a
 * denied mic or an asset 404 rejects this promise. We own that getStream so we
 * can stop the mic if new() throws *after* acquiring it — MicVAD leaks a
 * partially-started stream and gives no handle back. The caller maps the
 * rejection to its error state; release() is safe to call on a returned session.
 *
 * @param load injectable MicVAD module loader (defaults to the dynamic import);
 *   exists purely so tests can drive init/teardown without a real worklet.
 */
export async function startVadSession(
  maxBytes: number,
  callbacks: VadCallbacks,
  load: MicVadLoader = loadMicVad,
): Promise<VadSession> {
  const { MicVAD } = await load()

  const startedAt = Date.now()
  const coalescer = new VadCoalescer(maxBytes, startedAt, callbacks.onChunk)

  let stopping = false
  let released = false
  let pauseTimer: ReturnType<typeof setTimeout> | null = null
  let micStream: MediaStream | null = null
  const audioContext = new AudioContext()

  const clearPauseTimer = () => {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer)
      pauseTimer = null
    }
  }
  const armPauseTimer = (delayMs: number) => {
    clearPauseTimer()
    pauseTimer = setTimeout(onPauseElapsed, delayMs)
  }
  function onPauseElapsed() {
    pauseTimer = null
    if (stopping || released) return
    const result = coalescer.tryPauseFlush(Date.now())
    if (result === 'gated') {
      // Rate floor not cleared yet: re-arm for exactly the remaining wait, so
      // the buffered text lands the moment the floor opens (no extra request).
      const remaining = MIN_FLUSH_INTERVAL_MS - (Date.now() - coalescer.lastFlushMs)
      armPauseTimer(remaining > 0 ? remaining : PAUSE_FLUSH_MS)
    }
  }
  const stopStream = (stream: MediaStream) => {
    stream.getTracks().forEach(track => track.stop())
    if (micStream === stream) micStream = null
  }
  const closeAudioContext = async () => {
    if (audioContext.state !== 'closed') await audioContext.close()
  }

  const options: Partial<RealTimeVADOptions> = {
    model: 'v5',
    audioContext,
    baseAssetPath: __VAD_ASSET_BASE__,
    onnxWASMBasePath: __VAD_ASSET_BASE__,
    processorType: 'AudioWorklet',
    submitUserSpeechOnPause: true, // so pause() flushes any in-progress utterance
    redemptionMs: 1400, // silence tolerated within one utterance before it ends
    minSpeechMs: 400, // drop sub-threshold blips as misfires
    getStream: async () => {
      micStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
      return micStream
    },
    pauseStream: async (stream: MediaStream) => {
      stopStream(stream)
    },
    resumeStream: async () => {
      micStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
      return micStream
    },
    onSpeechStart: () => {
      if (released) return
      clearPauseTimer() // user resumed — cancel any pending end-of-thought flush
      callbacks.onSpeechStart?.()
    },
    onSpeechEnd: (audio: Float32Array) => {
      // released: we're destroying — ignore late flushes (destroy() can fire a
      // final onSpeechEnd) so no chunk is emitted after release.
      if (released) return
      try {
        const flushed = coalescer.push(audio, Date.now())
        // stopping: the utterance is captured for the final flush, but we must
        // not arm another pause timer past Stop.
        if (stopping) return
        if (!flushed) armPauseTimer(PAUSE_FLUSH_MS)
      } catch (e) {
        callbacks.onError?.(e instanceof Error ? e.message : String(e))
      }
    },
    onVADMisfire: () => {}, // ignored: sub-minSpeechMs noise, nothing buffered
  }

  let vad: VadController
  try {
    vad = await MicVAD.new(options)
  } catch (e) {
    // Partial init: MicVAD may have acquired the mic before failing and hands us
    // no handle to release it, so reclaim the stream/context we own.
    if (micStream) stopStream(micStream)
    try {
      await closeAudioContext()
    } catch {
      // Best effort; startup is already failing.
    }
    throw e
  }

  const elapsedTimer = setInterval(() => {
    callbacks.onElapsed?.(Date.now() - startedAt)
  }, ELAPSED_INTERVAL_MS)

  return {
    async stop() {
      if (stopping || released) return
      stopping = true
      clearPauseTimer()
      clearInterval(elapsedTimer)
      // pause() flushes any in-progress utterance synchronously into the buffer
      // (submitUserSpeechOnPause) and stops the mic tracks.
      try {
        await vad.pause()
      } catch (e) {
        callbacks.onError?.(e instanceof Error ? e.message : String(e))
      }
      if (released) return // release raced in during the await — don't emit
      // Emit the remainder as the final chunk before resolving, so the caller's
      // gate sees every chunk registered.
      coalescer.flushRemainder(Date.now())
    },

    async release() {
      if (released) return
      released = true
      clearPauseTimer()
      clearInterval(elapsedTimer)
      try {
        await vad.destroy()
      } catch {
        // destroy is best-effort; a partially-initialised VAD may throw.
      } finally {
        if (micStream) stopStream(micStream)
        try {
          await closeAudioContext()
        } catch {
          // Release remains idempotent even if browser teardown rejects.
        }
      }
    },
  }
}
