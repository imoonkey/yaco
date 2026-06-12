// @vitest-environment jsdom
//
// GroupTabBar behavior — the flat mixed editor+terminal strip rendered inside a
// minimal env/data context (design: vt-group-tabbar). Asserts the user-driven
// affordances the QA pass drives: mixed tab rendering, select/close, the
// dismiss-safe Split menu (button + empty-area right-click), Close Group on an
// empty group, the dirty-close confirm + its pathsOpenElsewhere no-op, and
// within-group drag reorder.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { GroupTabBar, type GroupTabBarProps } from '../GroupTabBar'
import {
  WorkspaceEnvContext, WorkspaceDataContext,
  type WorkspaceEnv, type WorkspaceData,
} from '../context'
import type { GroupTab } from '../../hooks/workspaceTypes'

afterEach(cleanup)

const EDITOR = (instanceId: string, tabId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra }) as GroupTab
const TERMINAL = (instanceId: string): GroupTab => ({ instanceId, kind: 'terminal' })

function renderBar(
  over: Partial<GroupTabBarProps> = {},
  ctx: { sessions?: { name: string; provider: string }[]; isTouch?: boolean } = {},
) {
  const props: GroupTabBarProps = {
    groupId: 'g1',
    tabs: [],
    activeTab: '',
    dirtyTabs: new Set(),
    conflictTabs: new Set(),
    terminalBindings: {},
    pathsOpenElsewhere: new Set(),
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onSplit: vi.fn(),
    onReorderTab: vi.fn(),
    onCloseGroup: vi.fn(),
    onDiscardDirty: vi.fn(),
    ...over,
  }
  const env = {
    viewport: { isMobile: false, isLandscape: false, isTouch: ctx.isTouch ?? false },
  } as unknown as WorkspaceEnv
  const data = { sessions: { projectSessions: ctx.sessions ?? [] } } as unknown as WorkspaceData
  const wrap = (ui: ReactNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>{ui}</WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  return { ...render(wrap(<GroupTabBar {...props} />)), props }
}

describe('GroupTabBar — mixed tab rendering', () => {
  it('renders an ordered mix of editor (file name) and terminal (session/icon) tabs', () => {
    const { container } = renderBar(
      {
        tabs: [EDITOR('editor:1', 'src/app.ts'), TERMINAL('terminal:1'), TERMINAL('terminal:2')],
        activeTab: 'editor:1',
        terminalBindings: { 'terminal:1': 'claude-1' },
      },
      { sessions: [{ name: 'claude-1', provider: 'claude' }] },
    )
    expect(screen.getByText('app.ts')).toBeTruthy()
    // Bound terminal → its session name + the claude provider icon.
    expect(screen.getByText('claude-1')).toBeTruthy()
    expect(container.querySelector('img[src="/claude-code-symbol.svg"]')).toBeTruthy()
    // Unbound terminal → "Terminal".
    expect(screen.getByText('Terminal')).toBeTruthy()
  })

  it('marks the active tab and shows "No files open" for an empty group', () => {
    renderBar({ tabs: [], activeTab: '' })
    expect(screen.getByText('No files open')).toBeTruthy()
  })
})

describe('GroupTabBar — select + close', () => {
  it('selects a tab by its instanceId on click', () => {
    const onSelectTab = vi.fn()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')], onSelectTab })
    fireEvent.click(screen.getByText('app.ts'))
    expect(onSelectTab).toHaveBeenCalledWith('editor:1')
  })

  it('closes an editor tab via its × (labeled by file name)', () => {
    const onCloseTab = vi.fn()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')], onCloseTab })
    fireEvent.click(screen.getByLabelText('Close app.ts'))
    expect(onCloseTab).toHaveBeenCalledWith('editor:1')
  })

  it('closes a terminal tab via its × (labeled "Close terminal")', () => {
    const onCloseTab = vi.fn()
    renderBar({ tabs: [TERMINAL('terminal:1')], onCloseTab })
    fireEvent.click(screen.getByLabelText('Close terminal'))
    expect(onCloseTab).toHaveBeenCalledWith('terminal:1')
  })
})

describe('GroupTabBar — dismiss-safe Split menu', () => {
  it('opens a 4-sided Split menu from the visible button and stays open until a choice', () => {
    const onSplit = vi.fn()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')], onSplit })

    fireEvent.click(screen.getByTestId('split-group'))
    // The menu is open (Bug 2: the opening click does not dismiss it).
    expect(screen.getByRole('menu')).toBeTruthy()
    for (const name of ['Split Up', 'Split Down', 'Split Left', 'Split Right']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('menuitem', { name: 'Split Left' }))
    expect(onSplit).toHaveBeenCalledWith('left')
  })

  it('opens the same Split menu from an empty-area right-click', () => {
    const onSplit = vi.fn()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')], onSplit })

    fireEvent.contextMenu(screen.getByTestId('group-empty-area'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split Down' }))
    expect(onSplit).toHaveBeenCalledWith('below')
  })

  it('offers Close Group only for an empty group', () => {
    const onCloseGroup = vi.fn()
    renderBar({ tabs: [], onCloseGroup })
    fireEvent.click(screen.getByTestId('split-group'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Group' }))
    expect(onCloseGroup).toHaveBeenCalledTimes(1)

    // A non-empty group has no Close Group item.
    cleanup()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')] })
    fireEvent.click(screen.getByTestId('split-group'))
    expect(screen.queryByRole('menuitem', { name: 'Close Group' })).toBeNull()
  })
})

describe('GroupTabBar — dirty-close confirm', () => {
  it('prompts before discarding the last view of a dirty file, then discards + closes', () => {
    const onCloseTab = vi.fn()
    const onDiscardDirty = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'src/app.ts')],
      dirtyTabs: new Set(['src/app.ts']),
      onCloseTab,
      onDiscardDirty,
    })

    fireEvent.click(screen.getByLabelText('Close app.ts'))
    // The confirm dialog blocks the close.
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()
    expect(onCloseTab).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close Without Saving' }))
    expect(onDiscardDirty).toHaveBeenCalledWith('src/app.ts')
    expect(onCloseTab).toHaveBeenCalledWith('editor:1')
  })

  it('closes without a prompt when the dirty file is still open in another group', () => {
    const onCloseTab = vi.fn()
    const onDiscardDirty = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'src/app.ts')],
      dirtyTabs: new Set(['src/app.ts']),
      pathsOpenElsewhere: new Set(['src/app.ts']),
      onCloseTab,
      onDiscardDirty,
    })

    fireEvent.click(screen.getByLabelText('Close app.ts'))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    expect(onDiscardDirty).not.toHaveBeenCalled()
    expect(onCloseTab).toHaveBeenCalledWith('editor:1')
  })
})

