// @vitest-environment jsdom
//
// Non-vacuous link between the mobile dock metadata and what the projection
// renders: every dock's panes are derived from `mobileDockPanels(dock)`, so this
// test REMAPS that helper and asserts the projected `PanelHost`s follow — for
// editor/tasks/terminal too, not just browse. A projection that re-hardcoded any
// dock's owner would render the wrong markers and fail here. Pairs with the pure
// `mobileDocks.test.ts` (real metadata → membership/order); together they pin the
// full chain metadata → helper → render.
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'

// Mock the registry helper so a controlled remap drives the render.
vi.mock('../panelMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panelMeta')>()
  return { ...actual, mobileDockPanels: vi.fn() }
})
// Mock PanelHost to a marker so the test reads which panel ids project (and the
// bound instanceId), without mounting the real (provider-heavy) panel components.
vi.mock('../PanelHost', () => ({
  PanelHost: ({ id, instanceId }: { id: unknown; instanceId: unknown }) => (
    <div data-panel-host={String(id)} data-panel-instance={instanceId === undefined ? undefined : String(instanceId)} />
  ),
}))

import { MobilePanelProjection } from '../MobilePanelProjection'
import { mobileDockPanels, type MobileDock } from '../panelMeta'
import { defaultWorkspacePanelLayout } from '../panelLayoutModel'
import {
  WorkspaceEnvContext, WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceSelectionContext,
  WorkspaceEditorTabsContext, WorkspaceVoiceContext, DEFAULT_WORKSPACE_VOICE,
  type WorkspaceEnv, type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceSelection, type PanelId,
  type WorkspaceEditorTabs, type WorkspaceVoiceSurface,
} from '../context'
import type { FileState } from '../../hooks/workspaceTypes'

const mobileDockPanelsMock = vi.mocked(mobileDockPanels)

// Each dock points at panels OTHER than its hard-coded historical owner, so a
// projection that ignored the registry for editor/tasks/terminal would mismatch.
const REMAP: Record<MobileDock, PanelId[]> = {
  browse: ['sessions', 'projects'],
  editor: ['tasks'],
  tasks: ['terminal'],
  terminal: ['files'],
}

afterEach(cleanup)
beforeEach(() => {
  mobileDockPanelsMock.mockImplementation((dock: MobileDock) => REMAP[dock])
})

function renderDock(dock: MobileDock, opts: {
  panelLayout?: unknown
  layout?: unknown
  selection?: unknown
  commands?: Partial<WorkspaceCommands>
  voice?: WorkspaceVoiceSurface
  editorTabs?: WorkspaceEditorTabs
  files?: Record<string, FileState>
} = {}): void {
  const env = {
    viewport: { isMobile: true, isLandscape: false, isTouch: true },
    notificationBell: null,
  } as unknown as WorkspaceEnv
  const layoutValue = {
    panelLayout: opts.panelLayout ?? { ...defaultWorkspacePanelLayout(), mobile: { activeDock: dock } },
    mobilePane: 'files',
    layout: opts.layout ?? {},
  } as unknown as WorkspaceLayoutContextValue
  const commands = {
    collapsePanel: vi.fn(),
    setFocusTarget: vi.fn(),
    selectTab: vi.fn(),
    closePane: vi.fn(),
    saveFile: vi.fn(),
    acceptDisk: vi.fn(),
    setTabView: vi.fn(),
    setAutocomplete: vi.fn(),
    ...opts.commands,
    // The save handler reads live content off actions.filesRef; merge after the spread
    // so a commands override can still pass its own actions if needed.
    actions: { setMobilePane: vi.fn(), filesRef: { current: opts.files ?? {} }, ...(opts.commands as { actions?: object })?.actions },
  } as unknown as WorkspaceCommands
  const selection = (opts.selection ?? {
    activeEditorId: 'editor',
    activeTerminalId: 'terminal',
  }) as unknown as WorkspaceSelection
  const editorTabs: WorkspaceEditorTabs = opts.editorTabs ?? { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() }
  const rootRef = { current: null } as RefObject<HTMLDivElement | null>
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
          <WorkspaceCommandsContext.Provider value={commands}>
            <WorkspaceVoiceContext.Provider value={opts.voice ?? DEFAULT_WORKSPACE_VOICE}>
              <WorkspaceSelectionContext.Provider value={selection}>
                <WorkspaceEditorTabsContext.Provider value={editorTabs}>
                  <MobilePanelProjection rootRef={rootRef} searchOverlay={null} onInteractionCapture={() => {}} />
                </WorkspaceEditorTabsContext.Provider>
              </WorkspaceSelectionContext.Provider>
            </WorkspaceVoiceContext.Provider>
          </WorkspaceCommandsContext.Provider>
        </WorkspaceLayoutContext.Provider>
      </WorkspaceEnvContext.Provider>,
  )
}

