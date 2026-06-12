// @vitest-environment jsdom
//
// EditorPanel isolation test (design: VSCode Tab Groups / vt-bodies).
//
// Under the flat tab-group model an editor instance IS a single tab: the panel
// reads its `instanceId` from `usePanelInstance()` and resolves its ONE file/diff
// from the group tree via `editorTabByInstance` — never from a tab bar, never from
// another instance. The GROUP owns the tab strip, so the body renders no `tab`
// elements. These describes assert the single-tab body + per-instance gating + the
// shared per-path buffer.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EditorPanel, editorPanelDef } from '../EditorPanel'
import { PanelInstanceProvider } from '../../panelInstance'
import {
  DEFAULT_LAYOUT, type FileState, type WorkspaceLayout,
  type TabsNode, type WorkspacePanelLayout,
} from '../../../hooks/workspaceTypes'
import { fetchGitBaseline, fetchGitCompare, fetchGitDiff } from '../../../hooks/useApi'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceVoiceContext,
  DEFAULT_WORKSPACE_VOICE,
  type WorkspaceEnv, type WorkspaceData, type WorkspaceSelection,
  type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceRawActions,
  type WorkspaceVoiceSurface, type VoiceControlState,
} from '../../context'

// Replace the CodeMirror editor leaf with a stub that echoes its content/filePath/
// insertText props, so the single-file body + the per-instance/per-file insert gate
// + the shared per-path buffer are observable without mounting CM. Only a
// content-bearing file tab renders <Editor>; the diff/loading/empty tests use other
// branches, so this mock leaves them untouched.
vi.mock('../../../components/Editor', () => ({
  Editor: ({ insertText, content, filePath }: { insertText?: string | null; content?: string; filePath?: string }) =>
    <div data-testid="cm-editor" data-insert-text={insertText ?? ''} data-content={content ?? ''} data-file-path={filePath ?? ''} />,
}))

// Stub the network reads the panel drives: editor baseline, diff content, and the
// on-demand compare file list. Everything else (API base for useVoice) is kept real
// so the voice machine initializes exactly as in the app.
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

// The diff/preview surfaces observe their scroll container; jsdom has no ResizeObserver.
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

// A minimal unified diff so the diff view renders its toolbar (and the compare ref
// bar) instead of the empty "No changes detected" state.
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

type TabSpec = { instanceId: string; tabId: string; preview?: boolean }

type EditorPanelHarnessInput = {
  // When set, the panel is wrapped in a PanelInstanceProvider for this instance;
  // omitted → rendered bare, exercising the active-editor ('editor') fallback.
  instanceId?: string
  // The single file/diff this instance's tab shows (its tabId). null/omitted → this
  // instance has no tab in the group → the "No file open" empty body.
  tabId?: string | null
  // Marks this instance's single tab as the group's preview tab.
  preview?: boolean
  // Extra tabs for OTHER instances in the same group (instance-routing / shared
  // buffer). Defaults to just this instance's tab.
  tabs?: TabSpec[]
  // The group's active tab instanceId (defaults to the rendered instance). Set it to
  // a sibling to prove the body reads ITS OWN tab, not the group's active one.
  activeInstance?: string
  conflictTabs?: string[]
  // Shared per-path buffers (content) so a file tab mounts the (stubbed) editor.
  files?: Record<string, Partial<FileState>>
  // A queued voice insert ({ text, key, instanceId, filePath }) on the voice surface.
  editorInsert?: { text: string; key: number; instanceId?: string; filePath?: string }
  // When true, the screen voice surface marks the editor mic eligible.
  voiceEditorEligible?: boolean
  layout?: Partial<WorkspaceLayout>
  isMobile?: boolean
}

// Records every command/action the panel can invoke so behavioral wiring (the
// Suggestions toggle → updateLayout, compare-nav → openPreviewDiffTabByIdIn(id,
// tabId), focus → focusPane(id)) is observable.
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

// One group holding the spec's editor tabs (the working area for the test).
function buildPanelLayout(tabs: TabSpec[], activeInstance: string): WorkspacePanelLayout {
  const group: TabsNode = {
    kind: 'tabs',
    id: 'group:1',
    tabs: tabs.map(t => ({ instanceId: t.instanceId, kind: 'editor', tabId: t.tabId, ...(t.preview ? { preview: true } : {}) })),
    activeTab: activeInstance,
  }
  return {
    version: 1,
    desktop: group,
    mobile: { activeDock: 'editor' },
    panelState: { files: { mode: 'tree' }, editor: { previewMode: 'edit', splitDirection: 'horizontal', splitSize: 50, autocompleteEnabled: false } },
  } as unknown as WorkspacePanelLayout
}

