import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type { Readable } from 'node:stream'

// Server-side neural TTS via edge-tts (Microsoft "Read Aloud" voices). One
// MsEdgeTTS instance per request opens an outbound WSS, streams mp3 audio back,
// and is closed when the stream ends or fails. The endpoint is unofficial, so
// the whole synthesis (connect + stream) is bounded by a single timeout and the
// caller (the /speak route) degrades to browser TTS on failure.

/** A zh-CN neural voice: native Mandarin that also reads embedded English
 *  terms, so no per-utterance language pick for the user's mixed 中英文 notices.
 *  (The zh-CN-*MultilingualNeural voices are no longer served by the Read Aloud
 *  endpoint — they return empty audio — so we use the standard neural voice.) */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Hard ceiling on a single synthesis (WSS connect + stream). A short notice is
 *  ~1s of audio; this only guards a hung/slow endpoint, and must cover the
 *  connect (setMetadata) too — a hung connect is the most likely stall. */
const SYNTH_TIMEOUT_MS = 8000

/** Resolve the neural voice from env, falling back to the default. */
export function resolveTtsVoice(): string {
  return process.env.VOICE_TTS_VOICE?.trim() || DEFAULT_VOICE
}

/** msedge-tts embeds the text into an SSML document, so raw &<>"' would corrupt
 *  the markup. Ampersand is escaped first so the other entities aren't re-escaped. */
export function escapeForSsml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** close() may run before the socket opened (setMetadata threw) — never let
 *  teardown throw over the original error. */
function safeClose(tts: MsEdgeTTS): void {
  try { tts.close() } catch { /* socket may not be open */ }
}

/**
 * Synthesize `text` to MP3 bytes with a Microsoft neural voice. Resolves the
 * collected audio Buffer, or rejects on connect/stream error, empty audio, or
 * timeout. A single timer bounds the whole operation (connect + stream); every
 * terminal path runs the same cleanup — destroy the stream (if any) and close
 * the socket — so a hung connect or a synchronous toStream() throw cannot leak.
 */
export async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS()

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let audioStream: Readable | undefined

    const timer = setTimeout(() => {
      fail(new Error('edge-tts synthesis timed out'))
    }, SYNTH_TIMEOUT_MS)

    function cleanup(): void {
      clearTimeout(timer)
      audioStream?.destroy()
      safeClose(tts)
    }
    function fail(err: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    function succeed(buffer: Buffer): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(buffer)
    }

    // Connect + stream setup share the timer and the fail() path. A timeout that
    // fires mid-connect sets `settled`, so we bail once setMetadata returns.
    void (async () => {
      try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        if (settled) return
        audioStream = tts.toStream(escapeForSsml(text)).audioStream
        audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        audioStream.on('error', fail)
        audioStream.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.length === 0) {
            fail(new Error('edge-tts returned no audio'))
            return
          }
          succeed(buffer)
        })
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}
