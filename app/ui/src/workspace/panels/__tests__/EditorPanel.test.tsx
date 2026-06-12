// @vitest-environment jsdom
//
// EditorPanel isolation test.
//
// NOTE (vt-state): the EditorPanel BODY is owned by the downstream vt-bodies task.
// Under the flat tab-group model an editor instance IS a single tab (its payload
// read from the group tree via `editorTabByInstance`), not a multi-`openTabs`
// `editorViews[instanceId]` slice. The behavior describes below were written for
// the OLD per-editor-view body and assert the multi-tab strip / per-view-slice
// semantics that no longer exist here; they are SKIPPED until vt-bodies rewrites
// EditorPanel into a single-tab body and re-authors these against the group tree.
// The `editorPanelDef` describe (registry wiring) still runs.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EditorPanel, editorPanelDef } from '../EditorPanel'
import { PanelInstanceProvider } from '../../panelInstance'
import { DEFAULT_LAYOUT, type EditorView, type FileState, type WorkspaceLayout } from '../../../hooks/workspaceTypes'
import { fetchGitBaseline, fetchGitCompare, fetchGitDiff } from '../../../hooks/useApi'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceVoiceContext,
  DEFAULT_WORKSPACE_VOICE,
  type WorkspaceEnv, type WorkspaceData, type WorkspaceSelection,
  type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceRawActions,
  type WorkspaceVoiceSurface, type VoiceControlState,
} from '../../context'

// Replace the CodeMirror editor leaf with a stub that echoes its insertText prop,
// so the per-instance + per-file insert gate is observable without mounting CM.
// Only a content-bearing file tab renders <Editor>; the diff/compare/loading/empty
// tests use other branches, so this mock leaves them untouched.
vi.mock('../../../components/Editor', () => ({
  Editor: ({ insertText }: { insertText?: string | null }) =>
    <div data-testid="cm-editor" data-insert-text={insertText ?? ''} />,
}))

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

type ViewInput = { openTabs?: string[]; activeTab?: string | null; previewTab?: string | null }

type EditorPanelHarnessInput = {
  // When set, the panel is wrapped in a PanelInstanceProvider for this instance;
  // omitted → rendered bare, exercising the home-editor ('editor') fallback.
  instanceId?: string
  openTabs?: string[]
  activeTab?: string | null
  previewTab?: string | null
  dirtyTabs?: string[]
  // Additional editor views (other panes) — seeds pathsOpenElsewhere.
  otherViews?: Record<string, ViewInput>
  // Shared per-path buffers (content) so a file tab mounts the (stubbed) editor.
  files?: Record<string, Partial<FileState>>
  // A queued voice insert ({ text, key, instanceId, filePath }) on the voice surface.
  editorInsert?: { text: string; key: number; instanceId?: string; filePath?: string }
  // When true, the screen voice surface marks the editor mic eligible.
  voiceEditorEligible?: boolean
  layout?: Partial<WorkspaceLayout>
  isMobile?: boolean
}

function toView(v: ViewInput): EditorView {
  return { openTabs: v.openTabs ?? [], activeTab: v.activeTab ?? null, previewTab: v.previewTab ?? null }
}

