// @vitest-environment jsdom
//
// FilesPanel isolation test: render the panel through the real `PanelFrame`
// inside a mock workspace provider and assert the same DOM/behavior as the
// current inline Files section in `WorkspaceScreen`/`WorkspaceLayout`:
//   - tree mode → `FileExplorer` body + the explorer toolbar in the framed header
//   - search mode → lazy text-search body + the search toolbar, title "Search"
//   - toolbar actions route through commands (search swap, quick open) and through
//     the panel-local seam to the body (refresh re-fetches the tree)
//   - the file-reveal controller registers without clobbering `onSessionChange`
//     and drains a buffered reveal intent on mount
//
// The mock provider + helpers are inlined and FilesPanel-prefixed so the 7 panel
// workers sharing panels/__tests__/ never collide on merge.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelFrame } from '../../PanelFrame'
import { resolvePanelTitle } from '../../panelMeta'
import { defaultWorkspacePanelLayout } from '../../panelLayoutModel'
import { filesPanelDef, resetWorktreePickerForTests } from '../FilesPanel'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceControllersContext,
} from '../../context'
import type {
  WorkspaceEnv, WorkspaceData, WorkspaceSelection, WorkspaceLayoutContextValue,
  WorkspaceCommands, WorkspaceControllerRegistry, WorkspaceControllers, FileRevealIntent,
} from '../../context'
import type { WorktreeInfo } from '../../../hooks/useProjectWorktrees'

// Text search is lazy in the panel; stub it so search mode renders a sync marker
// instead of pulling the ripgrep stream UI and its fetches.
vi.mock('../../WorkspaceTextSearch', () => ({
  WorkspaceTextSearch: () => <div>text-search-body</div>,
}))

// --- jsdom shims for the real FileExplorer / useFileTree / useSSE stack ---
class FilesPanelFakeEventSource {
  static readonly CLOSED = 2
  readonly url: string
  readyState = 0
  constructor(url: string) { this.url = url }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.readyState = FilesPanelFakeEventSource.CLOSED }
}

class FilesPanelFakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let filesPanelFetch: ReturnType<typeof vi.fn>

const isRootFilesUrl = (url: string) => url.includes('/files/demo') && !url.includes('/children')

