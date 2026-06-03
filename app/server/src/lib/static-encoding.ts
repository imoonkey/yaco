/**
 * Static-asset content-encoding negotiation.
 *
 * This module is RFC 9110 §12.4.2-aware: it parses Accept-Encoding
 * case-insensitively, honors explicit q-values (missing q defaults to 1.0;
 * non-numeric q values drop the entry; numeric q values outside [0, 1]
 * are clamped), treats `*` as a fallback for unlisted codings, and gives
 * an implicit identity the default weight of 1.0 (vs. 0 for unlisted
 * br/gzip). Highest non-zero q wins; ties break br > gzip > identity.
 *
 * DELIBERATE DIVERGENCES FROM STRICT COMPLIANCE:
 *
 *   1. When the client explicitly forbids identity (`identity;q=0`) but
 *      doesn't mention br/gzip, a strict server would still treat br/gzip
 *      as q=0 (unacceptable) and have to 406. We instead let unlisted
 *      compressed codings inherit the implicit-acceptable mantle (q=1.0)
 *      that identity normally carries — the client clearly wants
 *      compression, and we have it on disk.
 *
 *   2. When every candidate is q=0, a strict server returns 406 Not
 *      Acceptable. Workflow is a local-first single-user app where
 *      serving any bytes always beats a hard failure, so this helper
 *      falls back to `identity` in that case — matching nginx's
 *      `gzip_static` behavior. Callers are responsible for choosing
 *      whether to surface 406 elsewhere if true strict compliance is
 *      ever needed.
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

/**
 * Parse a q-value parameter. Truly unparseable values (empty, non-numeric
 * like `abc`, `1.0.0`) return null so the caller drops the whole entry.
 * Numeric values outside [0, 1] (e.g. `2`, `-0.5`, `1.5`) are clamped
 * rather than dropped — a client over-asking is still asking.
 */
function parseQValue(v: string): number | null {
  if (v.length === 0) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function effectiveQ(coding: Encoding, entries: ParsedEntry[]): number {
  const explicit = entries.find((e) => e.coding === coding)
  if (explicit) return explicit.q
  const star = entries.find((e) => e.coding === '*')
  if (star) return star.q
  if (coding === 'identity') return 1
  // br/gzip default: 0 (unlisted means unacceptable), UNLESS the client
  // explicitly forbade identity (`identity;q=0`). In that case the
  // "implicitly acceptable" mantle has to land somewhere — passing it to
  // the compressed codings keeps the response shippable and respects the
  // client's clearly-signalled preference for compression.
  const identityForbidden = entries.some((e) => e.coding === 'identity' && e.q === 0)
  return identityForbidden ? 1 : 0
}
