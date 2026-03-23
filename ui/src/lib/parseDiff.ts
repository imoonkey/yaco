import parseDiffLib from 'parse-diff'

export type ChangeType = 'added' | 'modified' | 'deleted'

export type DiffHunk = {
  id: string
  type: ChangeType
  newStart: number
  newLines: number
  markedLines: number[]
  anchorLine: number
  originalLines: string[]
  currentLines: string[]
  changes: Array<{ type: 'add' | 'del' | 'normal'; content: string }>
  header: string
}

export function parseDiff(diffText: string): DiffHunk[] {
  const files = parseDiffLib(diffText)
  if (files.length === 0) return []

  const file = files[0]
  return file.chunks.map(chunk => {
    const hasAdd = chunk.changes.some(c => c.type === 'add')
    const hasDel = chunk.changes.some(c => c.type === 'del')

    let type: ChangeType
    if (hasAdd && hasDel) type = 'modified'
    else if (hasDel) type = 'deleted'
    else type = 'added'

    const markedLines: number[] = []
    const originalLines: string[] = []
    const currentLines: string[] = []
    const changes: DiffHunk['changes'] = []

    for (const change of chunk.changes) {
      const content = change.content.slice(1) // strip leading +/-/space
      // Skip "\ No newline at end of file" sentinel lines
      if (change.content.startsWith('\\')) continue
      changes.push({ type: change.type, content })

      if (change.type === 'del') {
        originalLines.push(content)
      } else if (change.type === 'add') {
        currentLines.push(content)
        if (type !== 'deleted') markedLines.push(change.ln)
      }
    }

    // Canonical anchor: first marked line for add/modify hunks.
    // For pure deletions: find the first surviving line after the delete run,
    // or fall back to newStart + newLines (clamped at render time by diffGutter.ts).
    let anchorLine: number
    if (markedLines.length > 0) {
      anchorLine = markedLines[0]
    } else {
      // Find the first normal/context line after any deletion in the chunk
      let found = false
      let seenDel = false
      for (const change of chunk.changes) {
        if (change.content.startsWith('\\')) continue
        if (change.type === 'del') { seenDel = true; continue }
        if (seenDel && change.type === 'normal') {
          anchorLine = change.ln2
          found = true
          break
        }
      }
      if (!found) {
        // Deletion at EOF or no surviving context line
        anchorLine = chunk.newStart + chunk.newLines
      }
    }

    return {
      id: `${chunk.oldStart}:${chunk.oldLines}:${chunk.newStart}:${chunk.newLines}`,
      type,
      newStart: chunk.newStart,
      newLines: chunk.newLines,
      markedLines,
      anchorLine,
      originalLines,
      currentLines,
      changes,
      header: chunk.content,
    }
  })
}