beforeEach(() => {
  filesPanelFetch = vi.fn(async () => (
    { ok: true, status: 200, json: async () => [] } as unknown as Response
  ))
  vi.stubGlobal('fetch', filesPanelFetch)
  vi.stubGlobal('EventSource', FilesPanelFakeEventSource)
  vi.stubGlobal('ResizeObserver', FilesPanelFakeResizeObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
  // Run reveal's requestAnimationFrame callback synchronously for determinism.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  // The worktree-picker open store is module-scoped (it bridges the header/body
  // split), so reset it to closed before each test.
  resetWorktreePickerForTests()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

type RenderOpts = {
  showTextSearch?: boolean
  revealIntent?: FileRevealIntent | null
  worktrees?: WorktreeInfo[]
  activeWorktree?: string | null
}

function renderFilesPanel(opts: RenderOpts = {}) {
  const showTextSearch = opts.showTextSearch ?? false
  const worktrees = opts.worktrees ?? []
  const activeWorktree = opts.activeWorktree ?? null
  const selectWorktree = vi.fn()

  const env = {
    project: { name: 'demo', path: '/demo', worktree: activeWorktree, effectivePath: activeWorktree ?? '/demo' },
    viewport: { isMobile: false, isLandscape: false, isTouch: false },
    worktrees,
    activeWorktree,
    selectWorktree,
  } as unknown as WorkspaceEnv

  const data = {
    git: { changes: [], stale: false, loading: false, error: null, refresh: vi.fn() },
    sessions: {},
    sessionsLoaded: true,
  } as unknown as WorkspaceData

  const selection = {
    selectedFilePath: null, activeGroupId: 'group:1', activeEditorTabId: null, activeEditorPath: null,
  } as unknown as WorkspaceSelection

  const layout = {
    layout: { showTextSearch, showSidebar: true, showExplorer: true },
    mobilePane: 'files',
    panelLayout: defaultWorkspacePanelLayout(),
  } as unknown as WorkspaceLayoutContextValue

  const setFilesMode = vi.fn()
  const showQuickOpen = vi.fn()
  const updateLayout = vi.fn()
  const commands = {
    setFilesMode,
    showQuickOpen,
    setFocusTarget: vi.fn(),
    setExplorerFocusedPath: vi.fn(),
    retargetPaths: vi.fn(),
    deletePath: vi.fn(),
    setSelectedFilePath: vi.fn(),
    actions: {
      updateLayout,
      setJumpRequest: vi.fn(),
      openFileTab: vi.fn(),
      openPreviewTab: vi.fn(),
      setMobilePane: vi.fn(),
      setActiveTab: vi.fn(),
      openDiffTab: vi.fn(),
      openPreviewDiffTab: vi.fn(),
    },
  } as unknown as WorkspaceCommands

  const onSessionChange = vi.fn()
  const controllers: { current: WorkspaceControllers } = {
    current: { revealParents: vi.fn(async () => {}), drainReveal: vi.fn(), onSessionChange },
  }
  const initialControllers = { ...controllers.current }
  const revealBuffer: { current: FileRevealIntent | null } = { current: opts.revealIntent ?? null }
  const registry: WorkspaceControllerRegistry = { controllers, revealBuffer }

  const Body = filesPanelDef.Component
  const view = render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceControllersContext.Provider value={registry}>
          <WorkspaceCommandsContext.Provider value={commands}>
            <WorkspaceLayoutContext.Provider value={layout}>
              <WorkspaceSelectionContext.Provider value={selection}>
                <PanelFrame
                  chrome={filesPanelDef.chrome}
                  title={resolvePanelTitle(filesPanelDef.title, env)}
                  useHeader={filesPanelDef.useHeader}
                >
                  <Body />
                </PanelFrame>
              </WorkspaceSelectionContext.Provider>
            </WorkspaceLayoutContext.Provider>
          </WorkspaceCommandsContext.Provider>
        </WorkspaceControllersContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )

  return { ...view, setFilesMode, showQuickOpen, updateLayout, controllers, initialControllers, onSessionChange, selectWorktree }
}

describe('FilesPanel — chrome is framed (project-name title + explorer toolbar)', () => {
  it('is registered as a framed browse panel', () => {
    expect(filesPanelDef.id).toBe('files')
    expect(filesPanelDef.chrome).toBe('framed')
    expect(filesPanelDef.mobileDock).toBe('browse')
    expect(typeof filesPanelDef.useHeader).toBe('function')
  })
})

describe('FilesPanel — tree mode (matches the current inline explorer body)', () => {
  it('renders the FileExplorer body and the explorer toolbar in the framed header', async () => {
    const { container } = renderFilesPanel({ showTextSearch: false })

    // Framed header: dynamic title is the project name + the five tree actions.
    expect(await screen.findByText('demo')).toBeTruthy()
    expect(screen.getByLabelText('Search in files')).toBeTruthy()
    expect(screen.getByLabelText('Collapse All')).toBeTruthy()
    expect(screen.getByLabelText('New File')).toBeTruthy()
    expect(screen.getByLabelText('New Folder')).toBeTruthy()
    expect(screen.getByTitle('Refresh explorer')).toBeTruthy()

    // Body is the file explorer (skeleton with zero-height container in jsdom),
    // not the text-search surface.
    expect(container.querySelector('.skeleton-row')).toBeTruthy()
    expect(screen.queryByText('text-search-body')).toBeNull()

    // The explorer's flex-fill root sits inside a flex-column body wrapper, so it
    // sizes/measures/scrolls like the old section body — guards the regression
    // where rendering bare into PanelFrame's non-flex body zeroes its height.
    const explorerRoot = container.querySelector('.flex-1.min-h-0.min-w-0')
    expect(explorerRoot).toBeTruthy()
    const wrapper = explorerRoot?.parentElement
    expect(wrapper?.className).toContain('flex')
    expect(wrapper?.className).toContain('flex-col')
    expect(wrapper?.className).toContain('min-h-0')
  })

  it('clicking "Search in files" swaps to search mode through the command surface', async () => {
    const { setFilesMode } = renderFilesPanel({ showTextSearch: false })
    fireEvent.click(await screen.findByLabelText('Search in files'))
    expect(setFilesMode).toHaveBeenCalledWith('search')
  })

  it('clicking "Refresh explorer" drives the body file-tree refresh (header → seam → body)', async () => {
    renderFilesPanel({ showTextSearch: false })
    await screen.findByLabelText('Search in files')
    const rootCallsBefore = filesPanelFetch.mock.calls.filter(c => isRootFilesUrl(String(c[0]))).length

    fireEvent.click(screen.getByTitle('Refresh explorer'))

    await waitFor(() => {
      const after = filesPanelFetch.mock.calls.filter(c => isRootFilesUrl(String(c[0]))).length
      expect(after).toBe(rootCallsBefore + 1)
    })
  })
})

describe('FilesPanel — search mode (matches the current inline text-search body)', () => {
  it('renders the lazy text search body and the search toolbar, titled "Search"', async () => {
    renderFilesPanel({ showTextSearch: true })

    expect(await screen.findByText('text-search-body')).toBeTruthy()
    expect(screen.getByText('Search')).toBeTruthy()
    expect(screen.getByLabelText('Quick file search')).toBeTruthy()
    expect(screen.getByLabelText('Full text search')).toBeTruthy()
    expect(screen.getByLabelText('Back to explorer')).toBeTruthy()
    // Tree-only actions are gone in search mode.
    expect(screen.queryByLabelText('New File')).toBeNull()
  })

  it('quick-open and back-to-explorer route through the command surface', async () => {
    const { showQuickOpen, setFilesMode } = renderFilesPanel({ showTextSearch: true })
    await screen.findByText('text-search-body')

    fireEvent.click(screen.getByLabelText('Quick file search'))
    expect(showQuickOpen).toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Back to explorer'))
    expect(setFilesMode).toHaveBeenCalledWith('tree')
  })
})

describe('FilesPanel — file-reveal controller', () => {
  it('registers reveal callbacks without clobbering SessionsPanel onSessionChange', async () => {
    const { controllers, initialControllers, onSessionChange } = renderFilesPanel({ showTextSearch: false })

    await waitFor(() => {
      expect(controllers.current.drainReveal).not.toBe(initialControllers.drainReveal)
    })
    expect(controllers.current.revealParents).not.toBe(initialControllers.revealParents)
    // onSessionChange is owned by SessionsPanel — the patch must leave it intact.
    expect(controllers.current.onSessionChange).toBe(onSessionChange)
  })

  it('clears its reveal callbacks on unmount without touching onSessionChange', async () => {
    const { unmount, controllers, initialControllers, onSessionChange } =
      renderFilesPanel({ showTextSearch: false })

    await waitFor(() => {
      expect(controllers.current.drainReveal).not.toBe(initialControllers.drainReveal)
    })
    const registeredDrain = controllers.current.drainReveal
    const registeredReveal = controllers.current.revealParents

    unmount()

    // Stale closures are cleared (ownership-checked) so the provider stops calling
    // a hidden/unmounted FilesPanel's reveal handlers.
    expect(controllers.current.drainReveal).not.toBe(registeredDrain)
    expect(controllers.current.revealParents).not.toBe(registeredReveal)
    expect(controllers.current.onSessionChange).toBe(onSessionChange)
  })

  it('drains a buffered file reveal intent on mount (reveals the Files surface)', async () => {
    const { updateLayout } = renderFilesPanel({
      showTextSearch: false,
      revealIntent: { kind: 'file', path: 'src/x.ts', key: 7 },
    })

    await waitFor(() => {
      expect(updateLayout).toHaveBeenCalledWith({ showSidebar: true, showExplorer: true })
    })
  })
})

describe('FilesPanel — worktree picker (header toggle reveals the in-body list)', () => {
  const WORKTREES: WorktreeInfo[] = [
    { id: '/demo', name: 'demo (primary)', branch: 'main', head: 'aaa1111', isPrimary: true, dirty: false, ahead: 0, behind: 0 },
    { id: '/abs/wt/feature-x', name: 'feature-x', branch: 'task/feature-x', head: 'bbb2222', isPrimary: false, dirty: true, ahead: 2, behind: 1 },
  ]

  const worktreeList = () => screen.getByRole('listbox', { name: 'Worktrees' })

  it('renders no toggle when the project has no worktrees', async () => {
    renderFilesPanel({ worktrees: [] })
    await screen.findByLabelText('Search in files')
    expect(screen.queryByLabelText('Select worktree')).toBeNull()
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
  })

  it('is HIDDEN by default: the header shows a GitBranch toggle, the list is absent', async () => {
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    expect(await screen.findByLabelText('Select worktree')).toBeTruthy()
    // The in-body list does not render until the toggle is clicked.
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
  })

  it('clicking the header toggle reveals the inline list INSIDE the panel body', async () => {
    const { container } = renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    fireEvent.click(await screen.findByLabelText('Select worktree'))

    const list = worktreeList()
    // The body is the flex column that also holds the explorer's flex-fill root; the
    // revealed list is a sibling above it. The header toolbar is a SEPARATE subtree.
    const explorerRoot = container.querySelector('.flex-1.min-h-0.min-w-0')
    const body = explorerRoot?.parentElement
    expect(body?.className).toContain('flex-col')
    expect(body?.contains(list)).toBe(true)
    expect(body?.contains(screen.getByLabelText('Search in files'))).toBe(false)
  })

  it('the worktree toggle is tree-mode only (absent from the search-mode header)', async () => {
    // The toggle lives in the tree-mode actions row, so search mode has no worktree
    // affordance (the selected worktree still scopes search via the `worktree` param).
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null, showTextSearch: true })
    expect(await screen.findByText('text-search-body')).toBeTruthy()
    expect(screen.queryByLabelText('Select worktree')).toBeNull()
    expect(screen.queryByLabelText('Hide worktree picker')).toBeNull()
  })

  it("the toggle title shows the current branch (primary when nothing is selected)", async () => {
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    const toggle = await screen.findByLabelText('Select worktree')
    expect(toggle.getAttribute('title')).toContain('main')
  })

  it('the title falls back to the primary branch when the selected id is gone (not the first row)', async () => {
    // Linked worktree ordered BEFORE primary; the selection points at a worktree that
    // is no longer registered. The toggle title must show primary, not worktrees[0].
    const linkedFirst: WorktreeInfo[] = [WORKTREES[1], WORKTREES[0]]
    renderFilesPanel({ worktrees: linkedFirst, activeWorktree: '/abs/wt/gone' })
    const toggle = await screen.findByLabelText('Select worktree')
    expect(toggle.getAttribute('title')).toContain('main')
  })

  it('opening the list shows every worktree by branch + a primary chip', async () => {
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    fireEvent.click(await screen.findByLabelText('Select worktree'))

    const list = worktreeList()
    expect(within(list).getByText('main')).toBeTruthy()
    expect(within(list).getByText('task/feature-x')).toBeTruthy()
    expect(within(list).getByText('primary')).toBeTruthy()
  })

  it('clicking a linked worktree row binds it by id AND closes the picker', async () => {
    const { selectWorktree } = renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    fireEvent.click(await screen.findByLabelText('Select worktree'))

    const row = worktreeList().querySelector('[data-worktree-id="/abs/wt/feature-x"]') as HTMLElement
    expect(row).toBeTruthy()
    fireEvent.click(row)
    expect(selectWorktree).toHaveBeenCalledWith('/abs/wt/feature-x')
    // Selecting closes the picker — the list is gone and the toggle resets to closed.
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
    expect(screen.getByLabelText('Select worktree')).toBeTruthy()
  })

  it('clicking the primary row binds null (returns to the main working tree) AND closes', async () => {
    const { selectWorktree } = renderFilesPanel({ worktrees: WORKTREES, activeWorktree: '/abs/wt/feature-x' })
    // While a linked worktree is selected, the toggle title reflects its branch.
    const toggle = await screen.findByLabelText('Select worktree')
    expect(toggle.getAttribute('title')).toContain('task/feature-x')

    fireEvent.click(toggle)
    const primaryRow = worktreeList().querySelector('[data-worktree-id="/demo"]') as HTMLElement
    fireEvent.click(primaryRow)
    expect(selectWorktree).toHaveBeenCalledWith(null)
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
  })

  it('the header X AND the relabeled toggle each close the open picker', async () => {
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    fireEvent.click(await screen.findByLabelText('Select worktree'))
    expect(worktreeList()).toBeTruthy()

    // When open, the toggle relabels and an X exits — mirroring Compare ref exactly.
    expect(screen.getByLabelText('Hide worktree picker')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close worktree picker'))
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()

    // Reopen, then close via the relabeled toggle itself (the other close path).
    fireEvent.click(screen.getByLabelText('Select worktree'))
    expect(worktreeList()).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Hide worktree picker'))
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
    expect(screen.getByLabelText('Select worktree')).toBeTruthy()
  })

  it('entering search mode closes the picker so the tree return is clean', async () => {
    // Open in tree mode (module store now true)...
    const first = renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    fireEvent.click(await screen.findByLabelText('Select worktree'))
    expect(worktreeList()).toBeTruthy()
    first.unmount()

    // ...visiting search mode runs the close effect on mount...
    const second = renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null, showTextSearch: true })
    await screen.findByText('text-search-body')
    second.unmount()

    // ...so returning to the tree shows the picker closed (open state did not survive).
    renderFilesPanel({ worktrees: WORKTREES, activeWorktree: null })
    await screen.findByLabelText('Select worktree')
    expect(screen.queryByRole('listbox', { name: 'Worktrees' })).toBeNull()
  })
})
