import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'

function tabName(tab: string): string {
  if (tab.startsWith('diff:')) return `${tab.slice(5).split('/').pop()} (diff)`
  return tab.split('/').pop() || tab
}

export function WorkspaceTabBar({
  openTabs,
  activeTab,
  previewTab,
  dirtyTabs,
  conflictTabs,
  canTogglePreview,
  previewMode,
  onSelectTab,
  onDoubleClickTab,
  onCloseTab,
  onTogglePreview,
}: {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
  canTogglePreview: boolean
  previewMode: boolean
  onSelectTab: (tab: string) => void
  onDoubleClickTab: (tab: string) => void
  onCloseTab: (tab: string, e: React.MouseEvent) => void
  onTogglePreview: () => void
}) {
  return (
    <div className="flex items-center shrink-0 overflow-x-auto" style={{ height: 35, backgroundColor: C.bg, borderBottom: `1px solid ${C.border}` }}>
      {openTabs.length === 0 ? (
        <span className="px-4 text-[11px] shrink-0" style={{ color: C.textDim }}>No files open</span>
      ) : openTabs.map(tab => {
        const isActive = tab === activeTab
        const isDirty = dirtyTabs.has(tab)
        const isConflict = conflictTabs.has(tab)
        const isDiff = tab.startsWith('diff:')
        const isPreview = tab === previewTab
        return (
          <div key={tab} onClick={() => onSelectTab(tab)}
            onDoubleClick={() => onDoubleClickTab(tab)}
            className="group flex items-center gap-2 px-3 h-full cursor-pointer text-[12px] shrink-0"
            style={{
              backgroundColor: isActive ? C.editorBg : C.bg, color: isActive ? C.textDark : C.textDim,
              borderRight: `1px solid ${C.border}`, borderTop: isActive ? `2px solid ${isConflict ? '#C4A241' : isDiff ? '#C4A241' : C.text}` : '2px solid transparent',
              borderBottom: isActive ? `1px solid ${C.editorBg}` : `1px solid ${C.border}`, marginBottom: -1,
            }} title={tab}>
            <span className="truncate max-w-[120px]" style={isPreview ? { fontStyle: 'italic' } : undefined}>{tabName(tab)}</span>
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
      {canTogglePreview && (
        <button onClick={onTogglePreview} className="ml-auto mr-2 text-[10px] px-2 py-0.5 rounded border cursor-pointer shrink-0"
          style={{ backgroundColor: previewMode ? '#268bd215' : C.bg, color: previewMode ? C.accent : C.text, borderColor: previewMode ? '#268bd230' : C.border }}>
          {previewMode ? 'Edit' : 'Preview'}
        </button>
      )}
    </div>
  )
}
