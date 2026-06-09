import { describe, it, expect } from 'vitest'
import {
  SUGGESTION_METRICS_PREFIX,
  SUGGESTION_EVENTS,
  metricsKey,
  zeroCounters,
  readCounters,
  recordSuggestionEvent,
  acceptanceRate,
  isSuggestionEvent,
  type StorageLike,
  type SuggestionEvent,
} from '../suggestionMetrics'

// In-memory StorageLike — keeps these tests free of jsdom/localStorage.
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v) },
  }
}

describe('metricsKey', () => {
  it('keys by project and worktree under the local-only prefix', () => {
    expect(metricsKey('yaco', 'feature')).toBe(`${SUGGESTION_METRICS_PREFIX}:yaco:feature`)
  })
  it('treats a null/undefined worktree (main checkout) as a distinct key', () => {
    expect(metricsKey('yaco', null)).toBe('yaco-inline-suggestions:yaco:')
    expect(metricsKey('yaco')).toBe('yaco-inline-suggestions:yaco:')
    // Different worktrees never collide.
    expect(metricsKey('yaco', 'wt-a')).not.toBe(metricsKey('yaco', 'wt-b'))
  })
})

describe('readCounters', () => {
  it('returns zeroed counters when nothing is stored', () => {
    expect(readCounters('p', null, fakeStorage())).toEqual(zeroCounters())
  })
  it('returns zeroed counters when storage is unavailable', () => {
    expect(readCounters('p', null, null)).toEqual(zeroCounters())
  })
  it('reads back previously recorded counts', () => {
    const storage = fakeStorage()
    recordSuggestionEvent('p', 'wt', 'shown', storage)
    recordSuggestionEvent('p', 'wt', 'shown', storage)
    expect(readCounters('p', 'wt', storage).shown).toBe(2)
  })
})

describe('recordSuggestionEvent', () => {
  it('increments the named counter atomically across writes', () => {
    const storage = fakeStorage()
    for (const event of SUGGESTION_EVENTS) recordSuggestionEvent('p', 'wt', event, storage)
    const counters = readCounters('p', 'wt', storage)
    for (const event of SUGGESTION_EVENTS) expect(counters[event]).toBe(1)
  })
  it('keeps separate tallies per (project, worktree)', () => {
    const storage = fakeStorage()
    recordSuggestionEvent('a', 'wt', 'shown', storage)
    recordSuggestionEvent('b', 'wt', 'shown', storage)
    recordSuggestionEvent('a', null, 'shown', storage)
    expect(readCounters('a', 'wt', storage).shown).toBe(1)
    expect(readCounters('b', 'wt', storage).shown).toBe(1)
    expect(readCounters('a', null, storage).shown).toBe(1)
  })
  it('recovers from a malformed blob by starting fresh', () => {
    const storage = fakeStorage({ [metricsKey('p', null)]: 'not json {{{' })
    const counters = recordSuggestionEvent('p', null, 'shown', storage)
    expect(counters.shown).toBe(1)
  })
  it('never throws when storage is unavailable', () => {
    expect(() => recordSuggestionEvent('p', null, 'shown', null)).not.toThrow()
  })
})

describe('content-free guarantee', () => {
  it('persists only known counter keys with numeric values — no text can be stored', () => {
    const storage = fakeStorage()
    for (const event of SUGGESTION_EVENTS) recordSuggestionEvent('p', 'wt', event, storage)

    const raw = storage.getItem(metricsKey('p', 'wt'))!
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // Keys are exactly the known event names — nothing else.
    expect(Object.keys(parsed).sort()).toEqual([...SUGGESTION_EVENTS].sort())
    // Every stored value is a number; no string/text payload exists anywhere.
    for (const value of Object.values(parsed)) expect(typeof value).toBe('number')
  })

  it('sanitizes away any text injected into the stored blob on the next write', () => {
    // Simulate a tampered/foreign blob carrying document text.
    const key = metricsKey('p', null)
    const storage = fakeStorage({
      [key]: JSON.stringify({ shown: 3, leakedDocument: 'secret prose from the editor', prompt: 'hello' }),
    })

    recordSuggestionEvent('p', null, 'shown', storage)

    const raw = storage.getItem(key)!
    expect(raw).not.toContain('secret prose')
    expect(raw).not.toContain('leakedDocument')
    expect(raw).not.toContain('prompt')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...SUGGESTION_EVENTS].sort())
    expect(parsed.shown).toBe(4) // sanitized count preserved + incremented
  })

  it('drops negative / non-finite / non-numeric counter values on read', () => {
    const key = metricsKey('p', null)
    const storage = fakeStorage({
      [key]: JSON.stringify({ shown: -5, accepted_full: 'x', accepted_word: 1.9, error: Infinity }),
    })
    const counters = readCounters('p', null, storage)
    expect(counters.shown).toBe(0)
    expect(counters.accepted_full).toBe(0)
    expect(counters.accepted_word).toBe(1) // floored
    expect(counters.error).toBe(0)
  })
})

