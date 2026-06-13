// @vitest-environment jsdom
//
// GroupTabBar behavior — the flat mixed editor+terminal strip rendered inside a
// minimal env/data context (design: vt-group-tabbar). Asserts the user-driven
// affordances the QA pass drives: mixed tab rendering, select/close, the
// dismiss-safe Split menu (button + empty-area right-click), Close Group on an
// empty group, the dirty-close confirm + its pathsOpenElsewhere no-op, and
// within-group drag reorder.
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { GroupTabBar, type GroupTabBarProps } from '../GroupTabBar'
import {
  WorkspaceEnvContext, WorkspaceDataContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceData,
  type WorkspaceLayoutContextValue, type WorkspaceCommands,
} from '../context'
import type { GroupTab } from '../../hooks/workspaceTypes'

// The dragged-pane identity is a module singleton (WorkspaceDragContext) — clear
// it between tests via the window-level dragend fallback so a stale payload never
// leaks across cases.
afterEach(() => { cleanup(); window.dispatchEvent(new Event('dragend')) })

const EDITOR = (instanceId: string, tabId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra }) as GroupTab
const TERMINAL = (instanceId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'terminal', ...extra }) as GroupTab

function renderBar(
  over: Partial<GroupTabBarProps> = {},
  ctx: { sessions?: { name: string; provider: string }[]; isTouch?: boolean } = {},
) {
  const props: GroupTabBarProps = {
    groupId: 'g1',
    region: 'center',
    tabs: [],
    activeTab: '',
    isActiveGroup: true,
    dirtyTabs: new Set(),
    conflictTabs: new Set(),
    terminalBindings: {},
    pathsOpenElsewhere: new Set(),
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onSplit: vi.fn(),
    onMoveTab: vi.fn(),
    onMoveGroup: vi.fn(),
    onCloseGroup: vi.fn(),
    onActivateGroup: vi.fn(),
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

  it('shows a VISIBLE Close Group button on an empty closable group (FIX B)', () => {
    const onCloseGroup = vi.fn()
    renderBar({ tabs: [], canCloseGroup: true, onCloseGroup })
    const btn = screen.getByTestId('close-group')
    fireEvent.click(btn)
    expect(onCloseGroup).toHaveBeenCalledTimes(1)

    // The LAST group (canCloseGroup false) hides the button — it can never be removed.
    cleanup()
    renderBar({ tabs: [], canCloseGroup: false })
    expect(screen.queryByTestId('close-group')).toBeNull()

    // A non-empty group never shows it either.
    cleanup()
    renderBar({ tabs: [EDITOR('editor:1', 'src/app.ts')], canCloseGroup: true })
    expect(screen.queryByTestId('close-group')).toBeNull()
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

describe('GroupTabBar — tab-bar drop (move + reorder via the global pane payload)', () => {
  // A real pane drag carries a DataTransfer tagged with our pane mime; the same
  // transfer object rides both dragStart (source sets the mime) and drop (target
  // gates on it). A bare fake is enough — setData populates `types`.
  const paneTransfer = () => {
    const store: Record<string, string> = {}
    const types: string[] = []
    return {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: (type: string, value: string) => { if (!(type in store)) types.push(type); store[type] = value },
      getData: (type: string) => store[type] ?? '',
    }
  }

  // jsdom gives every element a zero rect; the insertion index is geometry, so stub
  // sequential 100px-wide tab rects (midpoints 50/150/250/…) to drive `tabInsertIndex`.
  const stubTabRects = (els: HTMLElement[], width = 100) => {
    els.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ x: i * width, y: 0, width, height: 28, top: 0, left: i * width, right: (i + 1) * width, bottom: 28, toJSON: () => ({}) })
    })
  }

  it('moves a dragged tab to the pointer-derived insertion index (within-group reorder)', () => {
    const onMoveTab = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'a.ts'), EDITOR('editor:2', 'b.ts'), EDITOR('editor:3', 'c.ts')],
      onMoveTab,
    })
    const tabEls = screen.getAllByTestId('group-tab')
    stubTabRects(tabEls)
    const dataTransfer = paneTransfer()
    fireEvent.dragStart(tabEls[0], { dataTransfer })
    // The source tags the native drag so the move cursor shows + drop targets can
    // tell this apart from a foreign/text-plain list drag.
    expect(dataTransfer.types).toContain('application/yaco-pane')
    expect(dataTransfer.getData('application/yaco-pane')).toBe('tab')
    // clientX past the first two midpoints (50, 150) → visual insertion index 2. The
    // same MOVE_TAB path serves the within-group reorder (from===to) and a cross-group
    // move. Because MOVE_TAB removes the source first, a same-group rightward move
    // targets one slot earlier (2 → 1). jsdom drops drag-event coords, so set clientX.
    const drop = createEvent.drop(tabEls[2], { dataTransfer })
    Object.defineProperty(drop, 'clientX', { value: 200, configurable: true })
    fireEvent(tabEls[2], drop)
    expect(onMoveTab).toHaveBeenCalledWith('g1', 'editor:1', 'g1', 1)
  })

  it('ignores a foreign drag (no pane mime) — the text/plain list reorders stay independent', () => {
    const onMoveTab = vi.fn()
    renderBar({
      tabs: [EDITOR('editor:1', 'a.ts'), EDITOR('editor:2', 'b.ts')],
      onMoveTab,
    })
    const tabEls = screen.getAllByTestId('group-tab')
    const foreign = paneTransfer()
    foreign.setData('text/plain', 'some-session') // a ProjectList/SessionList-style drag
    // No pane dragStart fired ⇒ no live payload + no pane mime ⇒ the drop is a no-op.
    fireEvent.drop(tabEls[1], { dataTransfer: foreign })
    expect(onMoveTab).not.toHaveBeenCalled()
  })

  it('does NOT accept a pane-typed dragover without a live payload (a drop target needs BOTH)', () => {
    renderBar({ tabs: [EDITOR('editor:1', 'a.ts')] })
    const tab = screen.getByTestId('group-tab')
    // The pane mime is present but no dragStart fired ⇒ no live payload. Accepting
    // (preventDefault) here would let a stale/foreign typed drag drop onto a pane.
    const spoof = paneTransfer()
    spoof.setData('application/yaco-pane', 'tab')
    const over = createEvent.dragOver(tab, { dataTransfer: spoof })
    fireEvent(tab, over)
    expect(over.defaultPrevented).toBe(false)
  })

  it('drags the whole group from the background area (distinct from a tab drag)', () => {
    renderBar({ tabs: [EDITOR('editor:1', 'a.ts')] })
    const tabTransfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('group-tab'), { dataTransfer: tabTransfer })
    expect(tabTransfer.getData('application/yaco-pane')).toBe('tab')

    const groupTransfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('group-empty-area'), { dataTransfer: groupTransfer })
    expect(groupTransfer.getData('application/yaco-pane')).toBe('group')
  })
})

