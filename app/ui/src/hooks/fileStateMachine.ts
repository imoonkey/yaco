import type { FileState } from './workspaceTypes'
import { defaultFileState } from './workspaceTypes'

// --- Events ---

export type FileEvent =
  | { type: 'SERVER_SYNC'; content: string; revision: number }
  | { type: 'SERVER_MISSING' }
  | { type: 'FILL_REVISION'; content: string; revision: number }
  | { type: 'EDIT'; draft: string; editedAt: number }
  | { type: 'SAVE_START' }
  | { type: 'SAVE_SUCCESS'; content: string; revision: number }
  | { type: 'SAVE_CONFLICT' }
  | { type: 'SAVE_ERROR' }
  | { type: 'ACCEPT_DISK'; content: string; revision: number }
  | { type: 'LOAD_ERROR'; status: number; message: string }

// --- Transition ---

/** Pure state transition for a single file. Returns prev reference when nothing changes. */
export function fileTransition(state: FileState, event: FileEvent): FileState {
  switch (event.type) {
    case 'SERVER_MISSING':
      return state.status === 'missing' ? state : { ...state, status: 'missing' }

    case 'SERVER_SYNC': {
      // Dirty/conflict with draft: a conflict is about CONTENT divergence, not
      // mtime. Comparing the file's mtime (our revision token) alone flags our
      // own save echoed back through the file watcher as a phantom disk change.
      if (state.draft != null && state.status !== 'clean') {
        // Disk content unchanged vs our base — only the mtime moved (typically
        // our own write coming back via the watcher). Absorb the new revision so
        // the next save doesn't spuriously 409. Never while in conflict: there
        // the stale base revision is the guard that forces an explicit
        // Keep-Mine / Accept-Disk choice before a plain Ctrl+S overwrites disk.
        if (state.serverContent === event.content) {
          if (state.status === 'conflict') return state
          return state.baseRevision === event.revision ? state : { ...state, baseRevision: event.revision }
        }
        // Disk now equals our live buffer — buffer and disk agree, so we're back
        // in sync; clears any stale conflict/dirty for this path.
        if (state.draft === event.content) {
          return {
            serverContent: event.content,
            draft: null,
            baseRevision: event.revision,
            viewportLine: state.viewportLine,
            status: 'clean',
            editedAt: state.editedAt,
            loadError: null,
          }
        }
        // Disk content genuinely diverged under an unsaved draft — real conflict.
        return { ...state, serverContent: event.content, status: 'conflict' }
      }

      // Clean file: adopt server content
      if (state.serverContent === event.content && state.baseRevision === event.revision && state.status === 'clean' && state.loadError == null) {
        return state
      }
      return {
        serverContent: event.content,
        draft: null,
        baseRevision: event.revision,
        viewportLine: state.viewportLine,
        status: 'clean',
        editedAt: state.editedAt,
        loadError: null,
      }
    }

    case 'FILL_REVISION':
      // Gentle fill for tab-open fetch: only update if no base revision yet
      if (state.baseRevision == null) {
        return { ...state, serverContent: event.content, baseRevision: event.revision, loadError: null }
      }
      return state

    case 'EDIT':
      return {
        ...state,
        draft: event.draft,
        status: state.status === 'conflict' ? 'conflict' : 'dirty',
        editedAt: event.editedAt,
      }

    case 'SAVE_START':
      return { ...state, status: 'saving' }

    case 'SAVE_SUCCESS':
      // Edits typed while the save was in flight must survive — saving never
      // discards the live buffer (cf. VSCode). Only go clean when the buffer
      // still equals the bytes we persisted; otherwise keep the newer draft
      // dirty over the freshly-written revision.
      if (state.draft == null || state.draft === event.content) {
        return { ...state, serverContent: event.content, draft: null, baseRevision: event.revision, status: 'clean', loadError: null }
      }
      return { ...state, serverContent: event.content, baseRevision: event.revision, status: 'dirty', loadError: null }

    case 'SAVE_CONFLICT':
      return { ...state, status: 'conflict' }

    case 'SAVE_ERROR':
      return { ...state, status: 'dirty' }

    case 'ACCEPT_DISK':
      return {
        serverContent: event.content,
        draft: null,
        baseRevision: event.revision,
        viewportLine: state.viewportLine,
        status: 'clean',
        editedAt: state.editedAt,
        loadError: null,
      }

    case 'LOAD_ERROR': {
      // A 413 on a clean file means the bytes on disk now exceed the editor cap —
      // drop the stale buffer so the pane shows the too-large notice, not old
      // content. Keep a draft (unsaved work) and keep content on transient
      // (non-413) errors so a flaky refetch never blanks an open file.
      const clearStale = event.status === 413 && state.draft == null
      return {
        ...state,
        serverContent: clearStale ? null : state.serverContent,
        loadError: { status: event.status, message: event.message },
      }
    }
  }
}

// --- Reconciliation helper (thin wrapper for server fetch results) ---

/** Apply server fetch result to file state via the state machine. */
export function reconcileFile(
  prev: FileState | undefined,
  result: { content: string; revision: number } | null,
): FileState {
  const existing = prev ?? defaultFileState()
  if (!result) return fileTransition(existing, { type: 'SERVER_MISSING' })
  return fileTransition(existing, { type: 'SERVER_SYNC', content: result.content, revision: result.revision })
}
