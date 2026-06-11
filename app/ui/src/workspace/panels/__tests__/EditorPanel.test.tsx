// @vitest-environment jsdom
//
// EditorPanel isolation test — render the panel inside a mock of the five T1b
// contexts and assert it reproduces the inline editor body: the unframed editor
// column (tab bar + breadcrumbs + editor area), tabs sourced from selection, the
// editor-pref Suggestions toggle routed through the layout actions, and the
// compare context derived from a self-describing diff tab id.
//
// The mock provider is inlined and named with an EditorPanel prefix so the seven
// panels sharing panels/__tests__/ never collide on merge.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EditorPanel, editorPanelDef } from '../EditorPanel'
import { DEFAULT_LAYOUT, type WorkspaceLayout } from '../../../hooks/workspaceTypes'
import { fetchGitBaseline, fetchGitCompare, fetchGitDiff } from '../../../hooks/useApi'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceData, type WorkspaceSelection,
  type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceRawActions,
} from '../../context'

// Stub the network reads the panel drives: editor baseline, diff content, and
// the on-demand compare file list. Everything else (API base for useVoice) is
// kept real so the voice machine initializes exactly as in the app.
vi.mock('../../../hooks/useApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useApi')>()
  return {
    ...actual,
    fetchGitBaseline: vi.fn().mockResolvedValue({ content: '', exists: false }),
    fetchGitDiff: vi.fn().mockResolvedValue(''),
    fetchGitCompare: vi.fn().mockResolvedValue({ files: [], stats: { added: 0, deleted: 0 } }),
  }
})

const mockFetchGitBaseline = vi.mocked(fetchGitBaseline)
const mockFetchGitDiff = vi.mocked(fetchGitDiff)
const mockFetchGitCompare = vi.mocked(fetchGitCompare)

// The tab bar observes its scroll container; jsdom has no ResizeObserver.
vi.stubGlobal('ResizeObserver', class {
  observe() { /* no-op */ }
  unobserve() { /* no-op */ }
  disconnect() { /* no-op */ }
})

afterEach(cleanup)
beforeEach(() => {
  mockFetchGitBaseline.mockReset().mockResolvedValue({ content: '', exists: false })
  mockFetchGitDiff.mockReset().mockResolvedValue('')
  mockFetchGitCompare.mockReset().mockResolvedValue({ files: [], stats: { added: 0, deleted: 0 } })
})

// A minimal unified diff so the diff view renders its toolbar (and the compare
// ref bar) instead of the empty "No changes detected" state.
const FOO_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,2 +1,2 @@',
  ' context',
  '-old line',
  '+new line',
  '',
].join('\n')

type EditorPanelHarnessInput = {
  openTabs?: string[]
  activeTab?: string | null
  previewTab?: string | null
  layout?: Partial<WorkspaceLayout>
}

// Records every command/action the panel can invoke so behavioral wiring (e.g.
// the Suggestions toggle → updateLayout) is observable.
function makeEditorPanelCommands() {
  const actions = {
    setActiveTab: vi.fn(), setActiveSession: vi.fn(), setMobilePane: vi.fn(),
    updateLayout: vi.fn(),
    openFileTab: vi.fn(), openPreviewTab: vi.fn(), openDiffTab: vi.fn(),
    openPreviewDiffTab: vi.fn(), openPreviewDiffTabById: vi.fn(),
    setJumpRequest: vi.fn(), setShowSearch: vi.fn(),
  } as unknown as WorkspaceRawActions

  const commands = {
    openFile: vi.fn(), previewFile: vi.fn(), openFileAtLine: vi.fn(),
    openDiff: vi.fn(), openDiffTabId: vi.fn(), closeTab: vi.fn(), selectTab: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ conflict: false }),
    forceSave: vi.fn().mockResolvedValue(undefined),
    acceptDisk: vi.fn(), updateDraft: vi.fn(), updateViewport: vi.fn(),
    retargetPaths: vi.fn(), deletePath: vi.fn(),
    attachSession: vi.fn(), detachSession: vi.fn(), openTerminalForSession: vi.fn(),
    setSelectedFilePath: vi.fn(), setExplorerFocusedPath: vi.fn(), setFocusTarget: vi.fn(),
    revealPathInFiles: vi.fn(), expandFolderInFiles: vi.fn(), setFilesMode: vi.fn(),
    showQuickOpen: vi.fn(), closeFocusedSurface: vi.fn(),
    collapsePanel: vi.fn(), resizeSplitChild: vi.fn(), toggleDock: vi.fn(), toggleActivity: vi.fn(),
    activateTabsPanel: vi.fn(), movePanel: vi.fn(), splitPanel: vi.fn(), resetLayout: vi.fn(),
    setEditorPrefs: vi.fn(),
    actions,
  } as unknown as WorkspaceCommands

  return { commands, actions }
}

function renderEditorPanel(input: EditorPanelHarnessInput = {}) {
  const { commands, actions } = makeEditorPanelCommands()

  const env = {
    project: { name: 'demo', path: '/demo', worktree: undefined, effectivePath: '/demo' },
    viewport: { isMobile: false, isLandscape: true, isTouch: false },
  } as unknown as WorkspaceEnv

  const data = {
    git: { changes: [] },
    sessions: { liveSessionHandles: new Set<string>() },
  } as unknown as WorkspaceData

  const selection = {
    openTabs: input.openTabs ?? [],
    activeTab: input.activeTab ?? null,
    previewTab: input.previewTab ?? null,
    activeSession: '',
    selectedFilePath: null,
    explorerFocusedPath: null,
    focusTarget: 'editor',
    recentFiles: [],
    showSearch: false,
    editor: { files: {}, dirtyTabs: new Set<string>(), conflictTabs: new Set<string>(), jumpRequest: null },
  } as unknown as WorkspaceSelection

  const layoutValue = {
    layout: { ...DEFAULT_LAYOUT, ...input.layout },
    mobilePane: 'editor',
  } as WorkspaceLayoutContextValue

  const ui: ReactNode = (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceLayoutContext.Provider value={layoutValue}>
            <WorkspaceSelectionContext.Provider value={selection}>
              <EditorPanel />
            </WorkspaceSelectionContext.Provider>
          </WorkspaceLayoutContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )

  return { commands, actions, ...render(ui) }
}

