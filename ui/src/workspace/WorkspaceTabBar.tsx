import { useMemo } from 'react'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { isDiffTab, isFileTab, isTasksTab, type MdMode } from '../hooks/useWorkspaceState'
import { FileTypeIcon } from '../components/fileExplorerIcons'

function tabName(tab: string): string {
  if (isTasksTab(tab)) return 'Tasks'
  if (isDiffTab(tab)) return `${tab.slice(5).split('/').pop()} (diff)`
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

function MdModeToggle({ mode, onChange, isTouch }: { mode: MdMode; onChange: (m: MdMode) => void; isTouch: boolean }) {
  const modes: { value: MdMode; label: string }[] = isTouch
    ? [{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]
    : [{ value: 'edit', label: 'Edit' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]

  return (
    <div className="flex rounded border overflow-hidden shrink-0" style={{ borderColor: C.border }}>
      {modes.map(({ value, label }) => {
        const active = mode === value
        return (
          <button key={value} onClick={() => onChange(value)}
            className="text-[10px] px-2 py-0.5 cursor-pointer"
            style={{
              backgroundColor: active ? `${SOLARIZED_LIGHT.blue}15` : C.bg,
              color: active ? C.accent : C.text,
              borderRight: value !== modes[modes.length - 1].value ? `1px solid ${C.border}` : undefined,
            }}>
            {label}
          </button>
        )
      })}
    </div>
  )
}

export function WorkspaceTabBar({
  openTabs,
  activeTab,
  previewTab,
  dirtyTabs,
  conflictTabs,
  canToggleMdMode,
  mdMode,
  isTouch,
  onSelectTab,
  onDoubleClickTab,
  onCloseTab,
  onMdModeChange,
  rightActions,
}: {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
  canToggleMdMode: boolean
  mdMode: MdMode
  isTouch: boolean
  onSelectTab: (tab: string) => void
  onDoubleClickTab: (tab: string) => void
  onCloseTab: (tab: string, e: React.MouseEvent) => void
  onMdModeChange: (mode: MdMode) => void
  rightActions?: React.ReactNode
}) {
  const disambigSuffixes = useMemo(() => computeDisambigSuffixes(openTabs), [openTabs])

  return (
    <div className="flex items-center shrink-0 overflow-x-auto" style={{ height: 32, backgroundColor: C.bg, borderBottom: `1px solid ${C.border}` }}>
      {openTabs.length === 0 ? (
        <span className="px-4 text-[11px] shrink-0" style={{ color: C.textDim }}>No files open</span>
      ) : openTabs.map(tab => {
        const parentDirSuffix = disambigSuffixes.get(tab)
        const isActive = tab === activeTab
        const isDirty = dirtyTabs.has(tab)
        const isConflict = conflictTabs.has(tab)
        const isDiff = isDiffTab(tab)
        const isTasks = isTasksTab(tab)
        const isPreview = tab === previewTab
        return (
          <div key={tab} onClick={() => onSelectTab(tab)}
            onDoubleClick={() => onDoubleClickTab(tab)}
            data-testid="tab"
            className="group flex items-center gap-2 px-3 h-full cursor-pointer text-[12px] shrink-0"
            style={{
              backgroundColor: isActive ? C.editorBg : C.bg, color: isActive ? C.textDark : C.textDim,
              borderRight: `1px solid ${C.border}`, borderTop: isActive ? `2px solid ${isConflict ? '#C4A241' : isDiff ? '#C4A241' : isTasks ? C.accent : C.text}` : '2px solid transparent',
              borderBottom: isActive ? `1px solid ${C.editorBg}` : `1px solid ${C.border}`, marginBottom: -1,
              fontStyle: isPreview ? 'italic' : undefined,
            }} title={tabTitle(tab)}>
            {!isTasks && !isDiff && <FileTypeIcon name={tab} />}
            <span className="truncate max-w-[120px]">{tabName(tab)}</span>
            {parentDirSuffix && <span className="text-[10px] ml-0.5 shrink-0" style={{ color: C.muted }}>{parentDirSuffix}</span>}
            {isConflict ? (
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-[12px]" style={{ color: '#C4A241' }} title="File changed on disk">&#9888;</span>
            ) : isDirty ? (
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: C.textDark }} />
              </span>
            ) : (
              <button onClick={(e) => onCloseTab(tab, e)}
                className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity text-[10px] cursor-pointer" style={{ color: C.textDim }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)} onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}>×</button>
            )}
          </div>
        )
      })}
      <div className="ml-auto flex items-center gap-1 shrink-0 mr-2">
        {rightActions}
        {canToggleMdMode && (
          <MdModeToggle mode={mdMode} onChange={onMdModeChange} isTouch={isTouch} />
        )}
      </div>
    </div>
  )
}
