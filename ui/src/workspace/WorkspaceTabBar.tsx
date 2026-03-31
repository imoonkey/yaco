import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { isDiffTab, isTasksTab, type MdMode } from '../hooks/useWorkspaceState'

function tabName(tab: string): string {
  if (isTasksTab(tab)) return 'Tasks'
  if (isDiffTab(tab)) return `${tab.slice(5).split('/').pop()} (diff)`
  return tab.split('/').pop() || tab
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
              backgroundColor: active ? '#268bd215' : C.bg,
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
  return (
    <div className="flex items-center shrink-0 overflow-x-auto" style={{ height: 35, backgroundColor: C.bg, borderBottom: `1px solid ${C.border}` }}>
      {openTabs.length === 0 ? (
        <span className="px-4 text-[11px] shrink-0" style={{ color: C.textDim }}>No files open</span>
      ) : openTabs.map(tab => {
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
            <span className="truncate max-w-[120px]">{tabName(tab)}</span>
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
