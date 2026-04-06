import parseDiffLib from 'parse-diff'
import { pairChanges } from './wordDiff'
import type { DiffRow } from './wordDiff'

export type { DiffRow, DiffSegment } from './wordDiff'

export type ChangeType = 'added' | 'modified' | 'deleted'

export type DiffHunk = {
  id: string
  type: ChangeType
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  anchorLine: number
  markedLines: number[]
  rows: DiffRow[]
  stats: { added: number; deleted: number; modified: number }
}

export type ParsedFileDiff = {
  path: string
  status: ChangeType
  mode: 'text' | 'binary'
  stats: { added: number; deleted: number; hunks: number }
  hunks: DiffHunk[]
}

export function parseDiff(diffText: string, filePath = ''): ParsedFileDiff {
  const files = parseDiffLib(diffText)

  if (files.length === 0) {
    return {
      path: filePath,
      status: 'modified',
      mode: 'text',
      stats: { added: 0, deleted: 0, hunks: 0 },
      hunks: [],
    }
  }

  const file = files[0]

  // Detect binary
  if (file.chunks.length === 0 && (file.deleted || file.added || diffText.includes('Binary files'))) {
    const status: ChangeType = file.deleted ? 'deleted' : file.added ? 'added' : 'modified'
    return {
      path: filePath,
      status,
      mode: 'binary',
      stats: { added: 0, deleted: 0, hunks: 0 },
      hunks: [],
    }
  }

  let totalAdded = 0
  let totalDeleted = 0

  const hunks: DiffHunk[] = file.chunks.map(chunk => {
    // Filter sentinel lines and build raw changes for pairChanges
    const rawChanges: Array<{
      type: 'add' | 'del' | 'normal'
      content: string
      ln?: number
      ln1?: number
      ln2?: number
    }> = []

    for (const change of chunk.changes) {
      if (change.content.startsWith('\\')) continue
      const content = change.content.slice(1)
      rawChanges.push({
        type: change.type,
        content,
        ln: change.type === 'add' ? change.ln : undefined,
        ln1: change.type === 'normal' ? change.ln1 : change.type === 'del' ? change.ln : undefined,
        ln2: change.type === 'normal' ? change.ln2 : undefined,
      })
    }

    const rows = pairChanges(rawChanges)

    // Compute hunk stats from rows
    const stats = { added: 0, deleted: 0, modified: 0 }
    for (const row of rows) {
      if (row.kind === 'added') stats.added++
      else if (row.kind === 'deleted') stats.deleted++
      else if (row.kind === 'modified') stats.modified++
    }

    totalAdded += stats.added + stats.modified
    totalDeleted += stats.deleted + stats.modified

    // Determine hunk type
    const hasAdd = stats.added > 0 || stats.modified > 0
    const hasDel = stats.deleted > 0 || stats.modified > 0
    let type: ChangeType
    if (hasAdd && hasDel) type = 'modified'
    else if (hasDel) type = 'deleted'
    else type = 'added'

    // Compute markedLines (new-file line numbers for gutter markers)
    const markedLines: number[] = []
    for (const row of rows) {
      if (row.kind === 'added') markedLines.push(row.newLine)
      else if (row.kind === 'modified') markedLines.push(row.newLine)
    }

    // Compute anchor line
    let anchorLine: number
    if (markedLines.length > 0) {
      anchorLine = markedLines[0]
    } else {
      // Pure deletion: find first context line after a delete
      let found = false
      let seenDel = false
      for (const row of rows) {
        if (row.kind === 'deleted') { seenDel = true; continue }
        if (seenDel && row.kind === 'context') {
          anchorLine = row.newLine
          found = true
          break
        }
      }
      if (!found) {
        anchorLine = chunk.newStart + chunk.newLines
      }
    }

    return {
      id: `${chunk.oldStart}:${chunk.oldLines}:${chunk.newStart}:${chunk.newLines}`,
      type,
      header: chunk.content,
      oldStart: chunk.oldStart,
      oldLines: chunk.oldLines,
      newStart: chunk.newStart,
      newLines: chunk.newLines,
      anchorLine: anchorLine!,
      markedLines,
      rows,
      stats,
    }
  })

  // File-level status
  const hasAdds = hunks.some(h => h.type === 'added' || h.type === 'modified')
  const hasDels = hunks.some(h => h.type === 'deleted' || h.type === 'modified')
  let status: ChangeType
  if (hasAdds && hasDels) status = 'modified'
  else if (hasDels) status = 'deleted'
  else status = 'added'

  return {
    path: filePath,
    status,
    mode: 'text',
    stats: { added: totalAdded, deleted: totalDeleted, hunks: hunks.length },
    hunks,
  }
}
