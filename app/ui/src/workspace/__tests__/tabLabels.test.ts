import { describe, it, expect } from 'vitest'
import { tabCloseLabel } from '../tabLabels'

describe('tabCloseLabel', () => {
  it('labels a plain file tab by basename', () => {
    expect(tabCloseLabel('src/a.ts')).toBe('Close a.ts')
  })

  it('marks a plain diff tab "(diff)" so it stays unique against its file sibling', () => {
    // Regression: a file tab and its working-tree diff tab both rendered
    // "Close a.ts", colliding in the accessibility tree.
    expect(tabCloseLabel('diff:src/a.ts')).toBe('Close a.ts (diff)')
    expect(tabCloseLabel('src/a.ts')).not.toBe(tabCloseLabel('diff:src/a.ts'))
  })

  it('leaves a compare diff tab to its base..compare suffix (already unique)', () => {
    expect(tabCloseLabel('diff:src/a.ts?base=main&compare=HEAD')).toBe('Close a.ts (main..HEAD)')
  })
})