describe('editorPanelDef', () => {
  it('is an unframed editor panel with no shared header hook', () => {
    expect(editorPanelDef.id).toBe('editor')
    expect(editorPanelDef.chrome).toBe('unframed')
    expect(editorPanelDef.mobileDock).toBe('editor')
    expect(editorPanelDef.useHeader).toBeUndefined()
    expect(editorPanelDef.Component).toBe(EditorPanel)
    expect(editorPanelDef.minSize.width).toBeGreaterThan(0)
    expect(editorPanelDef.minSize.height).toBeGreaterThan(0)
  })
})

describe('EditorPanel — behavior-equivalent to the inline editor body', () => {
  it('renders the empty editor column: tab bar, the No-file-open prompt, and the Suggestions toggle', () => {
    renderEditorPanel()
    // Editor area empty state + tab bar empty state (the unframed column chrome).
    expect(screen.getByText('No file open')).toBeTruthy()
    expect(screen.getByText('No files open')).toBeTruthy()
    // The always-present editor-pref toggle in the tab bar's right actions.
    expect(screen.getByRole('button', { name: /Suggestions/ })).toBeTruthy()
    expect(screen.queryByText('Suggestions')).toBeNull()
    // No compare tab is active, so no compare list is fetched.
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
  })

  it('renders open tabs from the selection context', () => {
    renderEditorPanel({ openTabs: ['src/alpha.ts', 'docs/beta.md'] })
    expect(screen.getAllByTestId('tab')).toHaveLength(2)
    expect(screen.getByText('alpha.ts')).toBeTruthy()
    expect(screen.getByText('beta.md')).toBeTruthy()
  })

  it('toggling Suggestions drives an editor-pref layout update', () => {
    const { actions } = renderEditorPanel({ layout: { autocompleteEnabled: false } })
    fireEvent.click(screen.getByRole('button', { name: /Suggestions/ }))
    expect(actions.updateLayout).toHaveBeenCalledWith({ autocompleteEnabled: true })
  })

  // Editor voice + insertion are owned by the single screen-level voice surface
  // (one useVoice + one ComposeTray), wired in fl-panel-integrate. Until then the
  // panel passes an inert voice, so no voice control renders even on an editable
  // file, and editorInsert stays null.
  it('renders no voice control (voice/insertion is integration-owned)', () => {
    // An open file tab with no loaded content keeps the editor area on its loading
    // spinner — exercising the editable surface without mounting CodeMirror.
    renderEditorPanel({ openTabs: ['notes.md'], activeTab: 'notes.md' })
    expect(screen.getByRole('button', { name: /Suggestions/ })).toBeTruthy()
    expect(screen.queryByLabelText(/voice/i)).toBeNull()
  })

  // T1b made diff tab ids self-describing (they carry their own base/compare), and
  // the design has EditorPanel "derive CompareContext from the active diff tab id"
  // with the file list fetched on demand. This is the intended evolution from the
  // old behavior, where the compare toolbar only showed while the Changes panel's
  // compareMode was on — here the toolbar follows the tab id alone.
  it('derives compare context from a self-describing diff tab id', async () => {
    mockFetchGitDiff.mockResolvedValue(FOO_DIFF)
    mockFetchGitCompare.mockResolvedValue({
      files: [{ path: 'src/foo.ts', status: 'M' }, { path: 'src/bar.ts', status: 'M' }],
      stats: { added: 1, deleted: 1 },
    })
    // No compareMode flag anywhere in the mock provider — the tab id is the only signal.
    renderEditorPanel({ activeTab: 'diff:src/foo.ts?base=main&compare=HEAD' })
    // The compare file list is fetched on demand from the tab's refs.
    await waitFor(() =>
      expect(mockFetchGitCompare).toHaveBeenCalledWith('demo', 'main', 'HEAD', undefined),
    )
    // The derived compare context reaches the diff view's ref bar...
    expect(await screen.findByText('main')).toBeTruthy()
    expect(await screen.findByText('HEAD')).toBeTruthy()
    // ...and its file list drives the compare prev/next navigation.
    expect(await screen.findByRole('button', { name: 'Previous file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next file' })).toBeTruthy()
  })

  it('navigating compare files opens the sibling compare diff tab', async () => {
    mockFetchGitDiff.mockResolvedValue(FOO_DIFF)
    mockFetchGitCompare.mockResolvedValue({
      files: [{ path: 'src/foo.ts', status: 'M' }, { path: 'src/bar.ts', status: 'M' }],
      stats: { added: 1, deleted: 1 },
    })
    const { actions, commands } = renderEditorPanel({ activeTab: 'diff:src/foo.ts?base=main&compare=HEAD' })
    fireEvent.click(await screen.findByRole('button', { name: 'Next file' }))
    // onNavigate opens the next file as a self-describing compare diff and focuses the editor.
    expect(actions.openPreviewDiffTabById).toHaveBeenCalledWith('diff:src/bar.ts?base=main&compare=HEAD')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('editor')
  })

  it('does not fetch a compare list for a plain (non-compare) diff tab', async () => {
    renderEditorPanel({ activeTab: 'diff:src/foo.ts' })
    await waitFor(() => expect(mockFetchGitDiff).toHaveBeenCalled())
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull()
  })
})
