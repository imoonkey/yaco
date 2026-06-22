// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fileTransition } from '../fileStateMachine'
import { defaultFileState } from '../workspaceTypes'
import type { FileState } from '../workspaceTypes'

// A file synced from disk at revision `rev` with content `content`, optionally dirty.
function synced(content: string, rev: number, draft: string | null = null): FileState {
  return {
    ...defaultFileState(),
    serverContent: content,
    draft,
    baseRevision: rev,
    status: draft != null ? 'dirty' : 'clean',
  }
}

describe('fileStateMachine — SAVE_SUCCESS preserves in-flight edits', () => {
  it('goes clean when the buffer still equals the saved bytes', () => {
    // Ctrl+S snapshot == current draft → nothing typed during save.
    const saving = { ...synced('old', 100, 'v1'), status: 'saving' as const }
    const next = fileTransition(saving, { type: 'SAVE_SUCCESS', content: 'v1', revision: 200 })
    expect(next.status).toBe('clean')
    expect(next.draft).toBeNull()
    expect(next.serverContent).toBe('v1')
    expect(next.baseRevision).toBe(200)
  })

  it('keeps the newer draft dirty when the user typed during the save', () => {
    // Save was requested with 'v1'; user typed on to 'v1-more' before the
    // response landed. The extra keystrokes must NOT be discarded.
    const saving = { ...synced('old', 100, 'v1-more'), status: 'saving' as const }
    const next = fileTransition(saving, { type: 'SAVE_SUCCESS', content: 'v1', revision: 200 })
    expect(next.status).toBe('dirty')
    expect(next.draft).toBe('v1-more')        // not lost
    expect(next.serverContent).toBe('v1')     // disk truth advances
    expect(next.baseRevision).toBe(200)       // next save bases on the new revision
  })
})

describe('fileStateMachine — SERVER_SYNC is content-based, not mtime-based', () => {
  it('absorbs a pure mtime bump (own-write echo) without conflict', () => {
    // We have unsaved edits; the watcher reports our own save (same content,
    // new mtime) before our save response updated baseRevision.
    const dirty = synced('disk', 100, 'my edits')
    const next = fileTransition(dirty, { type: 'SERVER_SYNC', content: 'disk', revision: 200 })
    expect(next.status).toBe('dirty')         // never flips to conflict
    expect(next.draft).toBe('my edits')
    expect(next.baseRevision).toBe(200)        // revision absorbed
  })

  it('returns to sync (clean) when disk already equals our live buffer', () => {
    const dirty = synced('disk', 100, 'my edits')
    const next = fileTransition(dirty, { type: 'SERVER_SYNC', content: 'my edits', revision: 200 })
    expect(next.status).toBe('clean')
    expect(next.draft).toBeNull()
    expect(next.serverContent).toBe('my edits')
    expect(next.baseRevision).toBe(200)
  })

  it('still flags a real conflict when disk content genuinely diverged', () => {
    const dirty = synced('disk', 100, 'my edits')
    const next = fileTransition(dirty, { type: 'SERVER_SYNC', content: 'someone else changed it', revision: 200 })
    expect(next.status).toBe('conflict')
    expect(next.draft).toBe('my edits')       // our work is held, not overwritten
    expect(next.serverContent).toBe('someone else changed it')
  })

  it('does NOT advance the save token while in conflict on a same-content mtime echo', () => {
    // The stale baseRevision is the guard that makes a plain Ctrl+S 409 until the
    // user explicitly chooses Keep-Mine / Accept-Disk. A pure mtime bump must not
    // refresh it, or the next normal save would silently overwrite disk.
    const conflicted = { ...synced('theirs', 100, 'mine'), status: 'conflict' as const }
    const next = fileTransition(conflicted, { type: 'SERVER_SYNC', content: 'theirs', revision: 200 })
    expect(next).toBe(conflicted)             // unchanged: still conflict, base still 100
  })

  it('clears a stale conflict when disk converges to our buffer', () => {
    const conflicted = { ...synced('theirs', 100, 'mine'), status: 'conflict' as const }
    const next = fileTransition(conflicted, { type: 'SERVER_SYNC', content: 'mine', revision: 200 })
    expect(next.status).toBe('clean')
    expect(next.draft).toBeNull()
    expect(next.serverContent).toBe('mine')
    expect(next.baseRevision).toBe(200)
  })

  it('is idempotent once in conflict on the same divergent disk content', () => {
    const conflicted = { ...synced('theirs', 100, 'mine'), status: 'conflict' as const }
    const next = fileTransition(conflicted, { type: 'SERVER_SYNC', content: 'theirs', revision: 100 })
    expect(next).toBe(conflicted)             // no churn
  })

  it('adopts server content for a clean file', () => {
    const clean = synced('old', 100)
    const next = fileTransition(clean, { type: 'SERVER_SYNC', content: 'new from disk', revision: 200 })
    expect(next.status).toBe('clean')
    expect(next.serverContent).toBe('new from disk')
    expect(next.baseRevision).toBe(200)
  })
})

describe('fileStateMachine — SERVER_MISSING keeps unsaved work', () => {
  it('preserves the draft when a dirty file is deleted on disk', () => {
    const dirty = synced('disk', 100, 'unsaved edits')
    const next = fileTransition(dirty, { type: 'SERVER_MISSING' })
    expect(next.status).toBe('missing')
    expect(next.draft).toBe('unsaved edits')  // retained; GC keys off draft != null
  })
})

describe('fileStateMachine — LOAD_ERROR surfaces a failed fetch', () => {
  it('records status + message so the pane can stop spinning', () => {
    const next = fileTransition(defaultFileState(), { type: 'LOAD_ERROR', status: 413, message: 'file too large' })
    expect(next.loadError).toEqual({ status: 413, message: 'file too large' })
  })

  it('drops the stale buffer when a clean open file grows past the cap (413)', () => {
    const clean = synced('old small bytes', 100)
    const next = fileTransition(clean, { type: 'LOAD_ERROR', status: 413, message: 'file too large' })
    expect(next.serverContent).toBeNull()       // pane shows the too-large notice, not stale content
    expect(next.loadError?.status).toBe(413)
  })

  it('keeps an unsaved draft even when disk grew past the cap', () => {
    const dirty = synced('old', 100, 'my unsaved edits')
    const next = fileTransition(dirty, { type: 'LOAD_ERROR', status: 413, message: 'file too large' })
    expect(next.draft).toBe('my unsaved edits')  // never discard unsaved work
    expect(next.serverContent).toBe('old')
  })

  it('keeps displayed content on a transient (non-413) refetch error', () => {
    const clean = synced('shown', 100)
    const next = fileTransition(clean, { type: 'LOAD_ERROR', status: 0, message: 'Failed to load file' })
    expect(next.serverContent).toBe('shown')     // a flaky refetch must not blank an open file
    expect(next.loadError?.status).toBe(0)
  })

  it('clears once content loads (SERVER_SYNC), even on an unchanged-bytes resync', () => {
    const failed = fileTransition(synced('shown', 100), { type: 'LOAD_ERROR', status: 0, message: 'oops' })
    const recovered = fileTransition(failed, { type: 'SERVER_SYNC', content: 'shown', revision: 100 })
    expect(recovered.loadError).toBeNull()       // no-op resync still clears the stale error
  })
})
