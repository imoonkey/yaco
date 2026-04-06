import { describe, it, expect } from 'vitest'
import { parseDiff } from '../parseDiff'

// Typical unified diff for a modified file
const modifiedDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,5 @@
 import React from 'react'

-const old = 'value'
+const updated = 'value'

 export default old
`

// All-added diff (untracked file or --no-index)
const addedDiff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`

// Pure deletion
const deletedDiff = `diff --git a/old.ts b/old.ts
index abcdefg..1234567 100644
--- a/old.ts
+++ b/old.ts
@@ -1,3 +1,0 @@
-removed line 1
-removed line 2
-removed line 3
`

const binaryDiff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`

describe('parseDiff', () => {
  it('parses a modification with canonical rows', () => {
    const result = parseDiff(modifiedDiff, 'src/foo.ts')

    expect(result.path).toBe('src/foo.ts')
    expect(result.mode).toBe('text')
    expect(result.stats.hunks).toBe(1)

    const hunk = result.hunks[0]
    expect(hunk.type).toBe('modified')
    expect(hunk.rows.length).toBeGreaterThan(0)

    // Find the modified row
    const modifiedRow = hunk.rows.find(r => r.kind === 'modified')
    expect(modifiedRow).toBeDefined()
    if (modifiedRow?.kind === 'modified') {
      expect(modifiedRow.oldText).toBe("const old = 'value'")
      expect(modifiedRow.newText).toBe("const updated = 'value'")
      expect(modifiedRow.oldSegments.length).toBeGreaterThan(0)
      expect(modifiedRow.newSegments.length).toBeGreaterThan(0)
    }

    // Context rows should have both line numbers
    const contextRows = hunk.rows.filter(r => r.kind === 'context')
    for (const row of contextRows) {
      expect(row.oldLine).toBeGreaterThan(0)
      expect(row.newLine).toBeGreaterThan(0)
    }
  })

  it('parses an all-added file', () => {
    const result = parseDiff(addedDiff, 'new-file.ts')

    expect(result.status).toBe('added')
    expect(result.stats.hunks).toBe(1)

    const hunk = result.hunks[0]
    expect(hunk.type).toBe('added')
    expect(hunk.rows.every(r => r.kind === 'added')).toBe(true)
    expect(hunk.rows.length).toBe(3)
    expect(hunk.markedLines.length).toBe(3)
  })

  it('parses a pure deletion', () => {
    const result = parseDiff(deletedDiff, 'old.ts')

    expect(result.stats.hunks).toBe(1)
    const hunk = result.hunks[0]
    expect(hunk.type).toBe('deleted')
    expect(hunk.rows.every(r => r.kind === 'deleted')).toBe(true)
    expect(hunk.rows.length).toBe(3)
    expect(hunk.markedLines.length).toBe(0)
  })

  it('detects binary diffs', () => {
    const result = parseDiff(binaryDiff, 'image.png')
    expect(result.mode).toBe('binary')
    expect(result.hunks).toHaveLength(0)
  })

  it('returns empty result for empty input', () => {
    const result = parseDiff('')
    expect(result.hunks).toHaveLength(0)
    expect(result.stats.hunks).toBe(0)
  })

  it('preserves anchorLine and markedLines for gutter compat', () => {
    const result = parseDiff(modifiedDiff)
    const hunk = result.hunks[0]
    expect(hunk.anchorLine).toBeGreaterThan(0)
    expect(hunk.markedLines.length).toBeGreaterThan(0)
  })

  it('computes correct hunk stats', () => {
    const result = parseDiff(modifiedDiff)
    const hunk = result.hunks[0]
    expect(hunk.stats.modified).toBe(1)
    // Context rows should not count in stats
    expect(hunk.stats.added + hunk.stats.deleted + hunk.stats.modified)
      .toBeLessThanOrEqual(hunk.rows.length)
  })

  it('aggregates file-level stats across multiple hunks', () => {
    const multiHunkDiff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 ctx
-old1
+new1
 ctx
@@ -10,3 +10,4 @@
 ctx
-old2
+new2
+extra
 ctx
`
    const result = parseDiff(multiHunkDiff, 'f.ts')
    expect(result.stats.hunks).toBe(2)
    expect(result.stats.added).toBeGreaterThanOrEqual(2) // 2 modified + 1 added
    expect(result.stats.deleted).toBeGreaterThanOrEqual(2)
  })

  it('filters no-newline-at-EOF sentinel', () => {
    const eofDiff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
 line1
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
    const result = parseDiff(eofDiff)
    const hunk = result.hunks[0]
    // Sentinel lines should not appear as rows
    const sentinelRows = hunk.rows.filter(r =>
      (r.kind === 'context' || r.kind === 'added' || r.kind === 'deleted') &&
      'text' in r && r.text.includes('No newline')
    )
    expect(sentinelRows).toHaveLength(0)
  })
})
