import { describe, it, expect } from 'vitest'
import { parseDelimited } from '../delimitedTable'

describe('parseDelimited', () => {
  it('reads the first row as headers and the rest as rows', () => {
    const table = parseDelimited('name,age\nada,36\ngrace,45\n', 'people.csv')
    expect(table.headers).toEqual(['name', 'age'])
    expect(table.rows).toEqual([['ada', '36'], ['grace', '45']])
  })

  it('keeps commas and newlines that live inside a quoted field', () => {
    const table = parseDelimited('name,note\n"Doe, Jane","line1\nline2"\n', 'q.csv')
    expect(table.rows).toEqual([['Doe, Jane', 'line1\nline2']])
  })

  it('splits .tsv on tabs even when the values contain commas', () => {
    const table = parseDelimited('a\tb\n1,2\t3,4\n', 'data.tsv')
    expect(table.headers).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1,2', '3,4']])
  })

  it('sniffs a semicolon delimiter for .csv', () => {
    const table = parseDelimited('a;b\n1;2\n', 'euro.csv')
    expect(table.headers).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2']])
  })

  it('pads ragged rows to the widest row so cells stay in their column', () => {
    const table = parseDelimited('a,b\n1\n2,3,4\n', 'ragged.csv')
    expect(table.headers).toEqual(['a', 'b', ''])
    expect(table.rows).toEqual([['1', '', ''], ['2', '3', '4']])
  })

  it('skips blank lines', () => {
    const table = parseDelimited('a,b\n\n1,2\n\n', 'gaps.csv')
    expect(table.rows).toEqual([['1', '2']])
  })

  it('sizes columns from the content and clamps the extremes', () => {
    const table = parseDelimited(`short,long\nx,${'y'.repeat(400)}\n`, 'w.csv')
    expect(table.widths[0]).toBe(8) // 'short'.length + padding
    expect(table.widths[1]).toBe(48) // clamped
  })

  it('returns an empty table for empty input', () => {
    const table = parseDelimited('', 'empty.csv')
    expect(table.headers).toEqual([])
    expect(table.rows).toEqual([])
  })
})
