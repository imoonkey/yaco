import { Hono } from 'hono'
import Groq from 'groq-sdk'
import { toFile } from 'groq-sdk/uploads'
import { VOICE_MAX_UPLOAD_BYTES } from '../lib/constants'
import { fail } from '../lib/response'
import { buildWhisperPrompt, buildFormatterPrompt } from '../lib/voice-prompts'
import { resolveFormatterModels, formatWithFallback } from '../lib/voice-formatter'

const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo'

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return null
  return new Groq({ apiKey })
}

function getSttModel(): string {
  return process.env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_STT_MODEL
}

/** Map Groq SDK errors to stable HTTP responses */
function mapUpstreamError(err: unknown): { status: number; error: string } {
  if (err instanceof Groq.APIError) {
    if (err.status === 429) {
      return { status: 429, error: 'Rate limit reached. Try again shortly.' }
    }
    return { status: 502, error: 'Transcription failed. Try again.' }
  }
  if (err instanceof Groq.APIConnectionError) {
    return { status: 502, error: 'Transcription failed. Try again.' }
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

app.post('/compose', async (c) => {
  // Check API key
  const groq = getGroqClient()
  if (!groq) {
    return fail(c, 503, 'Voice input is unavailable. Set GROQ_API_KEY.')
  }

  // Parse multipart form
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return fail(c, 400, 'Invalid voice recording.')
  }

  const audio = formData.get('audio')
  const surface = formData.get('surface') as string | null
  const language = formData.get('language') as string | null
  const filePath = formData.get('filePath') as string | null

  // Validate required fields
  if (!audio || !(audio instanceof File)) {
    return fail(c, 400, 'Invalid voice recording.')
  }
  if (!surface || !['editor', 'terminal'].includes(surface)) {
    return fail(c, 400, 'Invalid voice recording.')
  }

  // Check size
  if (audio.size > VOICE_MAX_UPLOAD_BYTES) {
    return fail(c, 413, 'Recording too large. Keep it short.')
  }

  // STT via Groq Whisper
  let rawText: string
  try {
    const arrayBuffer = await audio.arrayBuffer()
    const file = await toFile(
      new Uint8Array(arrayBuffer),
      audio.name || 'audio.webm',
      { type: audio.type || 'audio/webm' },
    )
    const transcription = await groq.audio.transcriptions.create({
      model: getSttModel(),
      file,
      prompt: buildWhisperPrompt(),
      ...(language ? { language } : {}),
    })
    rawText = transcription.text
  } catch (err) {
    const mapped = mapUpstreamError(err)
    return fail(c, mapped.status as 400, mapped.error)
  }

  // Empty transcript
  if (!rawText || rawText.trim() === '') {
    return c.json({ rawText: '', displayText: '', formattingStatus: 'empty' })
  }

  // Formatter LLM with multi-model fallback
  const systemPrompt = buildFormatterPrompt(surface, filePath ?? undefined)
  const models = resolveFormatterModels()
  const result = await formatWithFallback(models, systemPrompt, rawText)

  const response: Record<string, string> = {
    rawText,
    displayText: result.text,
    formattingStatus: result.status,
  }
  if (result.warning) response.warning = result.warning
  return c.json(response)
})

export const voiceRoutes = app