function renderedPanels(): string[] {
  return Array.from(document.querySelectorAll('[data-panel-host]'))
    .map((el) => el.getAttribute('data-panel-host') ?? '')
}

describe('MobilePanelProjection projects every dock from the registry metadata', () => {
  it.each<[MobileDock]>([['browse'], ['editor'], ['tasks'], ['terminal']])(
    'dock %s renders exactly mobileDockPanels(dock), in order',
    (dock) => {
      renderDock(dock)
      expect(renderedPanels()).toEqual(REMAP[dock])
    },
  )
})

// Mobile projects the active editor/terminal instance across the tree. Desktop can
// park a group in the right sidebar, but a mobile pane still needs to show the
// instance the command just activated.
describe('MobilePanelProjection active instance routing', () => {
  it('shows a right-sidebar terminal when it is the active terminal', () => {
    const SIDEBAR_TERM = 'term:side'
    const desktop = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } },
        { basis: 280, node: { kind: 'tabs', id: 'group:term', tabs: [{ instanceId: SIDEBAR_TERM, kind: 'terminal' }], activeTab: SIDEBAR_TERM } },
      ],
    }
    const panelLayout = { ...defaultWorkspacePanelLayout(), desktop, mobile: { activeDock: 'terminal' } }
    // The terminal dock projects the real terminal panel (the generic remap maps it
    // elsewhere); the sidebar group is the only terminal anywhere in the tree.
    mobileDockPanelsMock.mockImplementation((dock: MobileDock) => (dock === 'terminal' ? ['terminal'] : REMAP[dock]))
    renderDock('terminal', {
      panelLayout,
      selection: {
        activeGroupId: 'group:term',
        activeTerminalId: SIDEBAR_TERM,
        activeEditorTab: undefined,
        editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
      },
    })
    const term = document.querySelector('[data-panel-host="terminal"]')
    expect(term).not.toBeNull()
    expect(term?.getAttribute('data-panel-instance')).toBe(SIDEBAR_TERM)
  })

  it('shows a right-sidebar editor when it is the active editor', () => {
    const SIDEBAR_EDITOR = 'editor:side'
    const desktop = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } },
        {
          basis: 280,
          node: {
            kind: 'tabs',
            id: 'group:editor',
            tabs: [{ instanceId: SIDEBAR_EDITOR, kind: 'editor', tabId: 'src/side.ts' }],
            activeTab: SIDEBAR_EDITOR,
          },
        },
      ],
    }
    const panelLayout = { ...defaultWorkspacePanelLayout(), desktop, mobile: { activeDock: 'editor' } }
    mobileDockPanelsMock.mockImplementation((dock: MobileDock) => (dock === 'editor' ? ['editor'] : REMAP[dock]))
    renderDock('editor', {
      panelLayout,
      selection: {
        activeGroupId: 'group:editor',
        activeEditorId: SIDEBAR_EDITOR,
        activeTerminalId: null,
        activeEditorTab: { instanceId: SIDEBAR_EDITOR, kind: 'editor', tabId: 'src/side.ts' },
        editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
      },
    })
    const editor = document.querySelector('[data-panel-host="editor"]')
    expect(editor).not.toBeNull()
    expect(editor?.getAttribute('data-panel-instance')).toBe(SIDEBAR_EDITOR)
  })

  it('uses an app context menu for mobile editor tab titles and suppresses iOS callouts', () => {
    const saveFile = vi.fn()
    const acceptDisk = vi.fn()
    const closePane = vi.fn()
    const EDITOR = 'editor:mobile'
    const desktop = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        {
          grow: true,
          node: {
            kind: 'tabs',
            id: 'group:1',
            tabs: [{ instanceId: EDITOR, kind: 'editor', tabId: 'src/mobile.ts' }],
            activeTab: EDITOR,
          },
        },
      ],
    }
    const panelLayout = { ...defaultWorkspacePanelLayout(), desktop, mobile: { activeDock: 'editor' } }
    mobileDockPanelsMock.mockImplementation((dock: MobileDock) => (dock === 'editor' ? ['editor'] : REMAP[dock]))
    renderDock('editor', {
      panelLayout,
      commands: { saveFile, acceptDisk, closePane } as Partial<WorkspaceCommands>,
      files: {
        'src/mobile.ts': {
          serverContent: 'server',
          draft: 'draft',
          baseRevision: 1,
          viewportLine: 1,
          status: 'dirty',
          editedAt: 1,
        } as FileState,
      },
      editorTabs: { dirtyTabs: new Set<string>(['src/mobile.ts']), conflictTabs: new Set<string>() },
      selection: {
        activeGroupId: 'group:1',
        activeEditorId: EDITOR,
        activeTerminalId: null,
        activeEditorTab: { instanceId: EDITOR, kind: 'editor', tabId: 'src/mobile.ts' },
      },
    })

    const tab = screen.getByTestId('mobile-editor-tab')
    expect(tab.getAttribute('data-yaco-native-context-menu')).toBe('disabled')
    const event = createEvent.contextMenu(tab, { clientX: 20, clientY: 30 })
    fireEvent(tab, event)
    expect(event.defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }))
    expect(saveFile).toHaveBeenCalledWith('src/mobile.ts', 'draft')

    fireEvent.contextMenu(tab)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Without Saving' }))
    expect(acceptDisk).toHaveBeenCalledWith('src/mobile.ts')
    expect(closePane).toHaveBeenCalledWith(EDITOR)
  })

  it('keeps mobile editor tabs scrollable with actions fixed in the same row', () => {
    const setAutocomplete = vi.fn()
    const EDITOR = 'editor:mobile'
    const desktop = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        {
          grow: true,
          node: {
            kind: 'tabs',
            id: 'group:1',
            tabs: [
              { instanceId: EDITOR, kind: 'editor', tabId: 'doc/PROGRESS.md' },
              { instanceId: 'editor:2', kind: 'editor', tabId: 'doc/main/app/ui/mobile.md' },
              { instanceId: 'editor:3', kind: 'editor', tabId: 'plan/all/20260612_panel-dnd/implementation_summary.md' },
            ],
            activeTab: EDITOR,
          },
        },
      ],
    }
    const panelLayout = { ...defaultWorkspacePanelLayout(), desktop, mobile: { activeDock: 'editor' } }
    mobileDockPanelsMock.mockImplementation((dock: MobileDock) => (dock === 'editor' ? ['editor'] : REMAP[dock]))
    renderDock('editor', {
      panelLayout,
      layout: { autocompleteEnabled: false },
      commands: { setAutocomplete } as Partial<WorkspaceCommands>,
      selection: {
        activeGroupId: 'group:1',
        activeEditorId: EDITOR,
        activeTerminalId: null,
        activeEditorTab: { instanceId: EDITOR, kind: 'editor', tabId: 'doc/PROGRESS.md' },
        editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
      },
      voice: {
        ...DEFAULT_WORKSPACE_VOICE,
        editor: { eligible: true, capability: { status: 'ready', maxUploadBytes: 1 }, state: 'idle', onRecord: vi.fn(), onStop: vi.fn(), onOpen: vi.fn() },
      },
    })

    const tabsRow = screen.getByTestId('mobile-editor-tabs')
    const tabList = screen.getByTestId('mobile-editor-tab-list')
    const actions = screen.getByTestId('mobile-editor-actions')
    expect(tabsRow.className).toContain('items-center')
    expect(tabList.className).toContain('overflow-x-auto')
    expect(tabList.className).toContain('min-w-0')
    expect(actions.className).toContain('shrink-0')
    expect(actions.className).toContain('z-10')
    expect(screen.getAllByTestId('mobile-editor-tab')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /Start voice recording/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Suggestions/ }))
    expect(setAutocomplete).toHaveBeenCalledWith(true)
  })

  it('renders diff tabs with an explicit FileDiff icon in the mobile editor strip', () => {
    const desktop = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        {
          grow: true,
          node: {
            kind: 'tabs',
            id: 'group:1',
            tabs: [{ instanceId: 'editor:1', kind: 'editor', tabId: 'diff:src/foo.ts' }],
            activeTab: 'editor:1',
          },
        },
      ],
    }
    const panelLayout = { ...defaultWorkspacePanelLayout(), desktop, mobile: { activeDock: 'editor' } }
    mobileDockPanelsMock.mockImplementation((dock: MobileDock) => (dock === 'editor' ? ['editor'] : REMAP[dock]))

    renderDock('editor', {
      panelLayout,
      selection: {
        activeEditorId: 'editor:1',
        activeGroupId: 'group:1',
        editor: { files: {}, dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
      },
    })

    expect(screen.getByText('foo.ts')).toBeTruthy()
    expect(document.querySelector('.lucide-file-diff')).toBeTruthy()
  })
})
