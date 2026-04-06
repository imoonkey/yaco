import { diffWordsWithSpace } from 'diff'

// --- Types ---

export type DiffSegment = {
  text: string
  kind: 'same' | 'added' | 'deleted'
}

export type DiffRow =
  | { kind: 'context'; key: string; oldLine: number; newLine: number; text: string }
  | { kind: 'added'; key: string; oldLine: null; newLine: number; text: string }
  | { kind: 'deleted'; key: string; oldLine: number; newLine: null; text: string }
  | { kind: 'modified'; key: string; oldLine: number; newLine: number; oldText: string; newText: string; oldSegments: DiffSegment[]; newSegments: DiffSegment[] }

// --- Word Diff ---

export function computeWordDiff(
  oldLine: string,
  newLine: string,
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const parts = diffWordsWithSpace(oldLine, newLine)

  const oldSegments: DiffSegment[] = []
  const newSegments: DiffSegment[] = []

  for (const part of parts) {
    if (part.added) {
      newSegments.push({ text: part.value, kind: 'added' })
    } else if (part.removed) {
      oldSegments.push({ text: part.value, kind: 'deleted' })
    } else {
      oldSegments.push({ text: part.value, kind: 'same' })
      newSegments.push({ text: part.value, kind: 'same' })
    }
  }

  return { oldSegments, newSegments }
}

// --- Line Pairing ---

type RawChange = {
  type: 'add' | 'del' | 'normal'
  content: string
  ln?: number   // add line number (new file)
  ln1?: number  // normal line number (old file)
  ln2?: number  // normal line number (new file)
}

export function pairChanges(changes: RawChange[]): DiffRow[] {
  const rows: DiffRow[] = []
  let pendingDels: RawChange[] = []
  let pendingAdds: RawChange[] = []

  function flushPending() {
    const paired = Math.min(pendingDels.length, pendingAdds.length)

    for (let i = 0; i < paired; i++) {
      const del = pendingDels[i]
      const add = pendingAdds[i]
      const { oldSegments, newSegments } = computeWordDiff(del.content, add.content)
      rows.push({
        kind: 'modified',
        key: `m-${del.ln1}-${add.ln}`,
        oldLine: del.ln1!,
        newLine: add.ln!,
        oldText: del.content,
        newText: add.content,
        oldSegments,
        newSegments,
      })
    }

    for (let i = paired; i < pendingDels.length; i++) {
      const del = pendingDels[i]
      rows.push({
        kind: 'deleted',
        key: `d-${del.ln1}`,
        oldLine: del.ln1!,
        newLine: null,
        text: del.content,
      })
    }

    for (let i = paired; i < pendingAdds.length; i++) {
      const add = pendingAdds[i]
      rows.push({
        kind: 'added',
        key: `a-${add.ln}`,
        oldLine: null,
        newLine: add.ln!,
        text: add.content,
      })
    }

    pendingDels = []
    pendingAdds = []
  }

  for (const change of changes) {
    if (change.type === 'del') {
      // If we had pending adds without dels, flush them first
      if (pendingAdds.length > 0 && pendingDels.length === 0) {
        flushPending()
      }
      pendingDels.push(change)
    } else if (change.type === 'add') {
      pendingAdds.push(change)
    } else {
      flushPending()
      rows.push({
        kind: 'context',
        key: `c-${change.ln2}`,
        oldLine: change.ln1!,
        newLine: change.ln2!,
        text: change.content,
      })
    }
  }

  flushPending()
  return rows
}
