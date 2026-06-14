// @vitest-environment jsdom
//
// Isolation characterization for ChangesPanel (T3f). Renders the panel the same
// way PanelHost will — its body inside a PanelFrame driven by the panel's
// `useHeader` hook — under a hand-built mock provider, and asserts the same
// DOM/behavior as the current inline Changes section (WorkspaceScreen's
// `changesBody` + the `changes*` header props). The panel is a pure consumer:
// git status comes from the data context, diffs open through commands.
//
// Each test uses a distinct project name so the panel-local compare store (keyed
// by project/worktree) starts at its default, keeping cases independent.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelFrame } from '../../PanelFrame'
import { resolvePanelTitle } from '../../panelMeta'
import { changesPanelDef } from '../ChangesPanel'
import {
  WorkspaceEnvContext, WorkspaceDataContext,
  WorkspaceSelectionContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceData,
  type WorkspaceSelection, type WorkspaceCommands,
} from '../../context'
import type { GitChange } from '../../../types'

// Only the compare fetch is stubbed; the rest of useApi (e.g. RefSearchDropdown's
// fetchGitRefs, which never fires while the dropdown is closed) stays real.
vi.mock('../../../hooks/useApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useApi')>()
  return { ...actual, fetchGitCompare: vi.fn() }
})
import { fetchGitCompare } from '../../../hooks/useApi'
const mockedFetchGitCompare = vi.mocked(fetchGitCompare)

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

type ChangesPanelOpts = {
  projectName: string
  activeTab?: string | null
  git?: { changes?: GitChange[]; stale?: boolean; stats?: { added: number; deleted: number } }
}

// Build the panel tree (a stable structure across calls, so re-rendering with a
// different projectName updates env in place — a key change, not a remount).
function buildChangesTree(opts: ChangesPanelOpts) {
  const env = {
    project: { name: opts.projectName, path: `/${opts.projectName}`, worktree: null, effectivePath: `/${opts.projectName}` },
    viewport: { isMobile: false, isLandscape: false, isTouch: false },
  } as unknown as WorkspaceEnv

  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const data = {
    git: {
      changes: opts.git?.changes ?? [],
      stale: opts.git?.stale ?? false,
      stats: opts.git?.stats,
      loading: false,
      error: null,
      refresh,
    },
  } as unknown as WorkspaceData

  const selection = { activeTab: opts.activeTab ?? null } as unknown as WorkspaceSelection

  const commands = {
    openDiff: vi.fn(),
    openDiffTabId: vi.fn(),
    expandFolderInFiles: vi.fn(),
    revealPathInFiles: vi.fn(),
  } as unknown as WorkspaceCommands

  const Body = changesPanelDef.Component
  const element = (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <PanelFrame
              chrome={changesPanelDef.chrome}
              title={resolvePanelTitle(changesPanelDef.title, env)}
              useHeader={changesPanelDef.useHeader}
            >
              <Body />
            </PanelFrame>
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  return { element, commands, refresh }
}

function renderChangesPanel(opts: ChangesPanelOpts) {
  const { element, commands, refresh } = buildChangesTree(opts)
  return { ...render(element), commands, refresh }
}

describe('changesPanelDef — definition', () => {
  it('is the framed Changes panel that docks under browse', () => {
    expect(changesPanelDef.id).toBe('changes')
    expect(changesPanelDef.chrome).toBe('framed')
    expect(changesPanelDef.mobileDock).toBe('browse')
    expect(changesPanelDef.useHeader).toBeTypeOf('function')
  })
})

describe('ChangesPanel — working-tree mode (DOM parity with the inline changesBody)', () => {
  it('renders the empty state and a plain "Changes" header when the tree is clean', () => {
    renderChangesPanel({ projectName: 'empty' })
    expect(screen.getByText('Changes')).toBeTruthy()
    expect(screen.getByText('No changes')).toBeTruthy()
    expect(screen.getByText('Working tree is clean')).toBeTruthy()
  })

  it('renders a row per change with the stale title, count badge, and +/- stats', () => {
    renderChangesPanel({
      projectName: 'list',
      git: {
        changes: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }],
        stale: true,
        stats: { added: 5, deleted: 2 },
      },
    })
    expect(screen.getByText('Changes (stale)')).toBeTruthy() // useHeader overrides the static title
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()  // badge = change count
    expect(screen.getByText('+5')).toBeTruthy() // stats
    expect(screen.getByText('-2')).toBeTruthy()
    expect(screen.queryByText('No changes')).toBeNull()
  })

  it('opens a file change as a preview diff and a directory change as a folder reveal', () => {
    const { commands } = renderChangesPanel({
      projectName: 'click',
      git: { changes: [{ path: 'src/a.ts', status: 'M' }, { path: 'root/sub/', status: 'A' }] },
    })
    // Row body → openDiff(path); diff opens as a preview (openDiff default).
    fireEvent.click(screen.getByText('a.ts'))
    expect(commands.openDiff).toHaveBeenCalledWith('src/a.ts')
    // The path segment of a file reveals the file in Files.
    fireEvent.click(screen.getByText('src'))
    expect(commands.revealPathInFiles).toHaveBeenCalledWith('src/a.ts')
    // A directory change row body → expandFolderInFiles(path-without-trailing-slash).
    fireEvent.click(screen.getByText('sub'))
    expect(commands.expandFolderInFiles).toHaveBeenCalledWith('root/sub')
    // Its parent-path segment also expands the directory, not file-reveal.
    fireEvent.click(screen.getByText('root'))
    expect(commands.expandFolderInFiles).toHaveBeenCalledWith('root/sub')
    expect(commands.openDiff).toHaveBeenCalledTimes(1)
  })

  it('offers a reveal affordance for root-level changed files', () => {
    const { commands } = renderChangesPanel({
      projectName: 'root-file',
      git: { changes: [{ path: 'README.md', status: 'M' }] },
    })

    fireEvent.click(screen.getByTitle('Reveal README.md'))

    expect(commands.revealPathInFiles).toHaveBeenCalledWith('README.md')
  })

  it('opens a file change as a pinned diff on row double-click', () => {
    const { commands } = renderChangesPanel({
      projectName: 'dblclick',
      git: { changes: [{ path: 'src/a.ts', status: 'M' }] },
    })

    fireEvent.doubleClick(screen.getByText('a.ts'))

    expect(commands.openDiff).toHaveBeenCalledWith('src/a.ts', { preview: false })
  })
})

