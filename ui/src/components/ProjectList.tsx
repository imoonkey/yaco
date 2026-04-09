import { useState, useCallback } from 'react'
import { writeTextToClipboard } from '../lib/clipboard'
import { Menu, MenuItem, MenuDivider, useContextMenu } from './Menu'
import type { Project } from '../types'

export function ProjectList({
  projects,
  activeProject,
  projectUnreadCounts,
  projectSessionCounts,
  onSelect,
  onReorder,
  onRemove,
  onMarkAllRead,
}: {
  projects: Project[]
  activeProject: string
  projectUnreadCounts: Record<string, number>
  projectSessionCounts: Record<string, { active: number; total: number }>
  onSelect: (name: string) => void
  onReorder: (fromName: string, toName: string) => void
  onRemove: (project: Project) => void
  onMarkAllRead: (projectName: string) => void
}) {
  const [draggedProject, setDraggedProject] = useState<string | null>(null)
  const menu = useContextMenu()
  const [menuProject, setMenuProject] = useState<Project | null>(null)

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
        const sc = projectSessionCounts[project.name]
        return (
          <button
            key={project.name}
            draggable
            onDragStart={e => handleDragStart(e, project.name)}
            onDragEnd={() => setDraggedProject(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => handleDrop(e, project.name)}
            onClick={() => onSelect(project.name)}
            {...menu.bind(() => setMenuProject(project))}
            className={`relative w-full text-left px-2 py-1.5 rounded text-[12px] font-medium cursor-pointer transition-colors flex items-center gap-1 ${
              isActive
                ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]'
                : 'text-[var(--sol-base01)] hover:text-[var(--sol-text-dark)] hover:bg-[var(--sol-hover-bg)]'
            }`}
            style={{ opacity: draggedProject === project.name ? 0.55 : 1 }}
          >
            <span className="truncate flex-1">{project.name}</span>
            <span className="flex items-center gap-1 shrink-0">
              {unreadCount > 0 && (
                <span
                  className="min-w-[16px] h-[18px] rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1"
                  style={{ backgroundColor: 'var(--sol-orange)' }}
                >
                  {unreadCount}
                </span>
              )}
              {sc && sc.total > 0 && (
                <span
                  className="text-[12px] tabular-nums opacity-50"
                  title={`${sc.active} active / ${sc.total} total sessions`}
                >
                  {sc.active}/{sc.total}
                </span>
              )}
            </span>
          </button>
        )
      })}
      {projects.length === 0 && (
        <div className="px-2 py-3 text-[11px] text-center" style={{ color: 'var(--sol-muted)' }}>
          No projects
        </div>
      )}

      {menu.position && menuProject && (
        <Menu position={menu.position}>
          <MenuItem label="Copy Path" onClick={() => { writeTextToClipboard(menuProject.path); menu.close() }} />
          <MenuItem label="Mark All Read" onClick={() => { onMarkAllRead(menuProject.name); menu.close() }} />
          <MenuDivider />
          <MenuItem label="Remove" danger onClick={() => { onRemove(menuProject); menu.close() }} />
        </Menu>
      )}
    </div>
  )
}
