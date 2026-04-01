import { Hono } from 'hono'
import Groq from 'groq-sdk'
import { toFile } from 'groq-sdk/uploads'
import { VOICE_MAX_UPLOAD_BYTES } from '../lib/constants'
import { fail } from '../lib/response'

const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo'
const DEFAULT_FORMATTER_MODEL = 'llama-3.1-8b-instant'

const TERMINAL_SYSTEM_PROMPT = `You are a speech-to-text cleanup assistant for terminal/CLI input. The user may speak in any language or mix languages freely.

Rules:
- Convert spoken flag patterns to literal CLI syntax: "dash dash help" → "--help", "dash s b" → "-sb"
- Convert spoken path patterns: "tilde slash" → "~/", "dot slash" → "./"
- Convert spoken operators: "pipe" → "|", "greater than" → ">", "less than" → "<", "ampersand" → "&"
- Preserve exact command names, filenames, and arguments
- Preserve the original language of non-command text — do not translate
- Do not add explanations or commentary
- Do not add a trailing newline
- Return ONLY the cleaned command text`

const EDITOR_SYSTEM_PROMPT = `You are a speech-to-text cleanup assistant for code editor input. The user may speak in any language or mix languages freely.

Rules:
- Fix punctuation and capitalization for prose in whatever language it is
- Preserve code tokens, variable names, filenames, and technical terms exactly
- Convert spoken punctuation: "open paren close paren" → "()", "backtick" → "\`"
- Convert spoken code patterns when confidence is high: "promise of string" → "Promise<string>"
- Preserve the original language — do not translate between languages
- Do not add explanations or commentary
- Do not change the meaning or intent of the text
- Return ONLY the cleaned text`

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return null
  return new Groq({ apiKey })
}

function getSttModel(): string {
  return process.env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_STT_MODEL
}

function getFormatterModel(): string {
  return process.env.GROQ_FORMATTER_MODEL || DEFAULT_FORMATTER_MODEL
}

function getFormatterPrompt(surface: string): string {
  return surface === 'terminal' ? TERMINAL_SYSTEM_PROMPT : EDITOR_SYSTEM_PROMPT
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
    formatterModel: getFormatterModel(),
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

  // Formatter LLM
  let displayText: string
  let formattingStatus: string
  let warning: string | undefined
  try {
    const completion = await groq.chat.completions.create({
      model: getFormatterModel(),
      messages: [
        { role: 'system', content: getFormatterPrompt(surface) },
        { role: 'user', content: rawText },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    })
    const formatted = completion.choices[0]?.message?.content
    if (formatted && formatted.trim()) {
      displayText = formatted.trim()
      formattingStatus = 'formatted'
    } else {
      displayText = rawText
      formattingStatus = 'fallback_raw'
      warning = 'Formatting failed; showing raw transcript.'
    }
  } catch {
    // Formatter failure → degrade to raw transcript
    displayText = rawText
    formattingStatus = 'fallback_raw'
    warning = 'Formatting failed; showing raw transcript.'
  }

  const response: Record<string, string> = { rawText, displayText, formattingStatus }
  if (warning) response.warning = warning
  return c.json(response)
})

export const voiceRoutes = app
