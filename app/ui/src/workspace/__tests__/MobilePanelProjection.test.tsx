// @vitest-environment jsdom
//
// Non-vacuous link between the mobile dock metadata and what the projection
// renders: every dock's panes are derived from `mobileDockPanels(dock)`, so this
// test REMAPS that helper and asserts the projected `PanelHost`s follow — for
// editor/tasks/terminal too, not just browse. A projection that re-hardcoded any
// dock's owner would render the wrong markers and fail here. Pairs with the pure
// `mobileDocks.test.ts` (real metadata → membership/order); together they pin the
// full chain metadata → helper → render.
import { cleanup, render } from '@testing-library/react'
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
  type WorkspaceEnv, type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceSelection, type PanelId,
} from '../context'

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

function renderDock(dock: MobileDock, opts: { panelLayout?: unknown; selection?: unknown } = {}): void {
  const env = {
    viewport: { isMobile: true, isLandscape: false, isTouch: true },
    notificationBell: null,
  } as unknown as WorkspaceEnv
  const layoutValue = {
    panelLayout: opts.panelLayout ?? { ...defaultWorkspacePanelLayout(), mobile: { activeDock: dock } },
    mobilePane: 'files',
    layout: {},
  } as unknown as WorkspaceLayoutContextValue
  const commands = {
    actions: { setMobilePane: vi.fn() },
    collapsePanel: vi.fn(),
    setFocusTarget: vi.fn(),
  } as unknown as WorkspaceCommands
  const selection = (opts.selection ?? {
    activeEditorId: 'editor',
    activeTerminalId: 'terminal',
    editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
  }) as unknown as WorkspaceSelection
  const rootRef = { current: null } as RefObject<HTMLDivElement | null>
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <MobilePanelProjection rootRef={rootRef} searchOverlay={null} onInteractionCapture={() => {}} />
          </WorkspaceSelectionContext.Provider>
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
})
