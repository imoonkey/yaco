import OpenAI from 'openai'
import {
  buildFormatterUserMessage,
  buildSpeakifyPrompt,
  buildSpeakifyUserMessage,
} from './voice-prompts'

const DEFAULT_MODELS = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
]

/** Spoken-paraphrase model chain: quality-first. The paraphrase must preserve the
 *  original language (small/fast models like llama-3.1-8b translate 中文→English)
 *  and faithfully render the content, so a capable instruction-follower leads; the
 *  fast model is only a last-resort fallback. Latency matters less now the read-back
 *  is a paragraph, not one sentence. */
const DEFAULT_SPEAK_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
]

const TIMEOUT_MS = 5000

/** Spoken paraphrase preserves the message's information (not a summary), so it
 *  needs room — a faithful rendering of the full notice can be a short paragraph.
 *  Bounded by tokens (not truncated mid-thought) with the raw notice as the
 *  fallback when slow. */
const SPEAK_MAX_TOKENS = 2048
const SPEAK_TIMEOUT_MS = 5000

/** Strip <think>...</think> blocks that some models (e.g. Qwen3) emit */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
}

function stripOuterFence(text: string): string {
  const match = text.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```$/)
  return match?.[1]?.trim() ?? text
}

function stripLeadingBoilerplate(text: string): string {
  const patterns = [
    /^here(?:'s| is) (?:the )?(?:cleaned|formatted|rewritten|final) text:\s*/i,
    /^the (?:cleaned|formatted|rewritten|final) text is:\s*/i,
    /^整理如下[:：]\s*/,
    /^优化如下[:：]\s*/,
    /^以下是(?:整理|优化|格式化)?后的内容[:：]\s*/,
    /^结构化整理如下[:：]\s*/,
  ]

  let output = text
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = output.replace(pattern, '')
      if (next !== output) {
        output = next.trimStart()
        changed = true
      }
    }
  }
  return output
}

function stripSurroundingQuotes(text: string): string {
  if (text.includes('\n')) return text
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ] as const

  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      return text.slice(open.length, -close.length).trim()
    }
  }
  return text
}

function cleanFormatterOutput(text: string): string {
  const withoutThinking = stripThinking(text).trim()
  const withoutFence = stripOuterFence(withoutThinking)
  const withoutBoilerplate = stripLeadingBoilerplate(withoutFence).trim()
  return stripSurroundingQuotes(withoutBoilerplate).trim()
}

function applyModelReasoningParams(model: string, params: Record<string, unknown>): void {
  if (model.includes('qwen')) {
    params.reasoning_effort = 'none'
    params.reasoning_format = 'hidden'
    return
  }

  if (model.includes('gpt-oss')) {
    params.reasoning_effort = 'low'
    params.reasoning_format = 'hidden'
  }
}

/** Split a comma-separated model env var into a clean list, or null when unset/empty. */
function parseModelEnv(value: string | undefined): string[] | null {
  if (!value) return null
  const models = value.split(',').map((m) => m.trim()).filter(Boolean)
  return models.length > 0 ? models : null
}

/**
 * Parse formatter model list from env vars.
 * Priority: VOICE_FORMATTER_MODELS (comma-separated) > GROQ_FORMATTER_MODEL (single) > defaults.
 */
export function resolveFormatterModels(): string[] {
  return (
    parseModelEnv(process.env.VOICE_FORMATTER_MODELS) ??
    (process.env.GROQ_FORMATTER_MODEL ? [process.env.GROQ_FORMATTER_MODEL] : DEFAULT_MODELS)
  )
}

/** Spoken-paraphrase model list. Priority: VOICE_SPEAK_MODELS > quality-first defaults. */
export function resolveSpeakModels(): string[] {
  return parseModelEnv(process.env.VOICE_SPEAK_MODELS) ?? DEFAULT_SPEAK_MODELS
}

export interface FormatResult {
  text: string
  model: string
  status: 'formatted' | 'fallback_raw'
  warning?: string
}

/** Concise reason for a failed formatter attempt, so the cause (rate limit vs
 *  timeout vs empty) is visible in the server log instead of silently swallowed.
 *  Duck-typed on the error shape (the OpenAI error classes aren't always present,
 *  e.g. under test mocks). */
function describeFormatError(err: unknown): string {
  const status = (err as { status?: unknown })?.status
  if (typeof status === 'number') {
    const code = (err as { code?: unknown }).code
    return `HTTP ${status}${typeof code === 'string' ? ` ${code}` : ''}` // e.g. "HTTP 429 rate_limit_exceeded"
  }
  if (err instanceof Error) return err.constructor?.name || err.name || 'Error' // e.g. APITimeoutError
  return String(err)
}

/** Caller-owned generation budget. The formatter and the spoken rewrite want
 *  different output sizes and timeouts, so neither is baked into the shared loop. */
export interface CompleteOptions {
  maxTokens: number
  timeoutMs: number
  logLabel: string
}

/**
 * Try each model in order until one returns non-empty cleaned output. All share
 * the same API key + base URL. Returns `{ text, model }` on the first success, or
 * `null` when every model fails or returns empty — the caller owns the fallback
 * (the formatter falls back to the raw transcript, the rewrite to the raw notice),
 * so the raw value is never wrapped inside this loop.
 */
export async function completeWithFallback(
  models: string[],
  systemPrompt: string,
  userMessage: string,
  opts: CompleteOptions,
): Promise<{ text: string; model: string } | null> {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.VOICE_FORMATTER_BASE_URL || 'https://api.groq.com/openai/v1',
    // No SDK-level retries: the sequential model fallback below IS our retry, and
    // the default maxRetries (2) would multiply each model's timeout up to 3×,
    // blowing past the caller's budget and forcing a raw fallback.
    maxRetries: 0,
  })

  for (const model of models) {
    try {
      const params: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: opts.maxTokens,
      }

      applyModelReasoningParams(model, params)

      const completion = await client.chat.completions.create(
        params as Parameters<typeof client.chat.completions.create>[0],
        { timeout: opts.timeoutMs },
      )

      const raw = completion.choices[0]?.message?.content
      const cleaned = raw ? cleanFormatterOutput(raw) : ''
      if (cleaned) return { text: cleaned, model }
      console.warn(`[${opts.logLabel}] model ${model} returned empty output; trying next`)
    } catch (err) {
      console.warn(`[${opts.logLabel}] model ${model} failed: ${describeFormatError(err)}; trying next`)
    }
  }

  console.warn(`[${opts.logLabel}] all ${models.length} model(s) failed`)
  return null
}

/**
 * STT formatter: clean a raw transcript into insertable text. Thin wrapper over
 * completeWithFallback that owns the raw-transcript fallback.
 */
export async function formatWithFallback(
  models: string[],
  systemPrompt: string,
  text: string,
): Promise<FormatResult> {
  const result = await completeWithFallback(models, systemPrompt, buildFormatterUserMessage(text), {
    maxTokens: 2048,
    timeoutMs: TIMEOUT_MS,
    logLabel: 'voice-format',
  })
  if (result) return { text: result.text, model: result.model, status: 'formatted' }
  return {
    text,
    model: '',
    status: 'fallback_raw',
    warning: 'Formatting failed; showing raw transcript.',
  }
}

/**
 * Paraphrase a written status notification into natural spoken text for TTS,
 * preserving the information (structure described, not summarized away). Returns
 * the raw notice unchanged on any failure/empty/timeout — the v1 string is already
 * speakable, just not pretty.
 */
export async function rewriteForSpeech(text: string): Promise<string> {
  const result = await completeWithFallback(
    resolveSpeakModels(),
    buildSpeakifyPrompt(),
    buildSpeakifyUserMessage(text),
    { maxTokens: SPEAK_MAX_TOKENS, timeoutMs: SPEAK_TIMEOUT_MS, logLabel: 'voice-speak' },
  )
  return result?.text ?? text
}
