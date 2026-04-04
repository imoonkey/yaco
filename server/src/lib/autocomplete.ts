import OpenAI from 'openai'
import { FILE_TYPE_MAP } from './voice-prompts.js'

const DEFAULT_MODELS = [
  'qwen/qwen3-32b',                    // 60 RPM, 1K RPD, best code quality
  'moonshotai/kimi-k2-instruct',       // 60 RPM, 1K RPD, strong code
  'llama-3.1-8b-instant',              // 30 RPM, 14.4K RPD, fast fallback
]

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'
const TIMEOUT_MS = 3000

const PREFIX_HEADER_LINES = 15
const PREFIX_HEADER_THRESHOLD = 30
const PREFIX_TAIL_LINES = 80
const PREFIX_MAX_BYTES = 6 * 1024
const SUFFIX_LINES = 30
const SUFFIX_MAX_BYTES = 2 * 1024

/** Strip <think>...</think> blocks that some models (e.g. Qwen3) emit */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
}

/** Extract file extension from path */
function ext(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? ''
}

/** Truncate lines from end until total byte size fits within cap */
function trimLinesToFit(lines: string[], maxBytes: number, fromEnd: boolean): string[] {
  let total = 0
  const result: string[] = []
  const ordered = fromEnd ? [...lines].reverse() : lines
  for (const line of ordered) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for \n
    if (total + lineBytes > maxBytes) break
    result.push(line)
    total += lineBytes
  }
  return fromEnd ? result.reverse() : result
}

/** Truncate prefix: header (first 15 lines if far from top) + last 80 lines, capped ~6KB */
function truncatePrefix(prefix: string): string {
  const lines = prefix.split('\n')

  let window: string[]
  if (lines.length > PREFIX_HEADER_THRESHOLD) {
    const header = lines.slice(0, PREFIX_HEADER_LINES)
    const tail = lines.slice(-PREFIX_TAIL_LINES)
    window = [...header, '', ...tail]
  } else if (lines.length > PREFIX_TAIL_LINES) {
    window = lines.slice(-PREFIX_TAIL_LINES)
  } else {
    window = lines
  }

  return trimLinesToFit(window, PREFIX_MAX_BYTES, true).join('\n')
}

/** Truncate suffix: next 30 lines, capped ~2KB */
function truncateSuffix(suffix: string): string {
  const lines = suffix.split('\n').slice(0, SUFFIX_LINES)
  return trimLinesToFit(lines, SUFFIX_MAX_BYTES, false).join('\n')
}

/** Models known to support reasoning_effort: 'none' */
const REASONING_EFFORT_MODELS = ['qwen/qwen3-32b', 'qwen/qwen3-8b']

function sanitizeFilePath(filePath: string): string {
  return filePath.replace(/[\x00-\x1f\x7f]/g, '')
}

function buildSystemPrompt(filePath?: string): string {
  const lang = filePath ? FILE_TYPE_MAP[ext(filePath)] : undefined
  const safePath = filePath ? sanitizeFilePath(filePath) : undefined
  return `You are a code completion engine. Return only the exact text to insert at the cursor.
If the best completion is uncertain, return an empty string.
Do not repeat surrounding code. Do not use markdown fences.${lang ? `\nLanguage: ${lang}` : ''}${safePath ? `\nFile: ${safePath}` : ''}`
}

function buildUserPrompt(prefix: string, suffix: string): string {
  return JSON.stringify({ prefix, suffix })
}

export function isAutocompleteEnabled(): boolean {
  return !!process.env.GROQ_API_KEY
}

/**
 * Parse model list from env vars.
 * Priority: AUTOCOMPLETE_MODELS (comma-separated) > AUTOCOMPLETE_MODEL (single) > defaults.
 */
export function resolveAutocompleteModels(): string[] {
  const multi = process.env.AUTOCOMPLETE_MODELS
  if (multi) {
    const models = multi.split(',').map((m) => m.trim()).filter(Boolean)
    if (models.length > 0) return models
  }
  const single = process.env.AUTOCOMPLETE_MODEL
  if (single) return [single]
  return DEFAULT_MODELS
}

export function getAutocompleteModel(): string {
  return resolveAutocompleteModels()[0]
}

/**
 * Try each model in order until one succeeds (same pattern as voice-formatter.ts).
 * Returns prediction on success, or empty string if all models fail.
 */
export async function complete(
  prefix: string,
  suffix: string,
  filePath?: string,
  signal?: AbortSignal,
): Promise<{ prediction: string; model: string }> {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.AUTOCOMPLETE_BASE_URL || DEFAULT_BASE_URL,
  })
  const models = resolveAutocompleteModels()

  const truncatedPrefix = truncatePrefix(prefix)
  const truncatedSuffix = truncateSuffix(suffix)
  const systemPrompt = buildSystemPrompt(filePath)
  const userPrompt = buildUserPrompt(truncatedPrefix, truncatedSuffix)

  for (const model of models) {
    try {
      const params: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 128,
      }

      if (REASONING_EFFORT_MODELS.some((m) => model.startsWith(m))) {
        params.reasoning_effort = 'none'
      }

      const completion = await client.chat.completions.create(
        params as Parameters<typeof client.chat.completions.create>[0],
        { timeout: TIMEOUT_MS, signal },
      )

      const raw = completion.choices[0]?.message?.content
      const prediction = raw ? stripThinking(raw).trimEnd() : ''
      if (prediction) {
        return { prediction, model }
      }
    } catch {
      // Try next model (rate limit, timeout, etc.)
    }
  }

  return { prediction: '', model: '' }
}
