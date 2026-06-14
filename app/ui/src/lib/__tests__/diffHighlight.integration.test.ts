// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { loadDiffHighlighter } from '../diffHighlight'

// Exercises the real path the unit merge test can't: load a Lezer grammar,
// run highlightTree, and confirm editorHighlight assigns token classes.
describe('loadDiffHighlighter (real parser path)', () => {
  it('tokenizes TypeScript into syntax-classed spans', async () => {
    const tokenize = await loadDiffHighlighter('example.ts')
    expect(typeof tokenize).toBe('function')

    const line = 'const x = 1'
    const spans = tokenize!(line)

    // Spans cover the whole line in order, losing nothing.
    expect(spans.map(s => s.text).join('')).toBe(line)
    // The `const` keyword (and friends) must receive a non-empty syntax class.
    expect(spans.some(s => s.cls !== '')).toBe(true)
    // The HighlightStyle CSS rules are injected so those classes resolve to colors.
    expect(document.head.querySelector('style[data-diff-highlight]')).not.toBeNull()
  })

  it('returns null for unsupported extensions (plain-text fallback)', async () => {
    expect(await loadDiffHighlighter('notes.unknownext')).toBeNull()
  })
})
