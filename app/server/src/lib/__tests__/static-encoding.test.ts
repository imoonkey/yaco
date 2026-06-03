import { describe, it, expect } from 'vitest'
import { pickEncoding, appendVary } from '../static-encoding'

const both = { br: true, gz: true } as const
const gzOnly = { br: false, gz: true } as const
const brOnly = { br: true, gz: false } as const
const neither = { br: false, gz: false } as const

describe('pickEncoding — design.md §3 case matrix', () => {
  it('missing header (null) → identity', () => {
    expect(pickEncoding(null, both)).toBe('identity')
  })

  it('missing header (undefined) → identity', () => {
    expect(pickEncoding(undefined, both)).toBe('identity')
  })

  it('empty header → identity', () => {
    expect(pickEncoding('', both)).toBe('identity')
  })

  it('whitespace-only header → identity', () => {
    expect(pickEncoding('   ', both)).toBe('identity')
  })

  it('gzip alone, gzip sibling → gzip', () => {
    expect(pickEncoding('gzip', gzOnly)).toBe('gzip')
  })

  it('br + gzip both at implicit q=1.0 (tie) → br', () => {
    expect(pickEncoding('br, gzip', both)).toBe('br')
  })

  it('br;q=0, gzip;q=1 → gzip (br forbidden)', () => {
    expect(pickEncoding('br;q=0, gzip;q=1', both)).toBe('gzip')
  })

  it('gzip;q=1, br;q=0.2 → gzip (HIGHEST Q WINS, not br pref order)', () => {
    expect(pickEncoding('gzip;q=1, br;q=0.2', both)).toBe('gzip')
  })

  it('br;q=0.4, gzip;q=0.8 → gzip (gzip higher q)', () => {
    expect(pickEncoding('br;q=0.4, gzip;q=0.8', both)).toBe('gzip')
  })

  it('br;q=0.5, gzip;q=0.5 (tie) → br (tie-break)', () => {
    expect(pickEncoding('br;q=0.5, gzip;q=0.5', both)).toBe('br')
  })

  it('identity;q=1, br;q=0.5 → identity (identity can win!)', () => {
    expect(pickEncoding('identity;q=1, br;q=0.5', both)).toBe('identity')
  })

  it('identity;q=0 with br + gzip on disk → br (lenient fix: client wants compression)', () => {
    expect(pickEncoding('identity;q=0', both)).toBe('br')
  })

  it('identity;q=0 with gzip on disk only → gzip', () => {
    expect(pickEncoding('identity;q=0', gzOnly)).toBe('gzip')
  })

  it('identity;q=0 with br on disk only → br', () => {
    expect(pickEncoding('identity;q=0', brOnly)).toBe('br')
  })

  it('identity;q=0 with no compressed sibling → identity (lenient fallback)', () => {
    expect(pickEncoding('identity;q=0', neither)).toBe('identity')
  })

  it('*;q=0, br;q=1 → br (explicit beats *)', () => {
    expect(pickEncoding('*;q=0, br;q=1', both)).toBe('br')
  })

  it('*;q=1, br;q=0, gz-only sibling → gzip (* fallback gives gzip q=1)', () => {
    expect(pickEncoding('*;q=1, br;q=0', gzOnly)).toBe('gzip')
  })

  it('*;q=1, br;q=0, no compressed sibling → identity (only identity from *)', () => {
    expect(pickEncoding('*;q=1, br;q=0', neither)).toBe('identity')
  })

  it('*;q=0.8, gzip;q=0.1, br via * → br (br inherits * fallback q=0.8, beats gzip 0.1)', () => {
    expect(pickEncoding('*;q=0.8, gzip;q=0.1', both)).toBe('br')
  })

  it('*;q=0 alone → identity (lenient fallback)', () => {
    expect(pickEncoding('*;q=0', both)).toBe('identity')
  })

  it('*;q=0, identity explicit → identity', () => {
    expect(pickEncoding('*;q=0, identity', both)).toBe('identity')
  })
})

describe('pickEncoding — case + whitespace tolerance', () => {
  it('uppercase BR, GZIP tokens treated as br/gzip', () => {
    expect(pickEncoding('BR, GZIP', both)).toBe('br')
  })

  it('mixed case + whitespace in params still parses', () => {
    // gzip 0.9, br 0.8, identity implicit 0 → gzip wins (highest non-zero q)
    expect(pickEncoding('  GZIP ; q = 0.9 , BR ; q = 0.8 ', both)).toBe('gzip')
  })

  it('whitespace around tokens: "  br ; q=0.5 , gzip" parses cleanly', () => {
    // br 0.5, gzip implicit 1.0, identity implicit 0 → gzip wins
    expect(pickEncoding('  br ; q=0.5 , gzip', both)).toBe('gzip')
  })
})

