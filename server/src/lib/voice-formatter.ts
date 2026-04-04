import OpenAI from 'openai'

const DEFAULT_MODELS = [
  'qwen/qwen3-32b',
  'moonshotai/kimi-k2-instruct-0905',
  'openai/gpt-oss-120b',
]

const TIMEOUT_MS = 5000

/** Strip <think>...</think> blocks that some models (e.g. Qwen3) emit */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
}

/**
 * Parse formatter model list from env vars.
 * Priority: VOICE_FORMATTER_MODELS (comma-separated) > GROQ_FORMATTER_MODEL (single) > defaults.
 */
export function resolveFormatterModels(): string[] {
  const multi = process.env.VOICE_FORMATTER_MODELS
  if (multi) {
    const models = multi.split(',').map((m) => m.trim()).filter(Boolean)
    if (models.length > 0) return models
  }

  const single = process.env.GROQ_FORMATTER_MODEL
  if (single) return [single]

  return DEFAULT_MODELS
}

export interface FormatResult {
  text: string
  model: string
  status: 'formatted' | 'fallback_raw'
  warning?: string
}

/**
 * Try each model in order until one succeeds. All use the same API key + base URL.
 * Returns formatted text on success, or raw input text if all models fail.
 */
export async function formatWithFallback(
  models: string[],
  systemPrompt: string,
  text: string,
): Promise<FormatResult> {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.VOICE_FORMATTER_BASE_URL || 'https://api.groq.com/openai/v1',
  })

  for (const model of models) {
    try {
      const params: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      }

      // Disable thinking for models that support it (Qwen3)
      if (model.includes('qwen')) {
        params.reasoning_format = 'none'
      }

      const completion = await client.chat.completions.create(
        params as Parameters<typeof client.chat.completions.create>[0],
        { timeout: TIMEOUT_MS },
      )

      const raw = completion.choices[0]?.message?.content
      const formatted = raw ? stripThinking(raw).trim() : ''
      if (formatted) {
        return { text: formatted, model, status: 'formatted' }
      }
    } catch {
      // Try next model
    }
  }

  return {
    text,
    model: '',
    status: 'fallback_raw',
    warning: 'Formatting failed; showing raw transcript.',
  }
}