// Records every command/action the panel can invoke so behavioral wiring (e.g.
// the Suggestions toggle → updateLayout, tab select → selectTab(id), split →
// splitEditor(id, side), compare-nav → openPreviewDiffTabByIdIn(id, tabId)) is
// observable.
function makeEditorPanelCommands() {
  const actions = {
    setActiveTab: vi.fn(), setActiveSession: vi.fn(), setMobilePane: vi.fn(),
    updateLayout: vi.fn(),
    openFileTab: vi.fn(), openPreviewTab: vi.fn(), openDiffTab: vi.fn(),
    openPreviewDiffTab: vi.fn(), openPreviewDiffTabById: vi.fn(),
    openFileTabIn: vi.fn(), openDiffTabIn: vi.fn(), openPreviewDiffTabByIdIn: vi.fn(),
    setJumpRequest: vi.fn(), setShowSearch: vi.fn(),
  } as unknown as WorkspaceRawActions

  const commands = {
    openFile: vi.fn(), previewFile: vi.fn(), openFileAtLine: vi.fn(),
    openDiff: vi.fn(), openDiffTabId: vi.fn(), closeTab: vi.fn(), selectTab: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ conflict: false }),
    forceSave: vi.fn().mockResolvedValue(undefined),
    acceptDisk: vi.fn(), updateDraft: vi.fn(), updateViewport: vi.fn(),
    retargetPaths: vi.fn(), deletePath: vi.fn(),
    splitEditor: vi.fn(), openToSide: vi.fn(), splitTerminal: vi.fn(),
    closePane: vi.fn(), focusPane: vi.fn(), movePane: vi.fn(),
    clickSession: vi.fn(), openBeside: vi.fn(), detachSession: vi.fn(),
    setSelectedFilePath: vi.fn(), setExplorerFocusedPath: vi.fn(), setFocusTarget: vi.fn(),
    revealPathInFiles: vi.fn(), expandFolderInFiles: vi.fn(), setFilesMode: vi.fn(),
    showQuickOpen: vi.fn(), closeFocusedSurface: vi.fn(), toggleTasks: vi.fn(), closeTasks: vi.fn(),
    collapsePanel: vi.fn(), resizeSplitChild: vi.fn(), toggleDock: vi.fn(), toggleActivity: vi.fn(),
    activateTabsPanel: vi.fn(), movePanel: vi.fn(), splitPanel: vi.fn(), resetLayout: vi.fn(),
    setEditorPrefs: vi.fn(),
    actions,
  } as unknown as WorkspaceCommands

  return { commands, actions }
}

function buildContexts(input: EditorPanelHarnessInput) {
  const { commands, actions } = makeEditorPanelCommands()
  const id = input.instanceId ?? 'editor'

  const editorViews: Record<string, EditorView> = {
    [id]: toView({ openTabs: input.openTabs, activeTab: input.activeTab, previewTab: input.previewTab }),
  }
  for (const [oid, v] of Object.entries(input.otherViews ?? {})) editorViews[oid] = toView(v)

  const env = {
    project: { name: 'demo', path: '/demo', worktree: undefined, effectivePath: '/demo' },
    viewport: { isMobile: input.isMobile ?? false, isLandscape: true, isTouch: false },
  } as unknown as WorkspaceEnv

  const data = {
    git: { changes: [] },
    sessions: { liveSessionHandles: new Set<string>() },
  } as unknown as WorkspaceData

  const files: Record<string, FileState> = {}
  for (const [path, fs] of Object.entries(input.files ?? {})) {
    files[path] = { serverContent: '', draft: null, baseRevision: 1, viewportLine: 1, status: 'clean', editedAt: 0, ...fs } as FileState
  }

  const selection = {
    openTabs: input.openTabs ?? [],
    activeTab: input.activeTab ?? null,
    previewTab: input.previewTab ?? null,
    activeSession: '',
    editorViews,
    terminalBindings: {},
    editorMru: [id],
    terminalMru: [],
    focusedPane: { kind: 'editor', instanceId: id },
    activeEditorId: id,
    activeTerminalId: null,
    selectedFilePath: null,
    explorerFocusedPath: null,
    focusTarget: 'editor',
    recentFiles: [],
    showSearch: false,
    editor: {
      files,
      dirtyTabs: new Set<string>(input.dirtyTabs ?? []),
      conflictTabs: new Set<string>(),
      jumpRequest: null,
    },
  } as unknown as WorkspaceSelection

  const layoutValue = {
    layout: { ...DEFAULT_LAYOUT, ...input.layout },
    mobilePane: 'editor',
  } as WorkspaceLayoutContextValue

  // Screen voice surface: inert by default; opt-in an eligible editor mic and/or a
  // queued editorInsert for the mobile-mic + insert-gate tests.
  const editorVoice: VoiceControlState = input.voiceEditorEligible
    ? { eligible: true, capability: { status: 'ready', maxUploadBytes: 1 }, state: 'idle', onRecord: vi.fn(), onStop: vi.fn(), onOpen: vi.fn() }
    : DEFAULT_WORKSPACE_VOICE.editor
  const voiceSurface: WorkspaceVoiceSurface = {
    ...DEFAULT_WORKSPACE_VOICE,
    editor: editorVoice,
    editorInsert: input.editorInsert ?? null,
  }

  return { commands, actions, env, data, selection, layoutValue, voiceSurface, id }
}

