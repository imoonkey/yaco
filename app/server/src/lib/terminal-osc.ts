import { readFileSync } from 'fs'
import { join } from 'path'
import { AGENT_SESSIONS_DIR } from './constants'
import { validateSessionName } from './session-names'

export interface TerminalPalette {
  foreground: string
  background: string
  cursor: string
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const OSC_ST = '\x1b\\'
const OSC_BEL = '\x07'
const QUERY_SLOTS = [10, 11, 12] as const
const DEFAULT_TERMINAL_PALETTE: TerminalPalette = {
  foreground: '#657b83',
  background: '#fdf6e3',
  cursor: '#657b83',
}

type QuerySlot = typeof QUERY_SLOTS[number]

const QUERY_PATTERNS = QUERY_SLOTS.flatMap(slot => [
  { slot, query: `\x1b]${slot};?${OSC_ST}` },
  { slot, query: `\x1b]${slot};?${OSC_BEL}` },
])
const QUERY_PREFIXES = QUERY_PATTERNS.flatMap(({ query }) =>
  Array.from({ length: query.length - 1 }, (_, index) => query.slice(0, index + 1))
)

export function parseTerminalPalette(input: unknown): TerminalPalette | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const foreground = normalizeHexColor(value.foreground)
  const background = normalizeHexColor(value.background)
  const cursor = normalizeHexColor(value.cursor)
  return foreground && background && cursor ? { foreground, background, cursor } : null
}

export function terminalPaletteFromSearchParams(params: URLSearchParams): TerminalPalette {
  return {
    foreground: normalizeHexColor(params.get('fg')) ?? DEFAULT_TERMINAL_PALETTE.foreground,
    background: normalizeHexColor(params.get('bg')) ?? DEFAULT_TERMINAL_PALETTE.background,
    cursor: normalizeHexColor(params.get('cursor')) ?? DEFAULT_TERMINAL_PALETTE.cursor,
  }
}

export function shouldAnswerTerminalOscColor(sessionName: string, sessionsDir = AGENT_SESSIONS_DIR): boolean {
  validateSessionName(sessionName)
  try {
    const raw = readFileSync(join(sessionsDir, `${sessionName}.json`), 'utf-8')
    const parsed = JSON.parse(raw) as { provider?: unknown }
    return parsed.provider === 'codex'
  } catch {
    return false
  }
}

export class TerminalOscColorResponder {
  private pending = ''

  constructor(
    private readonly enabled: boolean,
    private palette: TerminalPalette,
  ) {}

  updatePalette(palette: TerminalPalette): void {
    this.palette = palette
  }

  handle(data: string): { output: string; responses: string[] } {
    if (!this.enabled) return { output: data, responses: [] }

    const responses: string[] = []
    let output = ''
    let rest = this.pending + data
    this.pending = ''

    while (rest) {
      const match = findNextQuery(rest)
      if (!match) {
        output += rest
        break
      }

      output += rest.slice(0, match.index)
      responses.push(oscColorResponse(match.slot, this.palette))
      rest = rest.slice(match.index + match.query.length)
    }

    // Hold any possible query prefix at the chunk boundary. A bare ESC is a
    // valid prefix, so Codex chunks ending exactly on ESC are delivered after
    // the next chunk confirms whether this is an OSC color query.
    const pending = longestQueryPrefixSuffix(output)
    if (pending) {
      this.pending = pending
      output = output.slice(0, -pending.length)
    }

    return { output, responses }
  }
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : null
}

function findNextQuery(data: string): { index: number; query: string; slot: QuerySlot } | null {
  let best: { index: number; query: string; slot: QuerySlot } | null = null
  for (const pattern of QUERY_PATTERNS) {
    const index = data.indexOf(pattern.query)
    if (index === -1) continue
    if (!best || index < best.index) best = { ...pattern, index }
  }
  return best
}

function longestQueryPrefixSuffix(value: string): string {
  let longest = ''
  for (const prefix of QUERY_PREFIXES) {
    if (prefix.length > longest.length && value.endsWith(prefix)) longest = prefix
  }
  return longest
}

function oscColorResponse(slot: QuerySlot, palette: TerminalPalette): string {
  const color = slot === 10
    ? palette.foreground
    : slot === 11
      ? palette.background
      : palette.cursor
  return `\x1b]${slot};rgb:${hexToRgbPayload(color)}${OSC_ST}`
}

function hexToRgbPayload(color: string): string {
  const r = color.slice(1, 3)
  const g = color.slice(3, 5)
  const b = color.slice(5, 7)
  return `${r}${r}/${g}${g}/${b}${b}`
}
