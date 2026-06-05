import { useMemo, useState, useRef, useCallback, useEffect } from 'react'
import { X, AlertTriangle, Columns2, Rows2 } from 'lucide-react'

import { isDiffTab, isFileTab, isTasksTab, parseDiffTab, type PreviewMode, type SplitDirection } from '../hooks/useWorkspaceState'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { Menu, MenuItem } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'

function truncateRef(ref: string, max = 12): string {
  return ref.length > max ? ref.slice(0, max - 1) + '\u2026' : ref
}

function tabName(tab: string): string {
  if (isTasksTab(tab)) return 'Tasks'
  if (isDiffTab(tab)) {
    const parsed = parseDiffTab(tab)
    if (!parsed) return tab
    const filename = parsed.path.split('/').pop() || parsed.path
    if (parsed.base && parsed.compare) {
      return `${filename} (${truncateRef(parsed.base)}..${truncateRef(parsed.compare)})`
    }
    return `${filename} (diff)`
  }
  return tab.split('/').pop() || tab
}

/** For tabs sharing a basename, compute the shortest parent suffix that disambiguates them. */
function computeDisambigSuffixes(tabs: string[]): Map<string, string> {
  const suffixes = new Map<string, string>()

  // Group file tabs by basename
  const byBasename = new Map<string, string[]>()
  for (const tab of tabs) {
    if (!isFileTab(tab)) continue
    const basename = tab.split('/').pop() || tab
    const group = byBasename.get(basename)
    if (group) group.push(tab)
    else byBasename.set(basename, [tab])
  }

  for (const [, group] of byBasename) {
    if (group.length < 2) continue
    // For each tab in the group, find shortest parent dir suffix that's unique
    const parentSegments = group.map(tab => {
      const parts = tab.split('/')
      return parts.slice(0, -1) // dir segments only
    })
    for (let gi = 0; gi < group.length; gi++) {
      const myParts = parentSegments[gi]
      // Try 1 parent segment, then 2, etc.
      for (let depth = 1; depth <= myParts.length; depth++) {
        const suffix = myParts.slice(-depth).join('/')
        const unique = parentSegments.every((other, oi) =>
          oi === gi || other.slice(-depth).join('/') !== suffix
        )
        if (unique) { suffixes.set(group[gi], suffix); break }
      }
      // If no unique suffix found (identical paths), use full parent
      if (!suffixes.has(group[gi]) && myParts.length > 0) {
        suffixes.set(group[gi], myParts.join('/'))
      }
    }
  }
  return suffixes
}

function tabTitle(tab: string): string {
  return isTasksTab(tab) ? 'Tasks' : tab
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
              className="text-[10px] px-2 py-0.5 cursor-pointer"
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
  onCloseTab: (tab: string, e?: React.MouseEvent) => void
  onPreviewModeChange: (mode: PreviewMode) => void
  onSplitDirectionChange: (direction: SplitDirection) => void
  onSaveTab?: (tab: string) => void
  rightActions?: React.ReactNode
}) {
  const disambigSuffixes = useMemo(() => computeDisambigSuffixes(openTabs), [openTabs])
  const ctxMenu = useContextMenu()
  const [ctxTab, setCtxTab] = useState<string | null>(null)

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
      <div ref={scrollRef} className="flex-1 min-w-0 flex items-center h-full overflow-x-auto" style={fadeMask ? { maskImage: fadeMask, WebkitMaskImage: fadeMask } : undefined}>
      {openTabs.length === 0 ? (
        <span className="px-3 text-[11px] shrink-0" style={{ color: 'var(--sol-text-dim)' }}>No files open</span>
      ) : openTabs.map(tab => {
        const parentDirSuffix = disambigSuffixes.get(tab)
        const isActive = tab === activeTab
        const isDirty = dirtyTabs.has(tab)
        const isConflict = conflictTabs.has(tab)
        const isDiff = isDiffTab(tab)
        const isTasks = isTasksTab(tab)
        if (isTasks) return null  // Tasks is toggled from sidebar, not a tab
        const isPreview = tab === previewTab
        const tabCtx = ctxMenu.bind(() => { setCtxTab(tab) })
        return (
          <div key={tab} onClick={() => onSelectTab(tab)}
            onDoubleClick={() => onDoubleClickTab(tab)}
            {...tabCtx}
            data-testid="tab"
            className="group flex items-center gap-1 px-1.5 h-full cursor-pointer text-[11px] shrink-0"
            style={{
              ...TAB_STYLE_BASE,
              backgroundColor: isActive ? 'var(--sol-editor-bg)' : 'var(--sol-bg)', color: isActive ? 'var(--sol-text-dark)' : 'var(--sol-text-dim)',
              borderTop: isActive ? `2px solid ${isConflict ? 'var(--sol-warning)' : isDiff ? 'var(--sol-warning)' : isTasks ? 'var(--sol-accent)' : 'var(--sol-text)'}` : '2px solid transparent',
              borderBottom: isActive ? '1px solid var(--sol-editor-bg)' : '1px solid var(--sol-border)',
              fontStyle: isPreview ? 'italic' : undefined,
            }} title={tabTitle(tab)}>
            {!isTasks && !isDiff && <FileTypeIcon name={tab} />}
            <span className="truncate max-w-[120px]" style={isPreview ? { paddingRight: 2 } : undefined}>{tabName(tab)}</span>
            {isPreview && <span className="text-[9px] shrink-0" style={{ color: 'var(--sol-muted)', fontStyle: 'italic' }}>(preview)</span>}
            {parentDirSuffix && <span className="text-[10px] ml-0.5 shrink-0" style={{ color: 'var(--sol-muted)' }}>{parentDirSuffix}</span>}
            {isConflict ? (
              <span className="w-3 h-3 flex items-center justify-center shrink-0" style={{ color: 'var(--sol-warning)' }} title="File changed on disk"><AlertTriangle size={10} /></span>
            ) : isDirty ? (
              <span className="relative w-3 h-3 flex items-center justify-center shrink-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden" style={{ backgroundColor: 'var(--sol-text-dark)' }} />
                <button onClick={(e) => onCloseTab(tab, e)}
                  className="hidden group-hover:flex w-3 h-3 items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg absolute inset-0" style={{ color: 'var(--sol-text-dim)', transition: 'background-color 120ms' }}
                  aria-label={`Close ${tabName(tab)}`}
                ><X size={10} /></button>
              </span>
            ) : (
              <button onClick={(e) => onCloseTab(tab, e)}
                className="w-3 h-3 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 cursor-pointer hover:bg-sol-hover-bg" style={{ color: 'var(--sol-text-dim)', transition: 'opacity 120ms, background-color 120ms' }}
                aria-label={`Close ${tabName(tab)}`}
                ><X size={10} /></button>
            )}
          </div>
        )
      })}
      </div>
      <div className="flex items-center gap-1 shrink-0 px-2" style={{ borderLeft: '1px solid var(--sol-border)' }}>
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
        <Menu position={ctxMenu.position} exiting={ctxMenu.exiting} onExitDone={ctxMenu.onExitDone}>
          {isFile && isDirty && onSaveTab && (
            <MenuItem label="Save" onClick={() => { onSaveTab(tab); ctxMenu.close() }} />
          )}
          {isDirty && (
            <MenuItem label="Close Without Saving" danger onClick={() => { onCloseTab(tab); ctxMenu.close() }} />
          )}
          {!isDirty && (
            <MenuItem label="Close" onClick={() => { onCloseTab(tab); ctxMenu.close() }} />
          )}
        </Menu>
      )
    })()}
    </>
  )
}