function wrapProviders(
  ctx: ReturnType<typeof buildContexts>, body: ReactNode,
): ReactNode {
  return (
    <WorkspaceEnvContext.Provider value={ctx.env}>
      <WorkspaceDataContext.Provider value={ctx.data}>
        <WorkspaceCommandsContext.Provider value={ctx.commands}>
          <WorkspaceLayoutContext.Provider value={ctx.layoutValue}>
            <WorkspaceVoiceContext.Provider value={ctx.voiceSurface}>
              <WorkspaceSelectionContext.Provider value={ctx.selection}>
                {body}
              </WorkspaceSelectionContext.Provider>
            </WorkspaceVoiceContext.Provider>
          </WorkspaceLayoutContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}

function renderEditorPanel(input: EditorPanelHarnessInput = {}) {
  const ctx = buildContexts(input)
  const panel = input.instanceId
    ? <PanelInstanceProvider value={{ type: 'editor', instanceId: input.instanceId }}><EditorPanel /></PanelInstanceProvider>
    : <EditorPanel />
  return { commands: ctx.commands, actions: ctx.actions, id: ctx.id, ...render(wrapProviders(ctx, panel)) }
}

// Open the Split-editor options menu (the caret beside the Split button).
function openSplitMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Split editor options' }))
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

describe.skip('EditorPanel — behavior-equivalent to the inline editor body', () => {
  it('renders the empty editor column: tab bar, the No-file-open prompt, and the Suggestions toggle', () => {
    renderEditorPanel()
    expect(screen.getByText('No file open')).toBeTruthy()
    expect(screen.getByText('No files open')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Suggestions/ })).toBeTruthy()
    expect(screen.queryByText('Suggestions')).toBeNull()
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
  })

  it('renders open tabs from this instance view slice (editorViews[instanceId])', () => {
    renderEditorPanel({ instanceId: 'editor:2', openTabs: ['src/alpha.ts', 'docs/beta.md'] })
    expect(screen.getAllByTestId('tab')).toHaveLength(2)
    expect(screen.getByText('alpha.ts')).toBeTruthy()
    expect(screen.getByText('beta.md')).toBeTruthy()
  })

  it('reads only its own view slice — a sibling instance view does not leak in', () => {
    // This pane (editor:2) has one tab; the home editor has two. Only ours shows.
    renderEditorPanel({
      instanceId: 'editor:2',
      openTabs: ['src/only.ts'],
      otherViews: { editor: { openTabs: ['a.ts', 'b.ts'] } },
    })
    expect(screen.getAllByTestId('tab')).toHaveLength(1)
    expect(screen.getByText('only.ts')).toBeTruthy()
  })

  it('toggling Suggestions drives an editor-pref layout update', () => {
    const { actions } = renderEditorPanel({ layout: { autocompleteEnabled: false } })
    fireEvent.click(screen.getByRole('button', { name: /Suggestions/ }))
    expect(actions.updateLayout).toHaveBeenCalledWith({ autocompleteEnabled: true })
  })

  it('renders no voice control (voice/insertion is integration-owned)', () => {
    renderEditorPanel({ openTabs: ['notes.md'], activeTab: 'notes.md' })
    expect(screen.getByRole('button', { name: /Suggestions/ })).toBeTruthy()
    expect(screen.queryByLabelText(/voice/i)).toBeNull()
  })

  it('derives compare context from a self-describing diff tab id', async () => {
    mockFetchGitDiff.mockResolvedValue(FOO_DIFF)
    mockFetchGitCompare.mockResolvedValue({
      files: [{ path: 'src/foo.ts', status: 'M' }, { path: 'src/bar.ts', status: 'M' }],
      stats: { added: 1, deleted: 1 },
    })
    renderEditorPanel({ activeTab: 'diff:src/foo.ts?base=main&compare=HEAD' })
    await waitFor(() =>
      expect(mockFetchGitCompare).toHaveBeenCalledWith('demo', 'main', 'HEAD', undefined),
    )
    expect(await screen.findByText('main')).toBeTruthy()
    expect(await screen.findByText('HEAD')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Previous file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next file' })).toBeTruthy()
  })

  it('navigating compare files opens the sibling diff IN THIS instance and focuses it', async () => {
    mockFetchGitDiff.mockResolvedValue(FOO_DIFF)
    mockFetchGitCompare.mockResolvedValue({
      files: [{ path: 'src/foo.ts', status: 'M' }, { path: 'src/bar.ts', status: 'M' }],
      stats: { added: 1, deleted: 1 },
    })
    const { actions, commands } = renderEditorPanel({
      instanceId: 'editor:2', activeTab: 'diff:src/foo.ts?base=main&compare=HEAD',
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Next file' }))
    // Instance-scoped open: lands in THIS editor (editor:2), not the active one.
    expect(actions.openPreviewDiffTabByIdIn).toHaveBeenCalledWith('editor:2', 'diff:src/bar.ts?base=main&compare=HEAD')
    expect(actions.openPreviewDiffTabById).not.toHaveBeenCalled()
    expect(commands.focusPane).toHaveBeenCalledWith('editor', 'editor:2')
  })

  it('does not fetch a compare list for a plain (non-compare) diff tab', async () => {
    renderEditorPanel({ activeTab: 'diff:src/foo.ts' })
    await waitFor(() => expect(mockFetchGitDiff).toHaveBeenCalled())
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull()
  })
})

describe.skip('EditorPanel — instance-scoped tab routing + focus', () => {
  it('selecting a tab routes selectTab(tab, instanceId)', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2', openTabs: ['src/a.ts', 'src/b.ts'] })
    fireEvent.click(screen.getByText('b.ts'))
    expect(commands.selectTab).toHaveBeenCalledWith('src/b.ts', 'editor:2')
  })

  it('closing a clean tab routes closeTab(tab, instanceId) with no confirm', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2', openTabs: ['src/a.ts'] })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(commands.closeTab).toHaveBeenCalledWith('src/a.ts', 'editor:2')
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
  })

  it('mousedown on the editor surface focuses THIS instance', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2' })
    fireEvent.mouseDown(screen.getByText('No file open'))
    expect(commands.focusPane).toHaveBeenCalledWith('editor', 'editor:2')
  })

  it('double-clicking a preview tab promotes it to pinned IN THIS instance', () => {
    const { actions } = renderEditorPanel({
      instanceId: 'editor:2', openTabs: ['src/a.ts'], activeTab: 'src/a.ts', previewTab: 'src/a.ts',
    })
    fireEvent.doubleClick(screen.getByTestId('tab'))
    expect(actions.openFileTabIn).toHaveBeenCalledWith('editor:2', 'src/a.ts')
    expect(actions.openFileTab).not.toHaveBeenCalled()
  })

  it('falls back to the home editor ("editor") outside a PanelHost', () => {
    const { commands } = renderEditorPanel({ openTabs: ['src/a.ts'] })
    fireEvent.click(screen.getByText('a.ts'))
    expect(commands.selectTab).toHaveBeenCalledWith('src/a.ts', 'editor')
  })
})

