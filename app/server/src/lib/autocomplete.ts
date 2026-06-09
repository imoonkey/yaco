import { createHash } from 'crypto'
import OpenAI from 'openai'

const DEFAULT_MODELS = [
  'qwen/qwen3-32b',                    // 60 RPM, 1K RPD, strong prose
  'moonshotai/kimi-k2-instruct',       // 60 RPM, 1K RPD, fluent fallback
  'llama-3.1-8b-instant',              // 30 RPM, 14.4K RPD, fast fallback
]

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'
const TIMEOUT_MS = 3000
const MAX_TOKENS = 128

// A single inline suggestion: one line, bounded length.
const MAX_SUGGESTION_CHARS = 280

// Byte budgets for the prose context window (trimmed by whole lines).
const PREFIX_MAX_BYTES = 3 * 1024
const SUFFIX_MAX_BYTES = 1.5 * 1024

// Completion cache: small LRU with a short TTL. Empty results are cached for a
// shorter window so a transient "no good continuation" clears quickly.
const CACHE_MAX_ENTRIES = 64
const CACHE_TTL_MS = 5 * 60 * 1000
const EMPTY_CACHE_TTL_MS = 60 * 1000
// Bump when the context builder / prompt shape changes so old keys miss.
const CONTEXT_VERSION = 'v1'
const CACHE_KEY_PREFIX_CHARS = 1024
const CACHE_KEY_SUFFIX_CHARS = 512

const CURSOR = '<CURSOR>'

/** Extensions we treat as Markdown prose. */
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown'])

/** Models known to support reasoning_effort: 'none'. */
const REASONING_EFFORT_MODELS = ['qwen/qwen3-32b', 'qwen/qwen3-8b']

/** A fenced-code delimiter line: up to 3 spaces of indent then ``` or ~~~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** An ATX heading line: 1–6 `#` then text. */
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/

/** Strip <think>...</think> blocks that some models (e.g. Qwen3) emit. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
}

/** Extract file extension from path. */
function ext(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? ''
}

/** Strip control characters (incl. newlines) so untrusted text can't inject prompt content. */
function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, '')
}

function sanitizeFilePath(filePath: string): string {
  return stripControlChars(filePath)
}

export function isMarkdownPath(filePath?: string): boolean {
  return !!filePath && MARKDOWN_EXTS.has(ext(filePath))
}

/**
 * Paths whose contents are likely secrets — never send them to the model.
 * Matches .env*, *.pem/*.key/*.crt, id_rsa*, anything under .ssh/ or secrets/.
 */
export function isLikelySecretPath(filePath?: string): boolean {
  if (!filePath) return false
  const path = filePath.toLowerCase()
  const base = path.split('/').pop() ?? ''
  return (
    base.startsWith('.env') ||
    /\.(pem|key|crt)$/.test(base) ||
    base.startsWith('id_rsa') ||
    path.includes('.ssh/') ||
    /(^|\/)secrets\//.test(path)
  )
}

/** True when the cursor (end of `prefix`) sits inside an open fenced code block. */
export function isInsideFence(prefix: string): boolean {
  const lines = prefix.split('\n')
  let fence: string | null = null
  // Only complete lines (before the cursor's own line) can open/close a fence.
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(FENCE_RE)
    if (!m) continue
    if (fence === null) {
      fence = m[1]
    } else if (m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '') {
      fence = null
    }
  }
  return fence !== null
}

/**
 * The nearest H1>..>Hn heading chain above the cursor, ignoring headings that
 * live inside fenced code. Returns heading texts, shallowest first.
 */
export function extractHeadingPath(prefix: string): string[] {
  const path: { level: number; text: string }[] = []
  let fence: string | null = null
  for (const line of prefix.split('\n')) {
    const fm = line.match(FENCE_RE)
    if (fm) {
      if (fence === null) fence = fm[1]
      else if (fm[1][0] === fence[0] && fm[1].length >= fence.length && fm[2].trim() === '') fence = null
      continue
    }
    if (fence) continue
    const hm = line.match(HEADING_RE)
    if (!hm) continue
    const level = hm[1].length
    while (path.length && path[path.length - 1].level >= level) path.pop()
    path.push({ level, text: removeMarkers(stripControlChars(hm[2].trim())) })
  }
  return path.map((p) => p.text)
}

/** Keep whole lines from one end until the byte budget is exhausted. */
function trimLinesToFit(text: string, maxBytes: number, keepEnd: boolean): string {
  const lines = text.split('\n')
  const ordered = keepEnd ? [...lines].reverse() : lines
  const kept: string[] = []
  let total = 0
  for (const line of ordered) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for the newline
    if (total + lineBytes > maxBytes) break
    kept.push(line)
    total += lineBytes
  }
  return (keepEnd ? kept.reverse() : kept).join('\n')
}

