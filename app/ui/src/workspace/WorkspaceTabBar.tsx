import { useMemo, useState, useRef, useCallback, useEffect } from 'react'
import { X, AlertTriangle, Columns2, Rows2, SplitSquareHorizontal, ChevronDown, FileDiff } from 'lucide-react'

import { isDiffTab, isFileTab, type PreviewMode, type SplitDirection } from '../hooks/useWorkspaceState'
import type { SplitSide } from './context'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { Menu, MenuItem, MenuDivider } from '../components/Menu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useContextMenu } from '../components/useContextMenu'
import { splitSideFromGeometry } from './panelInstance'
import { tabName, computeDisambigSuffixes, tabCloseLabel } from './tabLabels'

function tabTitle(tab: string): string {
  return tab
}

// Static style constants extracted from render loops
const BAR_STYLE: React.CSSProperties = {
  height: 28, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)',
}

const TAB_STYLE_BASE: React.CSSProperties = {
  borderRight: '1px solid var(--sol-border)',
  marginBottom: -1,
  transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1), color 120ms cubic-bezier(0.2, 0, 0, 1)',
}

function PreviewModeToggle({ mode, splitDirection, onChange, onDirectionChange, isTouch }: { mode: PreviewMode; splitDirection: SplitDirection; onChange: (m: PreviewMode) => void; onDirectionChange: (d: SplitDirection) => void; isTouch: boolean }) {
  const modes: { value: PreviewMode; label: string }[] = isTouch
    ? [{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]
    : [{ value: 'edit', label: 'Edit' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]

  return (
    <div className="flex items-center gap-1 shrink-0">
      <div className="flex rounded border overflow-hidden" style={{ borderColor: 'var(--sol-border)' }}>
        {modes.map(({ value, label }) => {
          const active = mode === value
          return (
            <button key={value} onClick={() => onChange(value)}
              className="text-ui-xs px-2 py-0.5 cursor-pointer"
              style={{
                backgroundColor: active ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'var(--sol-bg)',
                color: active ? 'var(--sol-accent)' : 'var(--sol-text)',
                borderRight: value !== modes[modes.length - 1].value ? '1px solid var(--sol-border)' : undefined,
              }}>
              {label}
            </button>
          )
        })}
      </div>
      {mode === 'split' && !isTouch && (
        <button
          onClick={() => onDirectionChange(splitDirection === 'horizontal' ? 'vertical' : 'horizontal')}
          className="flex items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg"
          style={{ width: 20, height: 20, color: 'var(--sol-text-dim)', transition: 'background-color 120ms' }}
          title={splitDirection === 'horizontal' ? 'Switch to vertical split' : 'Switch to horizontal split'}
        >
          {splitDirection === 'horizontal' ? <Rows2 size={12} /> : <Columns2 size={12} />}
        </button>
      )}
    </div>
  )
}

// --- Editor split / move / close chrome (design: §E) -----------------------
// The home editor (instanceId 'editor') only splits; secondary editors also move
// and close. The split button picks its axis from the live pane geometry; the
// caret menu exposes both axes (the orthogonal mirrors Cmd+K Cmd+\) plus the
// secondary-only Move/Close.
export type EditorSplitChrome = {
  isSecondary: boolean
  onSplit: (side: SplitSide) => void
  onMove: (side: SplitSide) => void
  onClose: () => void
}

const SPLIT_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 22, padding: 0, border: 'none', borderRadius: 3, cursor: 'pointer',
  background: 'transparent', color: 'var(--sol-text-dim)',
}

function EditorSplitControl({ isSecondary, onSplit, onMove, onClose }: EditorSplitChrome) {
  const menu = useContextMenu()
  const btnRef = useRef<HTMLButtonElement>(null)
  // Default axis from the pane's own box: wide → split right, tall → split below.
  const geometrySide = (): SplitSide => {
    const pane = btnRef.current?.closest('[data-instance-id]') as HTMLElement | null
    return pane ? splitSideFromGeometry(pane.offsetWidth, pane.offsetHeight) : 'right'
  }
  const run = (fn: () => void) => () => { fn(); menu.close() }
  return (
    <div className="flex items-center shrink-0">
      <button ref={btnRef} type="button" onClick={() => onSplit(geometrySide())}
        title="Split editor" aria-label="Split editor" style={{ ...SPLIT_BTN_STYLE, width: 24 }}>
        <SplitSquareHorizontal size={13} aria-hidden="true" />
      </button>
      <button type="button" onClick={menu.open}
        title="Split options" aria-label="Split editor options" aria-haspopup="menu"
        style={{ ...SPLIT_BTN_STYLE, width: 14 }}>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {menu.position && (
        <Menu position={menu.position} exiting={menu.exiting} onExitDone={menu.onExitDone}>
          <MenuItem label="Split Right" onClick={run(() => onSplit('right'))} />
          <MenuItem label="Split Down" onClick={run(() => onSplit('below'))} />
          {isSecondary && (
            <>
              <MenuDivider />
              <MenuItem label="Move Left" onClick={run(() => onMove('left'))} />
              <MenuItem label="Move Right" onClick={run(() => onMove('right'))} />
              <MenuDivider />
              <MenuItem label="Close Editor" danger onClick={run(onClose)} />
            </>
          )}
        </Menu>
      )}
    </div>
  )
}

const NO_PATHS: ReadonlySet<string> = new Set()

export function WorkspaceTabBar({
  openTabs,
  activeTab,
  previewTab,
  dirtyTabs,
  conflictTabs,
  canTogglePreview,
  previewMode,
  splitDirection,
  isTouch,
  onSelectTab,
  onDoubleClickTab,
  onCloseTab,
  onPreviewModeChange,
  onSplitDirectionChange,
  onSaveTab,
  rightActions,
  editorSplit,
  pathsOpenElsewhere,
  onDiscardDirty,
}: {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
  canTogglePreview: boolean
  previewMode: PreviewMode
  splitDirection: SplitDirection
  isTouch: boolean
  onSelectTab: (tab: string) => void
  onDoubleClickTab: (tab: string) => void
  onCloseTab: (tab: string) => void
  onPreviewModeChange: (mode: PreviewMode) => void
  onSplitDirectionChange: (direction: SplitDirection) => void
  onSaveTab?: (tab: string) => void
  rightActions?: React.ReactNode
  editorSplit?: EditorSplitChrome
  pathsOpenElsewhere?: ReadonlySet<string>
  // Explicit discard for the LAST view of a dirty file: clears the draft (→ clean)
  // so the post-close GC drops the now-unreferenced buffer (design: §B). Not called
  // on the no-prompt path (file still open elsewhere → the shared buffer is kept).
  onDiscardDirty?: (tab: string) => void
}) {
  const disambigSuffixes = useMemo(() => computeDisambigSuffixes(openTabs), [openTabs])
  const ctxMenu = useContextMenu()
  const [ctxTab, setCtxTab] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const elsewhere = pathsOpenElsewhere ?? NO_PATHS

  // Dirty-close confirm (design: §B). Closing a dirty tab still shown in another
  // editor view loses nothing (shared buffer), so it closes immediately; the LAST
  // view of a dirty file prompts before discarding.
  const requestClose = useCallback((tab: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (dirtyTabs.has(tab) && !elsewhere.has(tab)) setPendingClose(tab)
    else onCloseTab(tab)
  }, [dirtyTabs, elsewhere, onCloseTab])

  // Scroll fade affordance
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollFade, setScrollFade] = useState<'none' | 'right' | 'left' | 'both'>('none')

  const updateScrollFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const canLeft = el.scrollLeft > 1
    const canRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    setScrollFade(canLeft && canRight ? 'both' : canLeft ? 'left' : canRight ? 'right' : 'none')
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollFade, { passive: true })
    const ro = new ResizeObserver(updateScrollFade)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', updateScrollFade); ro.disconnect() }
  }, [updateScrollFade, openTabs])

  const fadeMask = scrollFade === 'none' ? undefined
    : scrollFade === 'right' ? 'linear-gradient(to left, transparent, black 24px)'
    : scrollFade === 'left' ? 'linear-gradient(to right, transparent, black 24px)'
    : 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'

  return (
    <>
    <div className="flex items-center shrink-0" style={BAR_STYLE}>
      <div ref={scrollRef} className="flex-1 min-w-0 flex items-center h-full overflow-x-auto overflow-y-hidden" style={fadeMask ? { maskImage: fadeMask, WebkitMaskImage: fadeMask } : undefined}>
      {openTabs.length === 0 ? (
        <span className="px-3 text-ui-sm shrink-0" style={{ color: 'var(--sol-text)' }}>No files open</span>
      ) : openTabs.map(tab => {
        const parentDirSuffix = disambigSuffixes.get(tab)
        const isActive = tab === activeTab
        const isDirty = dirtyTabs.has(tab)
        const isConflict = conflictTabs.has(tab)
        const isDiff = isDiffTab(tab)
        const isPreview = tab === previewTab
        const tabCtx = ctxMenu.bind(() => { setCtxTab(tab) })
        return (
          <div key={tab} onClick={() => onSelectTab(tab)}
            onDoubleClick={() => onDoubleClickTab(tab)}
            {...tabCtx}
            data-testid="tab"
            className="group flex items-center gap-1 px-1.5 h-full cursor-pointer text-ui-sm shrink-0"
            style={{
              ...TAB_STYLE_BASE,
              backgroundColor: isActive ? 'var(--sol-editor-bg)' : 'var(--sol-bg)', color: isActive ? 'var(--sol-text-dark)' : 'var(--sol-text)',
              borderTop: isActive ? `2px solid ${isConflict ? 'var(--sol-warning)' : isDiff ? 'var(--sol-warning)' : 'var(--sol-text)'}` : '2px solid transparent',
              borderBottom: isActive ? '1px solid var(--sol-editor-bg)' : '1px solid var(--sol-border)',
              fontStyle: isPreview ? 'italic' : undefined,
            }} title={tabTitle(tab)}>
            {isDiff
              ? <FileDiff size={13} aria-hidden="true" className="shrink-0" />
              : <FileTypeIcon name={tab} />}
            <span className="truncate max-w-[120px]" style={isPreview ? { paddingRight: 2 } : undefined}>{tabName(tab)}</span>
            {isPreview && <span className="text-ui-2xs shrink-0" style={{ color: 'var(--sol-text-faint)', fontStyle: 'italic' }}>(preview)</span>}
            {parentDirSuffix && <span className="text-ui-xs ml-0.5 shrink-0" style={{ color: 'var(--sol-text-faint)' }}>{parentDirSuffix}</span>}
            {isConflict ? (
              <span className="w-3 h-3 flex items-center justify-center shrink-0" style={{ color: 'var(--sol-warning)' }} title="File changed on disk"><AlertTriangle size={10} /></span>
            ) : isDirty ? (
              <span className="relative w-3 h-3 flex items-center justify-center shrink-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden" style={{ backgroundColor: 'var(--sol-text-dark)' }} />
                <button onClick={(e) => requestClose(tab, e)}
                  className="hidden group-hover:flex w-3 h-3 items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg absolute inset-0" style={{ color: 'var(--sol-text-dim)', transition: 'background-color 120ms' }}
                  aria-label={tabCloseLabel(tab)}
                ><X size={10} /></button>
              </span>
            ) : (
              <button onClick={(e) => requestClose(tab, e)}
                className="w-3 h-3 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 cursor-pointer hover:bg-sol-hover-bg" style={{ color: 'var(--sol-text-dim)', transition: 'opacity 120ms, background-color 120ms' }}
                aria-label={tabCloseLabel(tab)}
                ><X size={10} /></button>
            )}
          </div>
        )
      })}
      </div>
      <div className="flex items-center gap-1 shrink-0 px-2" style={{ borderLeft: '1px solid var(--sol-border)' }}>
        {editorSplit && <EditorSplitControl {...editorSplit} />}
        {rightActions}
        {canTogglePreview && (
          <PreviewModeToggle mode={previewMode} splitDirection={splitDirection} onChange={onPreviewModeChange} onDirectionChange={onSplitDirectionChange} isTouch={isTouch} />
        )}
      </div>
    </div>
    {ctxMenu.position && ctxTab && (() => {
      const tab = ctxTab
      const isDirty = dirtyTabs.has(tab)
      const isFile = isFileTab(tab)
      return (
        <Menu position={ctxMenu.position} exiting={ctxMenu.exiting} armed={ctxMenu.armed} focusOnOpen={ctxMenu.focusOnOpen} onExitDone={ctxMenu.onExitDone}>
          {isFile && isDirty && onSaveTab && (
            <MenuItem label="Save" onClick={() => { onSaveTab(tab); ctxMenu.close() }} />
          )}
          {isDirty && (
            <MenuItem label="Close Without Saving" danger onClick={() => { requestClose(tab); ctxMenu.close() }} />
          )}
          {!isDirty && (
            <MenuItem label="Close" onClick={() => { requestClose(tab); ctxMenu.close() }} />
          )}
        </Menu>
      )
    })()}
    {pendingClose && (
      <ConfirmDialog
        title="Discard unsaved changes?"
        description={`${tabName(pendingClose)} has unsaved changes that will be lost.`}
        confirmLabel="Close Without Saving"
        danger
        onConfirm={() => { onDiscardDirty?.(pendingClose); onCloseTab(pendingClose) }}
        onClose={() => setPendingClose(null)}
      />
    )}
    </>
  )
}