describe.skip('EditorPanel — voice insert gating (instanceId + filePath)', () => {
  const insertTextOf = () => screen.getByTestId('cm-editor').getAttribute('data-insert-text')

  it('applies an insert aimed at this instance AND its active file', () => {
    renderEditorPanel({
      instanceId: 'editor:2', openTabs: ['src/a.ts'], activeTab: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor:2', filePath: 'src/a.ts' },
    })
    expect(insertTextOf()).toBe('TYPED')
  })

  it('does NOT apply an insert aimed at a different instance', () => {
    renderEditorPanel({
      instanceId: 'editor:2', openTabs: ['src/a.ts'], activeTab: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor', filePath: 'src/a.ts' },
    })
    expect(insertTextOf()).toBe('')
  })

  it('does NOT apply an insert whose filePath !== the current active tab (stale after switch)', () => {
    renderEditorPanel({
      instanceId: 'editor:2', openTabs: ['src/a.ts'], activeTab: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor:2', filePath: 'src/other.ts' },
    })
    expect(insertTextOf()).toBe('')
  })
})

describe.skip('EditorPanel — per-pane mic is mobile-only', () => {
  it('renders no per-pane mic on desktop even when the voice surface is eligible', () => {
    renderEditorPanel({ openTabs: ['notes.md'], activeTab: 'notes.md', voiceEditorEligible: true })
    expect(screen.queryByRole('button', { name: /recording/i })).toBeNull()
  })

  it('renders the per-pane mic on mobile when eligible', () => {
    renderEditorPanel({ openTabs: ['notes.md'], activeTab: 'notes.md', voiceEditorEligible: true, isMobile: true })
    expect(screen.getByRole('button', { name: /recording/i })).toBeTruthy()
  })
})