function buildContexts(input: EditorPanelHarnessInput) {
  const { commands, actions } = makeEditorPanelCommands()
  const id = input.instanceId ?? 'editor'
  const tabs = input.tabs
    ?? (input.tabId ? [{ instanceId: id, tabId: input.tabId, preview: input.preview } as TabSpec] : [])
  const activeInstance = input.activeInstance ?? tabs[0]?.instanceId ?? ''

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
    activeSession: '',
    activeGroupId: 'group:1',
    activeEditorTab: null,
    activeEditorTabId: null,
    activeEditorPath: null,
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
      dirtyTabs: new Set<string>(),
      conflictTabs: new Set<string>(input.conflictTabs ?? []),
      jumpRequest: null,
    },
  } as unknown as WorkspaceSelection

  const layoutValue = {
    layout: { ...DEFAULT_LAYOUT, ...input.layout },
    mobilePane: 'editor',
    panelLayout: buildPanelLayout(tabs, activeInstance),
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

describe('EditorPanel — single-tab body (no own tab bar)', () => {
  it('renders the single file of its tab — the editor body, no tab strip', () => {
    renderEditorPanel({ instanceId: 'editor:2', tabId: 'notes.md', files: { 'notes.md': { serverContent: 'hi' } } })
    const cm = screen.getByTestId('cm-editor')
    expect(cm.getAttribute('data-file-path')).toBe('notes.md')
    expect(cm.getAttribute('data-content')).toBe('hi')
    // The group owns the tab strip — the body renders no tabs.
    expect(screen.queryByTestId('tab')).toBeNull()
  })

  it('with no tab open, renders the No-file-open prompt + the Suggestions toggle, no tab strip', () => {
    renderEditorPanel({ instanceId: 'editor:2', tabId: null })
    expect(screen.getByText('No file open')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Suggestions/ })).toBeTruthy()
    expect(screen.queryByTestId('tab')).toBeNull()
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
  })

  it('toggling Suggestions drives an editor-pref layout update', () => {
    const { actions } = renderEditorPanel({ instanceId: 'editor:2', tabId: 'notes.md', files: { 'notes.md': { serverContent: '' } }, layout: { autocompleteEnabled: false } })
    fireEvent.click(screen.getByRole('button', { name: /Suggestions/ }))
    expect(actions.updateLayout).toHaveBeenCalledWith({ autocompleteEnabled: true })
  })
})

describe('EditorPanel — instance routing', () => {
  it('renders ITS instance tab — not the group active tab, not a sibling', () => {
    // group active is 'editor' (a.ts); we render editor:2 (only.ts) → it shows only.ts.
    renderEditorPanel({
      instanceId: 'editor:2',
      tabs: [
        { instanceId: 'editor', tabId: 'src/a.ts' },
        { instanceId: 'editor:2', tabId: 'src/only.ts' },
      ],
      activeInstance: 'editor',
      files: { 'src/a.ts': { serverContent: 'A' }, 'src/only.ts': { serverContent: 'ONLY' } },
    })
    const cm = screen.getByTestId('cm-editor')
    expect(cm.getAttribute('data-file-path')).toBe('src/only.ts')
    expect(cm.getAttribute('data-content')).toBe('ONLY')
  })

  it('falls back to the active editor instance ("editor") outside a PanelHost', () => {
    renderEditorPanel({ tabId: 'src/a.ts', files: { 'src/a.ts': { serverContent: 'A' } } })
    expect(screen.getByTestId('cm-editor').getAttribute('data-file-path')).toBe('src/a.ts')
  })

  it('mousedown on the editor body focuses THIS instance', () => {
    const { commands } = renderEditorPanel({ instanceId: 'editor:2', tabId: null })
    fireEvent.mouseDown(screen.getByText('No file open'))
    expect(commands.focusPane).toHaveBeenCalledWith('editor', 'editor:2')
  })
})

describe('EditorPanel — voice insert gating (instanceId + filePath)', () => {
  const insertTextOf = () => screen.getByTestId('cm-editor').getAttribute('data-insert-text')

  it('applies an insert aimed at this instance AND its active file', () => {
    renderEditorPanel({
      instanceId: 'editor:2', tabId: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor:2', filePath: 'src/a.ts' },
    })
    expect(insertTextOf()).toBe('TYPED')
  })

  it('does NOT apply an insert aimed at a different instance', () => {
    renderEditorPanel({
      instanceId: 'editor:2', tabId: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor', filePath: 'src/a.ts' },
    })
    expect(insertTextOf()).toBe('')
  })

  it('does NOT apply an insert whose filePath !== the current active tab (stale after switch)', () => {
    renderEditorPanel({
      instanceId: 'editor:2', tabId: 'src/a.ts',
      files: { 'src/a.ts': { serverContent: 'x' } },
      editorInsert: { text: 'TYPED', key: 1, instanceId: 'editor:2', filePath: 'src/other.ts' },
    })
    expect(insertTextOf()).toBe('')
  })
})