/** Split a prefix into [earlier lines, current paragraph prefix] at the last blank line. */
function splitParagraphPrefix(prefix: string): [string, string] {
  const lines = prefix.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') {
      return [lines.slice(0, i).join('\n'), lines.slice(i + 1).join('\n')]
    }
  }
  return ['', prefix]
}

/** Split a suffix into [current paragraph suffix, later lines] at the first blank line. */
function splitParagraphSuffix(suffix: string): [string, string] {
  const lines = suffix.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      return [lines.slice(0, i).join('\n'), lines.slice(i + 1).join('\n')]
    }
  }
  return [suffix, '']
}

const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s/
const TABLE_ROW_RE = /^\s*\|/
const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s/

interface BlockSplit {
  before: string
  currentPrefix: string
  currentSuffix: string
  after: string
}

/**
 * Index of the list-item marker line owning the cursor, or null if the cursor is
 * not inside a list item. Walks up from the cursor line: a marker line owns it; a
 * blank line ends the search (the item didn't reach the cursor).
 */
function owningListItemStart(pLines: string[]): number | null {
  for (let i = pLines.length - 1; i >= 0; i--) {
    if (pLines[i].trim() === '') return null
    if (LIST_ITEM_RE.test(pLines[i])) return i
  }
  return null
}

/**
 * Carve out the markdown unit holding the cursor. Headings and table rows are
 * single-line units; a list item spans from its marker (even across continuation
 * lines) to the next item/blank; everything else is a blank-line paragraph.
 */
function splitCurrentBlock(prefix: string, suffix: string): BlockSplit {
  const pLines = prefix.split('\n')
  const sLines = suffix.split('\n')
  const curPrefixLine = pLines[pLines.length - 1]
  const curSuffixLine = sLines[0]
  const currentLine = curPrefixLine + curSuffixLine

  // Single-line units: heading or table row.
  if (HEADING_LINE_RE.test(currentLine) || TABLE_ROW_RE.test(currentLine)) {
    return {
      before: pLines.slice(0, -1).join('\n'),
      currentPrefix: curPrefixLine,
      currentSuffix: curSuffixLine,
      after: sLines.slice(1).join('\n'),
    }
  }

  // List item: from the owning marker (possibly above continuation lines) down to
  // the next item marker or blank line.
  const start = owningListItemStart(pLines)
  if (start !== null) {
    let end = sLines.length
    for (let i = 1; i < sLines.length; i++) {
      if (sLines[i].trim() === '' || LIST_ITEM_RE.test(sLines[i])) { end = i; break }
    }
    return {
      before: pLines.slice(0, start).join('\n'),
      currentPrefix: pLines.slice(start).join('\n'),
      currentSuffix: sLines.slice(0, end).join('\n'),
      after: sLines.slice(end).join('\n'),
    }
  }

  // Default: blank-line-delimited paragraph.
  const [before, currentPrefix] = splitParagraphPrefix(prefix)
  const [currentSuffix, after] = splitParagraphSuffix(suffix)
  return { before, currentPrefix, currentSuffix, after }
}

/** Remove any literal <CURSOR> sentinels from context so the inserted one stays unique. */
function removeMarkers(text: string): string {
  return text.split(CURSOR).join('')
}

export interface ProseContext {
  headingPath: string[]
  before: string
  currentBlock: string
  after: string
}

/**
 * Build the byte-budgeted prose context: the heading chain, earlier/later
 * context, and the single markdown unit holding the cursor (marked with exactly
 * one <CURSOR>).
 */
export function buildProseContext(prefix: string, suffix: string): ProseContext {
  const { before, currentPrefix, currentSuffix, after } = splitCurrentBlock(prefix, suffix)

  const blockPrefix = removeMarkers(trimLinesToFit(currentPrefix, PREFIX_MAX_BYTES, true))
  const blockSuffix = removeMarkers(trimLinesToFit(currentSuffix, SUFFIX_MAX_BYTES, false))

  return {
    headingPath: extractHeadingPath(prefix),
    before: removeMarkers(trimLinesToFit(before, PREFIX_MAX_BYTES, true)),
    currentBlock: `${blockPrefix}${CURSOR}${blockSuffix}`,
    after: removeMarkers(trimLinesToFit(after, SUFFIX_MAX_BYTES, false)),
  }
}