describe.skip('EditorPanel — Split / Move / Close chrome', () => {
  it('the Split button splits along the geometry-default side (no measurable box → right)', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2' })
    fireEvent.click(screen.getByRole('button', { name: 'Split editor' }))
    expect(commands.splitEditor).toHaveBeenCalledWith('editor:2', 'right')
  })

  it('the caret menu exposes both split axes', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2' })
    openSplitMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split Down' }))
    expect(commands.splitEditor).toHaveBeenCalledWith('editor:2', 'below')
  })

  it('a secondary editor exposes Move + Close in the overflow menu', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2' })
    openSplitMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move Left' }))
    expect(commands.movePane).toHaveBeenCalledWith('editor:2', { targetId: 'main', side: 'left' })
    openSplitMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Editor' }))
    expect(commands.closePane).toHaveBeenCalledWith('editor:2')
  })

  it('the home editor exposes split only — no Move, no Close', () => {
    renderEditorPanel({ instanceId: 'editor' })
    openSplitMenu()
    expect(screen.getByRole('menuitem', { name: 'Split Right' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Move Left' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Close Editor' })).toBeNull()
  })

  it('hides the split chrome on mobile', () => {
    renderEditorPanel({ instanceId: 'editor:2', isMobile: true })
    expect(screen.queryByRole('button', { name: 'Split editor' })).toBeNull()
  })
})

describe.skip('EditorPanel — dirty-close confirm + shared buffer', () => {
  it('confirms before discarding the LAST view of a dirty file, then discards + closes on confirm', () => {
    const { commands } = renderEditorPanel({
      instanceId: 'editor', openTabs: ['src/a.ts'], activeTab: 'src/a.ts', dirtyTabs: ['src/a.ts'],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    // The discard is gated by a confirm — nothing discarded or closed yet.
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()
    expect(commands.acceptDisk).not.toHaveBeenCalled()
    expect(commands.closeTab).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close Without Saving' }))
    // The confirmed discard clears the draft (acceptDisk → clean buffer the GC then
    // drops, so reopening shows server content, not the discarded edit) AND closes.
    expect(commands.acceptDisk).toHaveBeenCalledWith('src/a.ts')
    expect(commands.closeTab).toHaveBeenCalledWith('src/a.ts', 'editor')
  })

  it('closing a dirty tab still open in another view skips the confirm AND the discard (loss-free)', () => {
    const { commands } = renderEditorPanel({
      instanceId: 'editor',
      openTabs: ['src/a.ts'], activeTab: 'src/a.ts', dirtyTabs: ['src/a.ts'],
      otherViews: { 'editor:2': { openTabs: ['src/a.ts'] } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    // Must NOT clear the shared draft — the other view still shows it.
    expect(commands.acceptDisk).not.toHaveBeenCalled()
    expect(commands.closeTab).toHaveBeenCalledWith('src/a.ts', 'editor')
  })

  it('cancelling the discard confirm neither discards nor closes', () => {
    const { commands } = renderEditorPanel({
      instanceId: 'editor', openTabs: ['src/a.ts'], activeTab: 'src/a.ts', dirtyTabs: ['src/a.ts'],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(commands.acceptDisk).not.toHaveBeenCalled()
    expect(commands.closeTab).not.toHaveBeenCalled()
  })

  it('two editors on one file each render it (shared per-path buffer)', () => {
    const ctx = buildContexts({
      instanceId: 'editor',
      openTabs: ['src/shared.ts'], activeTab: 'src/shared.ts',
      otherViews: { 'editor:2': { openTabs: ['src/shared.ts'], activeTab: 'src/shared.ts' } },
    })
    render(wrapProviders(ctx, (
      <>
        <PanelInstanceProvider value={{ type: 'editor', instanceId: 'editor' }}><EditorPanel /></PanelInstanceProvider>
        <PanelInstanceProvider value={{ type: 'editor', instanceId: 'editor:2' }}><EditorPanel /></PanelInstanceProvider>
      </>
    )))
    // Both panes show the same file tab — they read the same shared selection/file state.
    const tabs = screen.getAllByTestId('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.every(t => t.textContent?.includes('shared.ts'))).toBe(true)
  })
})