describe('runtime content-free hardening (types erase at runtime)', () => {
  it('rejects an event value carrying text and writes nothing', () => {
    const key = metricsKey('p', 'wt')
    const storage = fakeStorage()
    // Simulate a miscast/`any` caller injecting document text as the event.
    const counters = recordSuggestionEvent('p', 'wt', 'leak <doc>' as unknown as SuggestionEvent, storage)
    // No write happened at all — the key is absent, not just text-free.
    expect(storage.getItem(key)).toBeNull()
    expect(storage.map.has(key)).toBe(false)
    // Returned counters are the clean zeroed shape (no injected key).
    expect(Object.keys(counters).sort()).toEqual([...SUGGESTION_EVENTS].sort())
  })

  it('never lets an injected event become a stored JSON key', () => {
    const key = metricsKey('p', 'wt')
    const storage = fakeStorage()
    recordSuggestionEvent('p', 'wt', 'shown', storage) // one legit write
    recordSuggestionEvent('p', 'wt', '<script>doc</script>' as unknown as SuggestionEvent, storage)
    const parsed = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...SUGGESTION_EVENTS].sort())
    for (const value of Object.values(parsed)) expect(typeof value).toBe('number')
    expect(parsed.shown).toBe(1) // injected call did not mutate the blob
  })

  it('isSuggestionEvent gates the known set only', () => {
    for (const event of SUGGESTION_EVENTS) expect(isSuggestionEvent(event)).toBe(true)
    expect(isSuggestionEvent('leak <doc>')).toBe(false)
    expect(isSuggestionEvent('')).toBe(false)
    expect(isSuggestionEvent(undefined)).toBe(false)
    expect(isSuggestionEvent(42)).toBe(false)
  })

  it('cannot embed an absolute or relative path in the storage key', () => {
    expect(metricsKey('/abs/path', null)).not.toContain('/abs/path')
    expect(metricsKey('p', 'a/../b')).not.toContain('a/../b')
    // No raw path separators survive — only the prefix delimiters remain.
    const key = metricsKey('/abs/path', 'a/../b\\c')
    expect(key.startsWith(`${SUGGESTION_METRICS_PREFIX}:`)).toBe(true)
    expect(key.slice(SUGGESTION_METRICS_PREFIX.length + 1)).not.toMatch(/[/\\]/)
  })

  it('keeps distinct slugged keys from colliding for ordinary project names', () => {
    expect(metricsKey('yaco', 'feature')).toBe(`${SUGGESTION_METRICS_PREFIX}:yaco:feature`)
    expect(metricsKey('a/b', null)).not.toBe(metricsKey('a/c', null))
  })

  it('a path-like component still round-trips through storage under its slug', () => {
    const storage = fakeStorage()
    recordSuggestionEvent('/abs/proj', 'wt/../x', 'shown', storage)
    expect(readCounters('/abs/proj', 'wt/../x', storage).shown).toBe(1)
    // The stored key carries no raw path.
    const [storedKey] = [...storage.map.keys()]
    expect(storedKey).not.toContain('/abs/proj')
  })
})

describe('acceptanceRate', () => {
  it('derives (accepted_full + accepted_word) / shown', () => {
    const c = zeroCounters()
    c.shown = 10
    c.accepted_full = 2
    c.accepted_word = 1
    expect(acceptanceRate(c)).toBeCloseTo(0.3)
  })
  it('is zero when nothing has been shown', () => {
    expect(acceptanceRate(zeroCounters())).toBe(0)
  })
  it('matches the gate threshold math end-to-end through storage', () => {
    const storage = fakeStorage()
    const fire = (event: SuggestionEvent, n: number) => {
      for (let i = 0; i < n; i++) recordSuggestionEvent('p', 'wt', event, storage)
    }
    fire('shown', 8)
    fire('accepted_full', 1)
    fire('accepted_word', 1)
    expect(acceptanceRate(readCounters('p', 'wt', storage))).toBeCloseTo(0.25)
  })
})
