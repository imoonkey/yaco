// Unit test for the shared-buffer keep-set signature (vt-state). The keep paths
// are serialized to a JSON signature (for memo identity) and rebuilt into a Set.
// A space — or any other filename-legal character — must NOT split one path into
// two, which would drop a still-referenced clean buffer and break SSE refetch
// tracking. (Regression for the old `join(' ')`/`split(' ')` signature.)
import { describe, it, expect } from 'vitest'
import { keepPathsSignature, parseKeepPaths } from '../useWorkspaceState'

describe('shared-buffer keep-set signature', () => {
  it('preserves a path containing a space (no split on a filename-legal char)', () => {
    const set = parseKeepPaths(keepPathsSignature(['src/my file.ts', 'a.ts']))
    expect(set.has('src/my file.ts')).toBe(true) // NOT "src/my" + "file.ts"
    expect(set.has('a.ts')).toBe(true)
    expect(set.size).toBe(2)
  })

  it('round-trips paths with other tricky characters verbatim', () => {
    const paths = ['a b/c d.ts', 'weird name.tsx', 'plain.ts', 'tab\tname.ts']
    const set = parseKeepPaths(keepPathsSignature(paths))
    expect(set.size).toBe(paths.length)
    for (const p of paths) expect(set.has(p)).toBe(true)
  })

  it('is order-independent (sorted), so the same union yields the same signature', () => {
    expect(keepPathsSignature(['b.ts', 'a.ts'])).toBe(keepPathsSignature(['a.ts', 'b.ts']))
  })
})
