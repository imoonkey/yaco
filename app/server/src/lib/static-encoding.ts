/**
 * Static-asset content-encoding negotiation.
 *
 * This module is RFC 9110 §12.4.2-aware: it parses Accept-Encoding
 * case-insensitively, honors explicit q-values (missing q defaults to 1.0,
 * malformed entries are dropped), treats `*` as a fallback for unlisted
 * codings, and gives an implicit identity the default weight of 1.0 (vs. 0
 * for unlisted br/gzip). Highest non-zero q wins; ties break br > gzip >
 * identity.
 *
 * DELIBERATE DIVERGENCE FROM STRICT COMPLIANCE: a strict server would
 * return 406 Not Acceptable when every candidate has q=0 (e.g. the client
 * sent `Accept-Encoding: *;q=0` or `identity;q=0` with no compressed
 * sibling on disk). Workflow is a local-first single-user app where
 * serving any bytes always beats a hard failure, so this helper falls
 * back to `identity` in that case — matching nginx's `gzip_static`
 * behavior. Callers are responsible for choosing whether to surface 406
 * elsewhere if true strict compliance is ever needed.
 *
 * No I/O, no startup side effects — both exports are pure functions.
 */

type Encoding = 'br' | 'gzip' | 'identity'

interface ParsedEntry {
  coding: string // already lowercased
  q: number // [0, 1]
}

interface AvailableSiblings {
  /** A `.br` sibling exists on disk for this asset. */
  br: boolean
  /** A `.gz` sibling exists on disk for this asset. */
  gz: boolean
}

/**
 * Select the best content-coding to serve for a static asset, given the
 * client's Accept-Encoding header and which precompressed siblings exist
 * on disk.
 *
 * @param acceptEncoding raw header value (may be null/undefined/empty)
 * @param available which precompressed siblings are on disk
 * @returns the chosen coding; identity is always safe to return
 *
 * @example
 *   pickEncoding('br, gzip', { br: true, gz: true })       // 'br'
 *   pickEncoding('gzip;q=1, br;q=0.2', { br: true, gz: true }) // 'gzip'
 *   pickEncoding('*;q=0', { br: true, gz: true })          // 'identity' (lenient)
 *   pickEncoding(null, { br: true, gz: true })             // 'identity'
 */
export function pickEncoding(
  acceptEncoding: string | null | undefined,
  available: AvailableSiblings,
): Encoding {
  const entries = parseAcceptEncoding(acceptEncoding ?? '')

  const candidates: Array<{ coding: Encoding; q: number; rank: number }> = []

  if (available.br) {
    const q = effectiveQ('br', entries)
    if (q > 0) candidates.push({ coding: 'br', q, rank: 2 })
  }
  if (available.gz) {
    const q = effectiveQ('gzip', entries)
    if (q > 0) candidates.push({ coding: 'gzip', q, rank: 1 })
  }
  const identityQ = effectiveQ('identity', entries)
  if (identityQ > 0) candidates.push({ coding: 'identity', q: identityQ, rank: 0 })

  if (candidates.length === 0) return 'identity'

  candidates.sort((a, b) => (b.q !== a.q ? b.q - a.q : b.rank - a.rank))
  return candidates[0].coding
}

/**
 * Minimal Headers-like surface that `appendVary` needs. The standard web
 * `Headers` class and Hono's `c.res.headers` both satisfy this shape.
 */
interface HeadersLike {
  get(name: string): string | null
  set(name: string, value: string): void
}

/**
 * Append a field name to the Vary response header, mutating `headers`.
 *
 * - Unset Vary  -> set to `field`
 * - Existing `*` (alone or in a list) -> normalize to `*` (it already
 *   means "varies on anything", so adding fields is meaningless)
 * - `field === '*'` -> collapse Vary to `*`
 * - Otherwise comma-split, case-insensitive dedupe, append, re-join
 */
export function appendVary(headers: HeadersLike, field: string): void {
  const existing = headers.get('Vary')

  if (existing === null || existing.trim() === '') {
    headers.set('Vary', field)
    return
  }

  const parts = existing
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (parts.some((p) => p === '*') || field === '*') {
    headers.set('Vary', '*')
    return
  }

  const lowerField = field.toLowerCase()
  if (parts.some((p) => p.toLowerCase() === lowerField)) {
    headers.set('Vary', parts.join(', '))
    return
  }

  headers.set('Vary', [...parts, field].join(', '))
}

// --- internal helpers --------------------------------------------------

function parseAcceptEncoding(header: string): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  for (const raw of header.split(',')) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue

    const parts = trimmed.split(';').map((p) => p.trim())
    const coding = parts[0].toLowerCase()
    if (coding.length === 0) continue

    let q = 1
    let malformed = false
    for (let i = 1; i < parts.length; i++) {
      const param = parts[i]
      const eq = param.indexOf('=')
      if (eq < 0) continue
      const name = param.slice(0, eq).trim().toLowerCase()
      if (name !== 'q') continue
      const value = param.slice(eq + 1).trim()
      const parsed = parseQValue(value)
      if (parsed === null) {
        malformed = true
        break
      }
      q = parsed
    }
    if (malformed) continue
    entries.push({ coding, q })
  }
  return entries
}

const Q_VALUE_RE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

function parseQValue(v: string): number | null {
  if (!Q_VALUE_RE.test(v)) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return n
}

function effectiveQ(coding: Encoding, entries: ParsedEntry[]): number {
  const explicit = entries.find((e) => e.coding === coding)
  if (explicit) return explicit.q
  const star = entries.find((e) => e.coding === '*')
  if (star) return star.q
  return coding === 'identity' ? 1 : 0
}
