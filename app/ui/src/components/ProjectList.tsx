import { useState, useCallback, useEffect } from 'react'
import { writeTextToClipboard } from '../lib/clipboard'
import { Menu, MenuItem, MenuDivider } from './Menu'
import { useContextMenu } from './useContextMenu'
import { BadgeCount } from './BadgeCount'
import type { Project } from '../types'
import type { AttentionBadge } from '../hooks/useAttention'

export function ProjectList({
  projects,
  activeProject,
  badgesByProject,
  projectSessionCounts,
  onSelect,
  onReorder,
  onRemove,
  onMarkAllRead,
}: {
  projects: Project[]
  activeProject: string
  badgesByProject: Record<string, AttentionBadge>
  projectSessionCounts: Record<string, { active: number; total: number }>
  onSelect: (name: string) => void
  onReorder: (fromName: string, toName: string) => void
  onRemove: (project: Project) => void
  onMarkAllRead: (projectName: string) => void
}) {
  const [draggedProject, setDraggedProject] = useState<string | null>(null)
  const menu = useContextMenu()
  const [menuProject, setMenuProject] = useState<Project | null>(null)
  const [metaHeld, setMetaHeld] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { setMetaHeld(e.metaKey && !e.ctrlKey) }
    const onKeyUp = (e: KeyboardEvent) => { setMetaHeld(e.metaKey && !e.ctrlKey) }
    const clear = () => setMetaHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [])

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

  // ProjectList shows projects only; the worktree selector lives in the Files
  // header (design: §P2). Clicking a project just selects it.
  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      {projects.map((project, idx) => {
        const isActive = activeProject === project.name
        const badge = badgesByProject[project.name]
        const sc = projectSessionCounts[project.name]
        const shortcutIndex = idx < 9 ? idx + 1 : null
        return (
          <div key={project.name}>
            <button
              draggable
              onDragStart={e => handleDragStart(e, project.name)}
              onDragEnd={() => setDraggedProject(null)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDrop(e, project.name)}
              onClick={() => onSelect(project.name)}
              {...menu.bind(() => setMenuProject(project))}
              className={`relative w-full text-left px-2 py-0.5 rounded text-ui-md font-medium cursor-pointer flex items-center gap-1 ${
                isActive
                  ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]'
                  : 'text-[var(--sol-text)] hover:text-[var(--sol-text-dark)] hover:bg-[var(--sol-hover-bg)]'
              }`}
              style={{
                transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1), color 120ms cubic-bezier(0.2, 0, 0, 1)',
                opacity: draggedProject === project.name ? 0.55 : 1,
                ...(isActive ? { borderLeft: '3px solid var(--sol-accent)', paddingLeft: 5 } : {}),
              }}
            >
              <span className="truncate flex-shrink min-w-0">{project.name}</span>
              {metaHeld && shortcutIndex !== null && (
                <span
                  className="text-ui-xs tabular-nums px-1 rounded shrink-0"
                  style={{
                    color: 'var(--sol-text-faint)',
                    border: '1px solid var(--sol-border)',
                    background: 'var(--sol-subtle-bg)',
                  }}
                  title={`Cmd+${shortcutIndex}`}
                >
                  {shortcutIndex}
                </span>
              )}
              <span className="flex items-center gap-1 shrink-0 ml-auto">
                {badge && <BadgeCount count={badge.count} color={badge.color} />}
                {sc && sc.total > 0 && (
                  <span
                    className="text-ui-md tabular-nums"
                    style={{ color: 'var(--sol-text-faint)' }}
                    title={`${sc.active} active / ${sc.total} total sessions`}
                  >
                    {sc.active}/{sc.total}
                  </span>
                )}
              </span>
            </button>
          </div>
        )
      })}
      {projects.length === 0 && (
        <div className="px-2 py-3 text-ui-sm text-center" style={{ color: 'var(--sol-text)' }}>
          No projects
        </div>
      )}

      {menu.position && menuProject && (
        <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
          <MenuItem label="Copy Path" onClick={() => { writeTextToClipboard(menuProject.path); menu.close() }} />
          <MenuItem label="Mark All Read" onClick={() => { onMarkAllRead(menuProject.name); menu.close() }} />
          <MenuDivider />
          <MenuItem label="Remove" danger onClick={() => { onRemove(menuProject); menu.close() }} />
        </Menu>
      )}
    </div>
  )
}