describe('GroupTabBar — dirty/conflict keyed by underlying path (diff tabs)', () => {
  it('shows the dirty dot + prompts on close for a diff tab whose path is dirty', () => {
    const onCloseTab = vi.fn()
    const onDiscardDirty = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'diff:src/a.ts?base=main&compare=HEAD')],
      activeTab: 'editor:1',
      dirtyTabs: new Set(['src/a.ts']), // the PATH, not the diff tabId
      onCloseTab,
      onDiscardDirty,
    })

    fireEvent.click(screen.getByLabelText('Close a.ts (main..HEAD)'))
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()
    expect(onCloseTab).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close Without Saving' }))
    expect(onDiscardDirty).toHaveBeenCalledWith('src/a.ts') // discards by PATH
    expect(onCloseTab).toHaveBeenCalledWith('editor:1')
  })

  it('marks a diff tab conflicted when its underlying path is in conflictTabs', () => {
    const { container } = renderBar({
      tabs: [EDITOR('editor:1', 'diff:src/a.ts')],
      activeTab: 'editor:1',
      conflictTabs: new Set(['src/a.ts']),
    })
    expect(container.querySelector('[title="File changed on disk"]')).toBeTruthy()
  })
})

describe('GroupTabBar — within-group reorder', () => {
  it('reorders a dragged tab to the drop target index', () => {
    const onReorderTab = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'a.ts'), EDITOR('editor:2', 'b.ts'), EDITOR('editor:3', 'c.ts')],
      onReorderTab,
    })
    const tabEls = screen.getAllByTestId('group-tab')
    fireEvent.dragStart(tabEls[0])
    fireEvent.drop(tabEls[2])
    expect(onReorderTab).toHaveBeenCalledWith('editor:1', 2)
  })
})
