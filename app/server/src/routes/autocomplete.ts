import { Hono } from 'hono'
import OpenAI from 'openai'
import { fail } from '../lib/response.js'
import { complete, isAutocompleteEnabled, getAutocompleteModel } from '../lib/autocomplete.js'

const MAX_BODY_BYTES = 32 * 1024
const MAX_FILEPATH_CHARS = 256

const app = new Hono()

/** Reject control chars (incl. newlines) so a filePath can't inject prompt text. */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

/** Validate a repo-relative filePath. Returns the path, undefined (absent), or null (invalid). */
function normalizeSafeFilePath(filePath: unknown): string | null | undefined {
  if (filePath === undefined) return undefined
  if (typeof filePath !== 'string') return null

  const normalized = filePath.trim()
  if (normalized === '') return undefined
  if (
    normalized.length > MAX_FILEPATH_CHARS ||
    hasControlChars(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
    // Allow unicode letters/digits, spaces and a few path-safe punctuation marks;
    // filePath is only a prompt hint here, so this blocks injection chars (< > ` " etc.)
    // while still accepting legal markdown filenames the ASCII-only rule would reject.
    !/^[\p{L}\p{N}._@+ /-]+$/u.test(normalized)
  ) {
    return null
  }

  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  return normalized
}

app.get('/status', (c) => {
  return c.json({
    enabled: isAutocompleteEnabled(),
    model: getAutocompleteModel(),
  })
})

app.post('/complete', async (c) => {
  if (!isAutocompleteEnabled()) {
    return fail(c, 503, 'Autocomplete is unavailable. Set GROQ_API_KEY.')
  }

  // Size gate (measure UTF-8 bytes, not UTF-16 code units)
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return fail(c, 413, 'Request body too large.')
  }

  let body: { prefix?: unknown; suffix?: unknown; filePath?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(c, 400, 'Invalid JSON.')
  }

  const { prefix, suffix, filePath } = body
  if (typeof prefix !== 'string' || typeof suffix !== 'string') {
    return fail(c, 400, 'prefix and suffix must be strings.')
  }

  const safeFilePath = normalizeSafeFilePath(filePath)
  if (safeFilePath === null) {
    return fail(c, 400, 'filePath must be a safe relative path.')
  }

  try {
    const signal = c.req.raw.signal
    const result = await complete(prefix, suffix, safeFilePath, signal)
    return c.json({ prediction: result.prediction })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.json({ prediction: '' })
    }
    if (err instanceof OpenAI.APIError) {
      if (err.status === 429) {
        return fail(c, 429, 'Rate limit reached. Try again shortly.')
      }
      return fail(c, 502, 'Completion failed. Try again.')
    }
    if (err instanceof OpenAI.APIConnectionError) {
      return fail(c, 502, 'Completion failed. Try again.')
    }
    return fail(c, 502, 'Completion failed. Try again.')
  }
})

export const autocompleteRoutes = app