describe('ChangesPanel — compare mode (self-contained refs + fetch + diff-by-tab-id)', () => {
  it('toggles compare on, shows the ref picker, fetches the diff, and opens files by tab id', async () => {
    mockedFetchGitCompare.mockResolvedValue({ files: [{ path: 'src/x.ts', status: 'M' }], stats: { added: 3, deleted: 1 } })
    const { commands } = renderChangesPanel({ projectName: 'compare' })

    const toggle = screen.getByRole('button', { name: 'Compare refs' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)

    // Header switches to the Compare title; the ref picker shows base/head; the
    // toggle plus a dedicated X both exit compare.
    expect(screen.getByText('Compare')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('HEAD')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Exit compare mode' })).toHaveLength(2)

    // The compare fetch resolves into a listed file + count badge + stats.
    expect(await screen.findByText('x.ts')).toBeTruthy()
    expect(mockedFetchGitCompare).toHaveBeenCalledWith('compare', 'main', 'HEAD', null)
    expect(screen.getByText('1')).toBeTruthy()  // badge = compare file count
    expect(screen.getByText('+3')).toBeTruthy()
    expect(screen.getByText('-1')).toBeTruthy()

    // Activating a compare row opens its self-describing diff tab id.
    fireEvent.click(screen.getByText('x.ts'))
    expect(commands.openDiffTabId).toHaveBeenCalledWith('diff:src/x.ts?base=main&compare=HEAD')
    expect(commands.openDiff).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('src'))
    expect(commands.revealPathInFiles).toHaveBeenCalledWith('src/x.ts')

    fireEvent.doubleClick(screen.getByText('x.ts'))
    expect(commands.openDiffTabId).toHaveBeenCalledWith('diff:src/x.ts?base=main&compare=HEAD', { preview: false })
  })

  it('shows "No differences" when the refs are identical', async () => {
    mockedFetchGitCompare.mockResolvedValue({ files: [], stats: { added: 0, deleted: 0 } })
    renderChangesPanel({ projectName: 'identical' })

    fireEvent.click(screen.getByRole('button', { name: 'Compare refs' }))
    expect(await screen.findByText('No differences')).toBeTruthy()
    expect(screen.getByText('These refs are identical')).toBeTruthy()
  })

  // H1 regression: the compare store survives the panel staying mounted, so it
  // must reset when the active (project, worktree) key changes — including a
  // round-trip A → B → A that must not resurrect A's stale compare state.
  it('resets compare mode/refs/result when the (project, worktree) key changes', async () => {
    mockedFetchGitCompare.mockResolvedValue({ files: [{ path: 'src/x.ts', status: 'M' }], stats: { added: 3, deleted: 1 } })
    const { rerender } = render(buildChangesTree({ projectName: 'switch-a' }).element)

    // Enter compare on A, then swap the refs so base/head are non-default.
    fireEvent.click(screen.getByRole('button', { name: 'Compare refs' }))
    expect(await screen.findByText('x.ts')).toBeTruthy()
    await waitFor(() => expect(mockedFetchGitCompare).toHaveBeenLastCalledWith('switch-a', 'main', 'HEAD', null))
    fireEvent.click(screen.getByRole('button', { name: 'Swap base and compare' }))
    await waitFor(() => expect(mockedFetchGitCompare).toHaveBeenLastCalledWith('switch-a', 'HEAD', 'main', null))

    // Switch to B: compare is reset (working-tree mode, plain title, no diff).
    rerender(buildChangesTree({ projectName: 'switch-b' }).element)
    expect(screen.queryByText('Compare')).toBeNull()
    expect(screen.getByText('Changes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Compare refs' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText('x.ts')).toBeNull()

    // Round-trip back to A: still reset — the stale slot was discarded, not kept.
    rerender(buildChangesTree({ projectName: 'switch-a' }).element)
    expect(screen.queryByText('Compare')).toBeNull()
    expect(screen.getByRole('button', { name: 'Compare refs' }).getAttribute('aria-pressed')).toBe('false')

    // Re-entering compare on A starts from default refs (main/HEAD), proving
    // base/head/result were reset rather than restored to the swapped pair.
    mockedFetchGitCompare.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Compare refs' }))
    await waitFor(() => expect(mockedFetchGitCompare).toHaveBeenLastCalledWith('switch-a', 'main', 'HEAD', null))
  })
})