describe('EditorPanel — per-pane mic is mobile-only', () => {
  it('renders no per-pane mic on desktop even when the voice surface is eligible', () => {
    renderEditorPanel({ instanceId: 'editor:2', tabId: 'notes.md', files: { 'notes.md': { serverContent: '' } }, voiceEditorEligible: true })
    expect(screen.queryByRole('button', { name: /recording/i })).toBeNull()
  })

  it('renders the per-pane mic on mobile when eligible', () => {
    renderEditorPanel({ instanceId: 'editor:2', tabId: 'notes.md', files: { 'notes.md': { serverContent: '' } }, voiceEditorEligible: true, isMobile: true })
    expect(screen.getByRole('button', { name: /recording/i })).toBeTruthy()
  })
})

describe('EditorPanel — compare diff tabs', () => {
  it('derives compare context from a self-describing diff tab id', async () => {
    mockFetchGitDiff.mockResolvedValue(FOO_DIFF)
    mockFetchGitCompare.mockResolvedValue({
      files: [{ path: 'src/foo.ts', status: 'M' }, { path: 'src/bar.ts', status: 'M' }],
      stats: { added: 1, deleted: 1 },
    })
    renderEditorPanel({ instanceId: 'editor:2', tabId: 'diff:src/foo.ts?base=main&compare=HEAD' })
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
      instanceId: 'editor:2', tabId: 'diff:src/foo.ts?base=main&compare=HEAD',
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Next file' }))
    // Instance-scoped open: lands in THIS editor's group (editor:2), not the active one.
    expect(actions.openPreviewDiffTabByIdIn).toHaveBeenCalledWith('editor:2', 'diff:src/bar.ts?base=main&compare=HEAD')
    expect(actions.openPreviewDiffTabById).not.toHaveBeenCalled()
    expect(commands.focusPane).toHaveBeenCalledWith('editor', 'editor:2')
  })

  it('does not fetch a compare list for a plain (non-compare) diff tab', async () => {
    renderEditorPanel({ instanceId: 'editor:2', tabId: 'diff:src/foo.ts' })
    await waitFor(() => expect(mockFetchGitDiff).toHaveBeenCalled())
    expect(mockFetchGitCompare).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull()
  })
})

describe('EditorPanel — shared per-path buffer', () => {
  // Two editor tabs on one path (two instanceIds, two groups in real use) read the
  // SAME per-path buffer, so both render the same content and a buffer edit mirrors
  // to both — the FLAT linchpin.
  const twoPanels = (files: Record<string, Partial<FileState>>) => {
    const ctx = buildContexts({
      instanceId: 'editor',
      tabs: [
        { instanceId: 'editor', tabId: 'src/shared.ts' },
        { instanceId: 'editor:2', tabId: 'src/shared.ts' },
      ],
      activeInstance: 'editor',
      files,
    })
    const node = (
      <>
        <PanelInstanceProvider value={{ type: 'editor', instanceId: 'editor' }}><EditorPanel /></PanelInstanceProvider>
        <PanelInstanceProvider value={{ type: 'editor', instanceId: 'editor:2' }}><EditorPanel /></PanelInstanceProvider>
      </>
    )
    return wrapProviders(ctx, node)
  }

  it('both panes render the same file, and an edit to the shared buffer mirrors to both', () => {
    const { rerender } = render(twoPanels({ 'src/shared.ts': { serverContent: 'ORIGINAL' } }))
    const bodies = () => screen.getAllByTestId('cm-editor')
    expect(bodies()).toHaveLength(2)
    expect(bodies().every(e => e.getAttribute('data-file-path') === 'src/shared.ts')).toBe(true)
    expect(bodies().every(e => e.getAttribute('data-content') === 'ORIGINAL')).toBe(true)

    // Editing the per-path buffer (a draft) updates BOTH bodies — they key on path,
    // not on instance.
    rerender(twoPanels({ 'src/shared.ts': { serverContent: 'ORIGINAL', draft: 'EDITED' } }))
    expect(bodies().every(e => e.getAttribute('data-content') === 'EDITED')).toBe(true)
  })
})