describe('GroupTabBar — preview / group emphasis / editor actions', () => {
  it('renders a PREVIEW terminal tab in italic (FIX 1)', () => {
    renderBar(
      { tabs: [TERMINAL('terminal:1', { preview: true })], activeTab: 'terminal:1', terminalBindings: { 'terminal:1': 'claude-1' } },
      { sessions: [{ name: 'claude-1', provider: 'claude' }] },
    )
    const tab = screen.getByTestId('group-tab')
    expect(tab.style.fontStyle).toBe('italic')
  })

  it('focuses an empty group on a tab-bar click (FIX 2 empty-group close affordance)', () => {
    const onActivateGroup = vi.fn()
    renderBar({ tabs: [], activeTab: '', onActivateGroup })
    fireEvent.click(screen.getByTestId('group-empty-area'))
    expect(onActivateGroup).toHaveBeenCalled()
  })

  it('renders the editor actions (Suggestions) only when an editor tab is active (FIX 4)', () => {
    const onSetEditorPrefs = vi.fn()
    const editorPrefs = { previewMode: 'edit' as const, splitDirection: 'horizontal' as const, autocompleteEnabled: false }
    renderBar({
      tabs: [EDITOR('editor:1', 'src/app.ts')], activeTab: 'editor:1', editorPrefs, onSetEditorPrefs,
    })
    fireEvent.click(screen.getByRole('button', { name: /Suggestions/ }))
    expect(onSetEditorPrefs).toHaveBeenCalledWith({ autocompleteEnabled: true })
  })

  it('renders NO editor actions when the active tab is a terminal (FIX 4)', () => {
    renderBar({
      tabs: [TERMINAL('terminal:1')], activeTab: 'terminal:1',
      editorPrefs: { previewMode: 'edit', splitDirection: 'horizontal', autocompleteEnabled: false },
      onSetEditorPrefs: vi.fn(),
    })
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull()
  })
})

describe('GroupTabBar — Separate-editors-and-terminals toggle (design: separateKinds)', () => {
  // The toggle reads `panelLayout.panelState.separateKinds` and fires
  // `commands.toggleSeparateKinds()`; both come from the layout/commands contexts a
  // mounted GroupTabBar lives under. A stateful harness flips the flag so the menu
  // item's observable checked state is asserted as the user would see it.
  function renderToggleMenu(initialSeparate: boolean) {
    const onToggle = vi.fn()
    function Harness() {
      const [separateKinds, setSeparateKinds] = useState(initialSeparate)
      const layout = { panelLayout: { panelState: { separateKinds } } } as unknown as WorkspaceLayoutContextValue
      const commands = {
        toggleSeparateKinds: () => { setSeparateKinds((s) => !s); onToggle() },
      } as unknown as WorkspaceCommands
      const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
      const data = { sessions: { projectSessions: [] } } as unknown as WorkspaceData
      const props = {
        groupId: 'g1', region: 'center', tabs: [EDITOR('editor:1', 'src/app.ts')], activeTab: 'editor:1',
        isActiveGroup: true, dirtyTabs: new Set<string>(), conflictTabs: new Set<string>(), terminalBindings: {},
        pathsOpenElsewhere: new Set<string>(), onSelectTab: vi.fn(), onCloseTab: vi.fn(), onSplit: vi.fn(),
        onMoveTab: vi.fn(), onMoveGroup: vi.fn(), onCloseGroup: vi.fn(), onActivateGroup: vi.fn(), onDiscardDirty: vi.fn(),
      } as GroupTabBarProps
      return (
        <WorkspaceEnvContext.Provider value={env}>
          <WorkspaceDataContext.Provider value={data}>
            <WorkspaceLayoutContext.Provider value={layout}>
              <WorkspaceCommandsContext.Provider value={commands}>
                <GroupTabBar {...props} />
              </WorkspaceCommandsContext.Provider>
            </WorkspaceLayoutContext.Provider>
          </WorkspaceDataContext.Provider>
        </WorkspaceEnvContext.Provider>
      )
    }
    render(<Harness />)
    return { onToggle }
  }

  const openToggleItem = () => {
    fireEvent.click(screen.getByTestId('split-group'))
    return screen.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' })
  }

  it('reflects the current separateKinds flag as the item checked state', () => {
    renderToggleMenu(true)
    expect(openToggleItem().getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the real menu item fires toggleSeparateKinds and flips the observable check', () => {
    const { onToggle } = renderToggleMenu(false)
    const item = openToggleItem()
    expect(item.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(item)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // The menu stays open; the same item now reads checked.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' }).getAttribute('aria-checked')).toBe('true')
  })
})
