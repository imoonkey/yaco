import { describe, expect, it } from 'vitest'
import { buildEditorBufferDiff } from '../editorBufferDiff'

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
}

describe('buildEditorBufferDiff', () => {
  it('returns no hunks when the editor buffer matches the baseline', () => {
    const result = buildEditorBufferDiff('doc.md', 'same\n', 'same\n')
    expect(result.hunks).toHaveLength(0)
  })

  it('marks unsaved additions in current editor line coordinates', () => {
    const result = buildEditorBufferDiff('doc.md', 'alpha\n', 'alpha\nbeta\n')
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].type).toBe('added')
    expect(result.hunks[0].markedLines).toEqual([2])
  })

  it('treats missing baselines as new files', () => {
    const result = buildEditorBufferDiff('new.md', '', 'alpha\nbeta\n', false)
    expect(result.status).toBe('added')
    expect(result.hunks[0].markedLines).toEqual([1, 2])
  })

  it('moves saved change markers when unsaved edits are inserted above them', () => {
    const baseline = numberedLines(55)
    const currentLines = numberedLines(55).split('\n')
    currentLines.splice(0, 0, 'unsaved 1', 'unsaved 2', 'unsaved 3')
    currentLines.splice(44, 0, 'saved git change')

    const result = buildEditorBufferDiff('src/shift.ts', baseline, currentLines.join('\n'))
    const markedRows = result.hunks.flatMap(hunk => hunk.rows).filter(row =>
      row.kind === 'added' && row.text === 'saved git change'
    )

    expect(markedRows).toHaveLength(1)
    expect(markedRows[0]).toMatchObject({ kind: 'added', newLine: 45 })
    expect(result.hunks.some(hunk => hunk.markedLines.includes(45))).toBe(true)
  })
})
