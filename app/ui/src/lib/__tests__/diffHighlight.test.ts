import { describe, it, expect } from 'vitest'
import { mergeSyntaxAndWord } from '../diffHighlight'
import type { DiffSegment } from '../parseDiff'

describe('mergeSyntaxAndWord', () => {
  it('splits a syntax span at a word-diff boundary', () => {
    // text: "const x" — one syntax span, but only "x" changed.
    const syntax = [{ text: 'const x', cls: 'kw' }]
    const segments: DiffSegment[] = [
      { text: 'const ', kind: 'same' },
      { text: 'x', kind: 'added' },
    ]

    const merged = mergeSyntaxAndWord(syntax, segments)

    expect(merged).toEqual([
      { text: 'const ', cls: 'kw', changed: false },
      { text: 'x', cls: 'kw', changed: true },
    ])
  })

  it('splits a word-diff segment across multiple syntax tokens', () => {
    // Whole line changed, but syntax tokenizes it into keyword + name.
    const syntax = [
      { text: 'let', cls: 'kw' },
      { text: ' foo', cls: '' },
    ]
    const segments: DiffSegment[] = [{ text: 'let foo', kind: 'deleted' }]

    const merged = mergeSyntaxAndWord(syntax, segments)

    expect(merged).toEqual([
      { text: 'let', cls: 'kw', changed: true },
      { text: ' foo', cls: '', changed: true },
    ])
  })

  it('preserves classes when nothing changed', () => {
    const syntax = [
      { text: 'a', cls: 'x' },
      { text: 'b', cls: 'y' },
    ]
    const segments: DiffSegment[] = [{ text: 'ab', kind: 'same' }]

    const merged = mergeSyntaxAndWord(syntax, segments)

    expect(merged).toEqual([
      { text: 'a', cls: 'x', changed: false },
      { text: 'b', cls: 'y', changed: false },
    ])
  })

  it('handles aligned boundaries on both sides', () => {
    const syntax = [
      { text: 'foo', cls: 'fn' },
      { text: '()', cls: '' },
    ]
    const segments: DiffSegment[] = [
      { text: 'foo', kind: 'same' },
      { text: '()', kind: 'added' },
    ]

    const merged = mergeSyntaxAndWord(syntax, segments)

    expect(merged).toEqual([
      { text: 'foo', cls: 'fn', changed: false },
      { text: '()', cls: '', changed: true },
    ])
  })

  it('drains remaining text when totals diverge instead of dropping it', () => {
    // syntax shorter than segments: trailing segment text must survive.
    const shortSyntax = [{ text: 'ab', cls: 'k' }]
    const longSegs: DiffSegment[] = [{ text: 'abc', kind: 'added' }]
    expect(mergeSyntaxAndWord(shortSyntax, longSegs)).toEqual([
      { text: 'ab', cls: 'k', changed: true },
      { text: 'c', cls: '', changed: true },
    ])

    // segments shorter than syntax: trailing syntax text must survive.
    const longSyntax = [{ text: 'abc', cls: 'k' }]
    const shortSegs: DiffSegment[] = [{ text: 'ab', kind: 'same' }]
    expect(mergeSyntaxAndWord(longSyntax, shortSegs)).toEqual([
      { text: 'ab', cls: 'k', changed: false },
      { text: 'c', cls: 'k', changed: false },
    ])
  })
})