describe('pickEncoding — q-value handling', () => {
  it('malformed q value (q=abc) drops the entry', () => {
    // gzip dropped → br default 0 (no *) → identity implicit 0 → lenient fallback identity
    expect(pickEncoding('gzip;q=abc', both)).toBe('identity')
  })

  it('empty q value (q=) drops the entry', () => {
    // gzip dropped → br 0.5 → identity implicit 0 → br wins
    expect(pickEncoding('gzip;q=, br;q=0.5', both)).toBe('br')
  })

  it('numeric q > 1 clamps to 1 (q=2 wins over br;q=0.5)', () => {
    expect(pickEncoding('gzip;q=2, br;q=0.5', both)).toBe('gzip')
  })

  it('numeric q = 100 clamps to 1', () => {
    expect(pickEncoding('gzip;q=100', gzOnly)).toBe('gzip')
  })

  it('numeric q = 1.5 clamps to 1', () => {
    expect(pickEncoding('gzip;q=1.5, br;q=0.5', both)).toBe('gzip')
  })

  it('negative q clamps to 0 (gzip;q=-0.2 drops out, br 0.5 wins)', () => {
    expect(pickEncoding('gzip;q=-0.2, br;q=0.5', both)).toBe('br')
  })

  it('q with trailing whitespace ("q=0.5 ") still parses', () => {
    expect(pickEncoding('gzip; q=0.5 , identity;q=0', gzOnly)).toBe('gzip')
  })
})

describe('pickEncoding — sibling-on-disk gating', () => {
  it('br requested but br missing on disk → next-best gzip', () => {
    expect(pickEncoding('br', gzOnly)).toBe('identity')
  })

  it('br;q=1, gzip;q=0.5 with only gzip on disk → gzip (br excluded)', () => {
    expect(pickEncoding('br;q=1, gzip;q=0.5', gzOnly)).toBe('gzip')
  })

  it('br;q=1 with no compressed siblings → identity (lenient)', () => {
    expect(pickEncoding('br;q=1', neither)).toBe('identity')
  })

  it('typical browser header "gzip, deflate, br" with both → br', () => {
    expect(pickEncoding('gzip, deflate, br', both)).toBe('br')
  })

  it('typical browser header with gzip-only on disk → gzip', () => {
    expect(pickEncoding('gzip, deflate, br', gzOnly)).toBe('gzip')
  })

  it('low-q compressed coding alone wins over unmentioned identity (divergence #1)', () => {
    // gzip 0.5, br default 0, identity default 0 → gzip ships, not identity.
    // Strict RFC would ship identity (implicit q=1.0). We don't.
    expect(pickEncoding('gzip;q=0.5', both)).toBe('gzip')
  })
})

describe('appendVary', () => {
  // The web standard Headers class satisfies the HeadersLike interface
  // (case-insensitive get/set) and is what Hono passes through.
  const headers = (init?: string) => {
    const h = new Headers()
    if (init !== undefined) h.set('Vary', init)
    return h
  }

  it('unset Vary + Accept-Encoding → "Accept-Encoding"', () => {
    const h = headers()
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Accept-Encoding')
  })

  it('empty Vary + Accept-Encoding → "Accept-Encoding"', () => {
    const h = headers('')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Accept-Encoding')
  })

  it('"Origin" + Accept-Encoding → "Origin, Accept-Encoding"', () => {
    const h = headers('Origin')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Origin, Accept-Encoding')
  })

  it('"Accept-Encoding" + "accept-encoding" → no dup, preserves original case', () => {
    const h = headers('Accept-Encoding')
    appendVary(h, 'accept-encoding')
    expect(h.get('Vary')).toBe('Accept-Encoding')
  })

  it('"Origin, Cookie" + Accept-Encoding → "Origin, Cookie, Accept-Encoding"', () => {
    const h = headers('Origin, Cookie')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Origin, Cookie, Accept-Encoding')
  })

  it('"*" + Accept-Encoding → stays "*"', () => {
    const h = headers('*')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('*')
  })

  it('"Origin, *" + Accept-Encoding → collapses to "*"', () => {
    const h = headers('Origin, *')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('*')
  })

  it('"Origin" + "*" (field is *) → collapses to "*"', () => {
    const h = headers('Origin')
    appendVary(h, '*')
    expect(h.get('Vary')).toBe('*')
  })

  it('whitespace-only Vary treated as unset', () => {
    const h = headers('   ')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Accept-Encoding')
  })

  it('idempotent: appending twice does not duplicate', () => {
    const h = headers()
    appendVary(h, 'Accept-Encoding')
    appendVary(h, 'Accept-Encoding')
    expect(h.get('Vary')).toBe('Accept-Encoding')
  })
})
