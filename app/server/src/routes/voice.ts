import { Hono } from 'hono'
import Groq from 'groq-sdk'
import { toFile } from 'groq-sdk/uploads'
import {
  VOICE_MAX_UPLOAD_BYTES,
  VOICE_MAX_TRANSCRIPT_CHARS,
  VOICE_MAX_FILEPATH_CHARS,
} from '../lib/constants'
import { fail } from '../lib/response'
import { buildWhisperPrompt, buildFormatterPrompt } from '../lib/voice-prompts'
import { resolveFormatterModels, formatWithFallback } from '../lib/voice-formatter'

const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo'

/** Audio formats Groq Whisper accepts; gate uploads before the upstream call. */
const ALLOWED_AUDIO_MIME = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/flac',
  'audio/x-flac',
])
const ALLOWED_AUDIO_EXT = new Set([
  'wav', 'webm', 'ogg', 'mpeg', 'mpga', 'mp3', 'mp4', 'm4a', 'flac',
])

/** Allow on a declared, whitelisted MIME; fall back to the file extension when
 *  the upload carries no usable MIME (browsers relabel typeless Blob parts as
 *  application/octet-stream). */
function isAllowedAudio(audio: File): boolean {
  const mime = audio.type.split(';')[0].trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream') {
    return ALLOWED_AUDIO_MIME.has(mime)
  }
  const ext = audio.name.split('.').pop()?.toLowerCase()
  return !!ext && ALLOWED_AUDIO_EXT.has(ext)
}

/** Reject control chars (incl. newlines) so a filePath can't inject prompt text. */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

function normalizeSafeFilePath(filePath: unknown): string | null | undefined {
  if (filePath === undefined) return undefined
  if (typeof filePath !== 'string') return null

  const normalized = filePath.trim()
  if (normalized === '') return undefined
  if (
    normalized.length > VOICE_MAX_FILEPATH_CHARS ||
    hasControlChars(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
    !/^[A-Za-z0-9._@+/-]+$/.test(normalized)
  ) {
    return null
  }

  const parts = normalized.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return null
  }
  return normalized
}

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return null
  return new Groq({ apiKey })
}

function getSttModel(): string {
  return process.env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_STT_MODEL
}

/** Map Groq SDK errors to stable HTTP responses */
function mapUpstreamError(err: unknown): { status: number; error: string; retryAfter?: string } {
  if (err instanceof Groq.APIError && err.status === 429) {
    const retryAfter = err.headers?.get('retry-after') ?? undefined
    return { status: 429, error: 'Rate limit reached. Try again shortly.', retryAfter }
  }
  return { status: 502, error: 'Transcription failed. Try again.' }
}

const app = new Hono()

app.get('/status', (c) => {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return c.json({ enabled: false, reason: 'missing_api_key' })
  }
  return c.json({
    enabled: true,
    sttModel: getSttModel(),
    formatterModels: resolveFormatterModels(),
    maxUploadBytes: VOICE_MAX_UPLOAD_BYTES,
  })
})

// Single audio chunk → raw transcript. Whisper only; no formatting.
app.post('/transcribe', async (c) => {
  const groq = getGroqClient()
  if (!groq) {
    return fail(c, 503, 'Voice input is unavailable. Set GROQ_API_KEY.')
  }

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return fail(c, 400, 'Invalid voice recording.')
  }

  const audio = formData.get('audio')
  const language = formData.get('language')
  const context = formData.get('context')

  if (!audio || !(audio instanceof File)) {
    return fail(c, 400, 'Invalid voice recording.')
  }
  if (!isAllowedAudio(audio)) {
    return fail(c, 400, 'Unsupported audio format.')
  }
  if (audio.size > VOICE_MAX_UPLOAD_BYTES) {
    return fail(c, 413, 'Recording too large. Keep it short.')
  }
  if (language !== null && typeof language !== 'string') {
    return fail(c, 400, 'Invalid voice recording.')
  }
  if (context !== null && typeof context !== 'string') {
    return fail(c, 400, 'Invalid voice recording.')
  }

  try {
    const arrayBuffer = await audio.arrayBuffer()
    const file = await toFile(
      new Uint8Array(arrayBuffer),
      audio.name || 'audio.wav',
      { type: audio.type || 'audio/wav' },
    )
    const transcription = await groq.audio.transcriptions.create({
      model: getSttModel(),
      file,
      // buildWhisperPrompt caps the context tail (Groq 224-token prompt limit).
      prompt: buildWhisperPrompt(context ?? undefined),
      ...(language ? { language } : {}),
    })
    return c.json({ text: transcription.text ?? '' })
  } catch (err) {
    const mapped = mapUpstreamError(err)
    if (mapped.retryAfter) c.header('retry-after', mapped.retryAfter)
    return fail(c, mapped.status as 400, mapped.error)
  }
})

// Whole transcript → polished, insertable text. Formatter only; no Whisper.
app.post('/format', async (c) => {
  const groq = getGroqClient()
  if (!groq) {
    return fail(c, 503, 'Voice input is unavailable. Set GROQ_API_KEY.')
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'Invalid request.')
  }

  const { text, surface, filePath } = (body ?? {}) as {
    text?: unknown
    surface?: unknown
    filePath?: unknown
  }

  if (typeof text !== 'string') {
    return fail(c, 400, 'Invalid request.')
  }
  if (typeof surface !== 'string' || !['editor', 'terminal'].includes(surface)) {
    return fail(c, 400, 'Invalid request.')
  }
  const safeFilePath = normalizeSafeFilePath(filePath)
  if (safeFilePath === null) {
    return fail(c, 400, 'Invalid request.')
  }

  // Bound formatter input before any model call (no audio-size proxy here).
  if (text.length > VOICE_MAX_TRANSCRIPT_CHARS) {
    return fail(c, 413, 'Transcript too long.')
  }
  if (text.trim() === '') {
    return c.json({ displayText: '', formattingStatus: 'empty' })
  }

  const systemPrompt = buildFormatterPrompt(surface, safeFilePath)
  const models = resolveFormatterModels()
  const result = await formatWithFallback(models, systemPrompt, text)

  const response: Record<string, string> = {
    displayText: result.text,
    formattingStatus: result.status,
  }
  if (result.warning) response.warning = result.warning
  return c.json(response)
})

export const voiceRoutes = app