function buildSystemPrompt(filePath?: string): string {
  const safePath = filePath ? sanitizeFilePath(filePath) : undefined
  return [
    'You are an inline writing assistant that continues Markdown prose.',
    `Insert text exactly at the ${CURSOR} marker to continue the current sentence or paragraph.`,
    'Return only the text to insert — no explanations, labels, quotes, or code fences.',
    'Match the surrounding tone, voice, and formatting.',
    'Do not repeat text that already appears before or after the cursor.',
    'Do not begin a new heading, list item, table, or block quote.',
    'If a natural continuation is unclear, return an empty string.',
    safePath ? `File: ${safePath}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildUserPrompt(ctx: ProseContext): string {
  const heading = ctx.headingPath.length ? ctx.headingPath.join(' > ') : '(document root)'
  const parts = [`Section: ${heading}`]
  if (ctx.before.trim()) parts.push(`Earlier context:\n${ctx.before}`)
  parts.push(`Current block (continue at ${CURSOR}):\n${ctx.currentBlock}`)
  if (ctx.after.trim()) parts.push(`Later context:\n${ctx.after}`)
  return parts.join('\n\n')
}

// --- Postprocess: normalize the raw model output, then reject bad shapes. ---

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\b\s*[:=]\s*\S{6,}/i,
  /[A-Za-z0-9+/=_-]{40,}/, // long high-entropy token, unnatural in prose
]

const EXPLANATION_RE =
  /^(here(?:'?s| is)\b|sure[,!. ]|certainly\b|of course\b|as an?\b|i (?:can|will|cannot|can't|'?ll|'?m)\b|note:|okay\b|sorry\b)/i

/** Starts a new structural block (heading / list / table / block quote). */
const STRUCTURAL_START_RE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>\s)/

/** Output-format labels the model may prefix. */
const LABEL_RE = /^\s*(continuation|completion|suggestion|output|answer|result|response)\s*:\s*/i

/** Fill-in-the-middle / chat sentinel tokens that may leak into output. */
const FIM_TOKEN_RE = /<\|?(?:fim[_a-z]*|endoftext|im_start|im_end|cursor)\|?>/gi

/** Matched quote pairs that may wrap the whole output. */
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
]

function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

/**
 * Strip wrappers the model may add, in order: think blocks → whole-output code
 * fence / quotes / FIM tokens / stray markers → output label.
 */
function stripWrappers(text: string): string {
  let t = stripThinking(text)

  const fence = t.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/)
  if (fence) t = fence[1]

  t = t.replace(FIM_TOKEN_RE, '')
  t = removeMarkers(t)

  const trimmedT = t.trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmedT.length >= 2 && trimmedT.startsWith(open) && trimmedT.endsWith(close)) {
      t = trimmedT.slice(1, -1)
      break
    }
  }

  t = t.replace(LABEL_RE, '')
  return t
}

export interface PostprocessContext {
  /** Last non-empty line before the cursor (trimmed). */
  lineAbove: string
  /** Text after the cursor (the suffix). */
  afterText: string
  /** Full surrounding text, for URL-novelty checks. */
  contextText: string
}

/** Drop the longest exact overlap between the candidate's end and the suffix's start. */
function trimSuffixOverlap(candidate: string, suffix: string): string {
  const max = Math.min(candidate.length, suffix.length)
  for (let k = max; k > 0; k--) {
    if (candidate.endsWith(suffix.slice(0, k))) {
      return candidate.slice(0, candidate.length - k)
    }
  }
  return candidate
}

/**
 * Normalize raw model output into a single bounded line and reject anything that
 * is not a clean prose continuation: blank, an echo of the line above or the
 * suffix, an explanation, a new URL, a new structural block, or secret-looking
 * text. Suffix overlap is trimmed before rejection.
 */
export function postprocess(raw: string, ctx: PostprocessContext): string {
  let out = stripWrappers(raw)
    .replace(/^\n+/, '') // drop leading blank lines, keep a leading space
    .replace(/\s+$/, '') // trimEnd

  // Single line, bounded length.
  const nl = out.indexOf('\n')
  if (nl !== -1) out = out.slice(0, nl).replace(/\s+$/, '')
  if (out.length > MAX_SUGGESTION_CHARS) out = out.slice(0, MAX_SUGGESTION_CHARS)
  if (!out.trim()) return ''

  // Remove text the suffix already supplies; reject if nothing remains.
  out = trimSuffixOverlap(out, ctx.afterText)
  if (!out.trim()) return ''

  const firstLine = out
  const trimmed = out.trim()

  if (EXPLANATION_RE.test(trimmed)) return ''
  if (STRUCTURAL_START_RE.test(firstLine)) return ''

  if (ctx.lineAbove && (trimmed === ctx.lineAbove || firstLine.trim() === ctx.lineAbove)) return ''

  const afterTrim = ctx.afterText.trim()
  if (afterTrim) {
    if (afterTrim.startsWith(trimmed)) return ''
    const afterFirst = afterTrim.split('\n')[0]
    if (afterFirst.length >= 12 && trimmed.startsWith(afterFirst)) return ''
  }

  const urls = trimmed.match(/https?:\/\/[^\s)]+/gi) ?? []
  if (urls.some((u) => !ctx.contextText.includes(u))) return ''

  if (looksSecret(trimmed)) return ''

  return out
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim()
  }
  return ''
}

// --- Completion cache (LRU + TTL) ---

interface CacheEntry {
  result: { prediction: string; model: string }
  expires: number
}

const completionCache = new Map<string, CacheEntry>()

function cacheKey(model: string, prefix: string, suffix: string, headingPath: string[]): string {
  const hash = createHash('sha1')
    .update(headingPath.join('\x01'))
    .update('\x00')
    .update(prefix.slice(-CACHE_KEY_PREFIX_CHARS))
    .update('\x00')
    .update(suffix.slice(0, CACHE_KEY_SUFFIX_CHARS))
    .digest('hex')
  return `${model}\x00${CONTEXT_VERSION}\x00${hash}`
}

function cacheGet(key: string): { prediction: string; model: string } | null {
  const entry = completionCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    completionCache.delete(key)
    return null
  }
  completionCache.delete(key) // LRU: re-insert as most-recent
  completionCache.set(key, entry)
  return entry.result
}

function cacheSet(key: string, result: { prediction: string; model: string }, ttl: number): void {
  completionCache.set(key, { result, expires: Date.now() + ttl })
  while (completionCache.size > CACHE_MAX_ENTRIES) {
    const oldest = completionCache.keys().next().value
    if (oldest === undefined) break
    completionCache.delete(oldest)
  }
}

/** Clear the completion cache (test isolation). */
export function clearCompletionCache(): void {
  completionCache.clear()
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
 * Produce a Markdown prose continuation for the cursor between `prefix` and
 * `suffix`. Returns an empty prediction WITHOUT calling the model for
 * non-markdown paths, likely-secret paths, and cursor-inside-fenced-code.
 * Tries each model in order until one yields an acceptable completion.
 */
export async function complete(
  prefix: string,
  suffix: string,
  filePath?: string,
  signal?: AbortSignal,
): Promise<{ prediction: string; model: string }> {
  const empty = { prediction: '', model: '' }

  // Guards: never call the model for these.
  if (!isMarkdownPath(filePath)) return empty
  if (isLikelySecretPath(filePath)) return empty
  if (isInsideFence(prefix)) return empty

  const ctx = buildProseContext(prefix, suffix)
  const models = resolveAutocompleteModels()

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.AUTOCOMPLETE_BASE_URL || DEFAULT_BASE_URL,
  })

  const systemPrompt = buildSystemPrompt(filePath)
  const userPrompt = buildUserPrompt(ctx)
  const postCtx: PostprocessContext = {
    lineAbove: lastNonEmptyLine(prefix),
    afterText: suffix,
    contextText: prefix + suffix,
  }

  for (const model of models) {
    const key = cacheKey(model, prefix, suffix, ctx.headingPath)
    const cached = cacheGet(key)
    if (cached) {
      // A cached non-empty result for this model wins; a cached empty means
      // "this model had nothing" — skip it without re-querying.
      if (cached.prediction) return cached
      continue
    }

    try {
      const params: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS,
      }

      if (REASONING_EFFORT_MODELS.some((m) => model.startsWith(m))) {
        params.reasoning_effort = 'none'
      }

      const completion = await client.chat.completions.create(
        params as Parameters<typeof client.chat.completions.create>[0],
        { timeout: TIMEOUT_MS, signal },
      )

      const raw = completion.choices[0]?.message?.content ?? ''
      const prediction = postprocess(raw, postCtx)
      if (prediction) {
        const result = { prediction, model }
        cacheSet(key, result, CACHE_TTL_MS)
        return result
      }
      // The model answered but produced nothing usable — cache the miss briefly.
      cacheSet(key, empty, EMPTY_CACHE_TTL_MS)
    } catch {
      // Transient failure (rate limit, timeout) — do not cache; try next model.
    }
  }

  return empty
}
