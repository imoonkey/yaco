import { useState, useEffect, useCallback } from 'react'
import { writeTextToClipboard } from '../lib/clipboard'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import type { Project } from '../types'

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div
      className="px-3 py-1 text-[12px] cursor-pointer"
      style={{ color: danger ? SOLARIZED_LIGHT.red : C.text }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.bg)}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

function MenuDivider() {
  return <div className="my-1" style={{ borderTop: `1px solid ${SOLARIZED_LIGHT.tabInactiveBackground}` }} />
}

type CtxMenu = { x: number; y: number; project: Project }

export function ProjectList({
  projects,
  activeProject,
  projectUnreadCounts,
  onSelect,
  onReorder,
  onRemove,
  onMarkAllRead,
}: {
  projects: Project[]
  activeProject: string
  projectUnreadCounts: Record<string, number>
  onSelect: (name: string) => void
  onReorder: (fromName: string, toName: string) => void
  onRemove: (project: Project) => void
  onMarkAllRead: (projectName: string) => void
}) {
  const [draggedProject, setDraggedProject] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey) }
  }, [ctxMenu])

  const handleDragStart = useCallback((e: React.DragEvent, name: string) => {
    e.dataTransfer.setData('text/plain', name)
    e.dataTransfer.effectAllowed = 'move'
    setDraggedProject(name)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetName: string) => {
    e.preventDefault()
    if (!draggedProject || draggedProject === targetName) return
    onReorder(draggedProject, targetName)
    setDraggedProject(null)
  }, [draggedProject, onReorder])

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      {projects.map(project => {
        const isActive = activeProject === project.name
        const unreadCount = projectUnreadCounts[project.name] ?? 0
        return (
          <button
            key={project.name}
            draggable
            onDragStart={e => handleDragStart(e, project.name)}
            onDragEnd={() => setDraggedProject(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => handleDrop(e, project.name)}
            onClick={() => onSelect(project.name)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, project }) }}
            className={`relative w-full text-left px-2 py-1.5 rounded text-[12px] font-medium cursor-pointer transition-colors truncate ${
              isActive
                ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]'
                : 'text-[var(--sol-base01)] hover:text-[var(--sol-base02)] hover:bg-[#E2D9C2]'
            }`}
            style={{ opacity: draggedProject === project.name ? 0.55 : 1 }}
          >
            {project.name}
            {unreadCount > 0 && (
              <span
                className="absolute top-0.5 right-1 min-w-[16px] h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center px-1"
                style={{ backgroundColor: SOLARIZED_LIGHT.orange }}
              >
                {unreadCount}
              </span>
            )}
          </button>
        )
      })}
      {projects.length === 0 && (
        <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>
          No projects
        </div>
      )}

      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] py-1 rounded shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y, backgroundColor: C.editorBg, border: `1px solid ${SOLARIZED_LIGHT.tabInactiveBackground}` }}
          onClick={e => e.stopPropagation()}
        >
          <MenuItem label="Copy Path" onClick={() => { writeTextToClipboard(ctxMenu.project.path); setCtxMenu(null) }} />
          <MenuItem label="Mark All Read" onClick={() => { onMarkAllRead(ctxMenu.project.name); setCtxMenu(null) }} />
          <MenuDivider />
          <MenuItem label="Remove" danger onClick={() => { onRemove(ctxMenu.project); setCtxMenu(null) }} />
        </div>
      )}
    </div>
  )
}
