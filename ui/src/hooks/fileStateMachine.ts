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

// --- Transition ---

/** Pure state transition for a single file. Returns prev reference when nothing changes. */
export function fileTransition(state: FileState, event: FileEvent): FileState {
  switch (event.type) {
    case 'SERVER_MISSING':
      return state.status === 'missing' ? state : { ...state, status: 'missing' }

    case 'SERVER_SYNC': {
      // Dirty/conflict with draft: check revision divergence
      if (state.draft != null && state.status !== 'clean') {
        if (state.baseRevision != null && state.baseRevision !== event.revision) {
          if (state.status === 'conflict' && state.serverContent === event.content) return state
          return { ...state, serverContent: event.content, status: 'conflict' }
        }
        // Revision matches — update server content if changed
        if (state.serverContent === event.content && state.baseRevision === event.revision) return state
        return { ...state, serverContent: event.content, baseRevision: event.revision }
      }

      // Clean file: adopt server content
      if (state.serverContent === event.content && state.baseRevision === event.revision && state.status === 'clean') {
        return state
      }
      return {
        serverContent: event.content,
        draft: null,
        baseRevision: event.revision,
        viewportLine: state.viewportLine,
        status: 'clean',
        editedAt: state.editedAt,
      }
    }

    case 'FILL_REVISION':
      // Gentle fill for tab-open fetch: only update if no base revision yet
      if (state.baseRevision == null) {
        return { ...state, serverContent: event.content, baseRevision: event.revision }
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
      return { ...state, serverContent: event.content, draft: null, baseRevision: event.revision, status: 'clean' }

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
