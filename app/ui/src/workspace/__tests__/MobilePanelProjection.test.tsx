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
// Mock PanelHost to a marker so the test reads which panel ids project, without
// mounting the real (provider-heavy) panel components.
vi.mock('../PanelHost', () => ({
  PanelHost: ({ id }: { id: unknown }) => <div data-panel-host={String(id)} />,
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

function renderDock(dock: MobileDock): void {
  const env = {
    viewport: { isMobile: true, isLandscape: false, isTouch: true },
    notificationBell: null,
  } as unknown as WorkspaceEnv
  const layoutValue = {
    panelLayout: { ...defaultWorkspacePanelLayout(), mobile: { activeDock: dock } },
    mobilePane: 'files',
    layout: {},
  } as unknown as WorkspaceLayoutContextValue
  const commands = {
    actions: { setMobilePane: vi.fn() },
    collapsePanel: vi.fn(),
    setFocusTarget: vi.fn(),
  } as unknown as WorkspaceCommands
  const selection = {
    activeEditorId: 'editor',
    activeTerminalId: 'terminal',
  } as unknown as WorkspaceSelection
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
