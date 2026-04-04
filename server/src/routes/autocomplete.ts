import { Hono } from 'hono'
import OpenAI from 'openai'
import { fail } from '../lib/response.js'
import { complete, isAutocompleteEnabled, getAutocompleteModel } from '../lib/autocomplete.js'

const MAX_BODY_BYTES = 32 * 1024

const app = new Hono()

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

  // Size gate
  const raw = await c.req.text()
  if (raw.length > MAX_BODY_BYTES) {
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
  if (filePath !== undefined) {
    if (typeof filePath !== 'string' || filePath.startsWith('/') || filePath.includes('..')) {
      return fail(c, 400, 'filePath must be a relative path.')
    }
  }

  try {
    const signal = c.req.raw.signal
    const result = await complete(prefix, suffix, filePath as string | undefined, signal)
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
