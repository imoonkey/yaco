// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { memo, useEffect, useMemo, useState } from 'react'
import { render, fireEvent } from '@testing-library/react'
import {
  WorkspaceSelectionContext,
  WorkspaceEditorBuffersContext,
  WorkspaceEditorTabsContext,
  useWorkspaceSelection,
  useWorkspaceEditorBuffers,
  useWorkspaceEditorTabs,
  type WorkspaceSelection,
  type WorkspaceEditorBuffers,
  type WorkspaceEditorTabs,
} from '../context'
import type { FileState } from '../../hooks/workspaceTypes'

// Render isolation guard (design rev4, Fix 1): a keystroke mutates `files`, which
// lives ONLY in the editor-buffers context. Splitting it out of `selection` is what
// stops a keystroke from re-rendering terminals/sessions/tree (the 9 "cool" selection
// consumers) and the tab bar. This locks that property so nobody re-nests `files`
// back into the selection value.
//
// Memo'd consumers model the real tree: WorkspaceProvider's `children` is a stable
// prop, so on a state change only the consumers of the context whose value changed
// re-render. A bare (non-memo) child would re-render with its parent and wouldn't
// isolate the context effect under test.

// Counts commits (the effect runs once per actual render; a memo bail-out skips both
// the body and the effect). Mutating module state in an effect — not during render —
// keeps react-hooks/immutability happy.
const counts = { selection: 0, tabs: 0, buffers: 0 }

const SelectionConsumer = memo(function SelectionConsumer() {
  useWorkspaceSelection()
  useEffect(() => { counts.selection++ })
  return null
})
const TabsConsumer = memo(function TabsConsumer() {
  useWorkspaceEditorTabs()
  useEffect(() => { counts.tabs++ })
  return null
})
const BuffersConsumer = memo(function BuffersConsumer() {
  useWorkspaceEditorBuffers()
  useEffect(() => { counts.buffers++ })
  return null
})

const STABLE_SELECTION = { activeSession: '', recentFiles: [] } as unknown as WorkspaceSelection
const STABLE_TABS: WorkspaceEditorTabs = { dirtyTabs: new Set(), conflictTabs: new Set() }

let keystrokeSeq = 0

function Harness() {
  const [files, setFiles] = useState<Record<string, FileState>>({})

  // selection + tabs values are stable refs across a `files` change (as in the real
  // provider, whose selection/editorTabs memos don't depend on `files`).
  const buffers = useMemo<WorkspaceEditorBuffers>(() => ({ files, jumpRequest: null }), [files])

  return (
    <WorkspaceSelectionContext.Provider value={STABLE_SELECTION}>
      <WorkspaceEditorTabsContext.Provider value={STABLE_TABS}>
        <WorkspaceEditorBuffersContext.Provider value={buffers}>
          {/* each click mutates `files` — stands in for a keystroke's updateDraft */}
          <button onClick={() => setFiles({ 'a.md': { draft: `k${++keystrokeSeq}` } as FileState })}>
            type
          </button>
          <SelectionConsumer />
          <TabsConsumer />
          <BuffersConsumer />
        </WorkspaceEditorBuffersContext.Provider>
      </WorkspaceEditorTabsContext.Provider>
    </WorkspaceSelectionContext.Provider>
  )
}

describe('editor context isolation', () => {
  it('a files (keystroke) change re-renders only buffers consumers, not selection/tabs', () => {
    const { getByText } = render(<Harness />)
    const base = { ...counts }
    expect(base.selection).toBe(1)
    expect(base.tabs).toBe(1)
    expect(base.buffers).toBe(1)

    // Simulate three keystrokes: each mutates `files`.
    fireEvent.click(getByText('type'))
    fireEvent.click(getByText('type'))
    fireEvent.click(getByText('type'))

    // The terminal/session/tree stand-in (selection) and the tab bar (tabs) never
    // re-rendered; only the editor body (buffers) did.
    expect(counts.selection).toBe(base.selection)   // 1 — never re-rendered on a keystroke
    expect(counts.tabs).toBe(base.tabs)             // 1 — never re-rendered on a keystroke
    expect(counts.buffers).toBe(base.buffers + 3)   // re-rendered per keystroke (it must)
  })
})
