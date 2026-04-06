import { describe, it, expect } from 'vitest'
import { computeWordDiff, pairChanges } from '../wordDiff'

describe('computeWordDiff', () => {
  it('detects changed words', () => {
    const { oldSegments, newSegments } = computeWordDiff('hello world', 'hello there')
    expect(oldSegments).toEqual([
      { text: 'hello ', kind: 'same' },
      { text: 'world', kind: 'deleted' },
    ])
    expect(newSegments).toEqual([
      { text: 'hello ', kind: 'same' },
      { text: 'there', kind: 'added' },
    ])
  })

  it('handles fully identical lines', () => {
    const { oldSegments, newSegments } = computeWordDiff('same line', 'same line')
    expect(oldSegments).toEqual([{ text: 'same line', kind: 'same' }])
    expect(newSegments).toEqual([{ text: 'same line', kind: 'same' }])
  })

  it('handles fully different lines', () => {
    const { oldSegments, newSegments } = computeWordDiff('aaa', 'bbb')
    expect(oldSegments).toEqual([{ text: 'aaa', kind: 'deleted' }])
    expect(newSegments).toEqual([{ text: 'bbb', kind: 'added' }])
  })

  it('handles empty strings', () => {
    const { oldSegments, newSegments } = computeWordDiff('', 'added')
    expect(oldSegments).toEqual([])
    expect(newSegments).toEqual([{ text: 'added', kind: 'added' }])
  })
})

describe('pairChanges', () => {
  it('pairs equal del/add runs as modified', () => {
    const rows = pairChanges([
      { type: 'del', content: 'old1', ln1: 1 },
      { type: 'del', content: 'old2', ln1: 2 },
      { type: 'add', content: 'new1', ln: 1 },
      { type: 'add', content: 'new2', ln: 2 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('modified')
    expect(rows[1].kind).toBe('modified')
  })

  it('leaves unpaired adds as added', () => {
    const rows = pairChanges([
      { type: 'del', content: 'old1', ln1: 1 },
      { type: 'add', content: 'new1', ln: 1 },
      { type: 'add', content: 'new2', ln: 2 },
      { type: 'add', content: 'new3', ln: 3 },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0].kind).toBe('modified')
    expect(rows[1].kind).toBe('added')
    expect(rows[2].kind).toBe('added')
  })

  it('leaves unpaired deletes as deleted', () => {
    const rows = pairChanges([
      { type: 'del', content: 'old1', ln1: 1 },
      { type: 'del', content: 'old2', ln1: 2 },
      { type: 'add', content: 'new1', ln: 1 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('modified')
    expect(rows[1].kind).toBe('deleted')
  })

  it('emits context rows', () => {
    const rows = pairChanges([
      { type: 'normal', content: 'ctx', ln1: 5, ln2: 5 },
    ])
    expect(rows).toEqual([{
      kind: 'context',
      key: 'c-5',
      oldLine: 5,
      newLine: 5,
      text: 'ctx',
    }])
  })

  it('flushes pending adds before new del run', () => {
    const rows = pairChanges([
      { type: 'add', content: 'lonely add', ln: 1 },
      { type: 'del', content: 'later del', ln1: 2 },
      { type: 'add', content: 'paired add', ln: 2 },
    ])
    expect(rows[0]).toMatchObject({ kind: 'added', text: 'lonely add' })
    expect(rows[1]).toMatchObject({ kind: 'modified' })
  })

  it('flushes pending on context line', () => {
    const rows = pairChanges([
      { type: 'del', content: 'old', ln1: 1 },
      { type: 'add', content: 'new', ln: 1 },
      { type: 'normal', content: 'ctx', ln1: 2, ln2: 2 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('modified')
    expect(rows[1].kind).toBe('context')
  })

  it('handles design doc example correctly', () => {
    // - old1, - old2, + new1, + new2, + new3
    // → modified(old1,new1), modified(old2,new2), added(new3)
    const rows = pairChanges([
      { type: 'del', content: 'old1', ln1: 1 },
      { type: 'del', content: 'old2', ln1: 2 },
      { type: 'add', content: 'new1', ln: 1 },
      { type: 'add', content: 'new2', ln: 2 },
      { type: 'add', content: 'new3', ln: 3 },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'modified', oldLine: 1, newLine: 1 })
    expect(rows[1]).toMatchObject({ kind: 'modified', oldLine: 2, newLine: 2 })
    expect(rows[2]).toMatchObject({ kind: 'added', newLine: 3 })
  })

  it('returns empty array for empty input', () => {
    expect(pairChanges([])).toEqual([])
  })
})
