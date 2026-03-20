import { useState, useEffect, useMemo, useCallback } from 'react'
import { Monitor } from './components/Monitor'
import { Workspace } from './components/Workspace'
import { useProjects, useProgress, addProject, reorderProjects } from './hooks/useApi'
import { useBrowserNotifications } from './hooks/useBrowserNotifications'
import type { Project } from './types'

type View = 'monitor' | 'workspace'

const navItems: { id: View; label: string; icon: string }[] = [
  { id: 'monitor', label: 'Monitor', icon: '!' },
  { id: 'workspace', label: 'Workspace', icon: 'W' },
]

const STORAGE_KEY = 'workflow-ui-state'

function loadState(): { view: View; project: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { view: 'monitor', project: 'all' }
}

function saveState(view: View, project: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, project }))
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function buildVisibleProjectOrder(view: View, projects: Project[], includeAllProjects: boolean): string[] {
  const names = projects.map((project) => project.name)
  if (view !== 'workspace' && includeAllProjects) {
    return ['all', ...names]
  }
  return names
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items
  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function ProjectTabs({
  view,
  projectName,
  workspaceProject,
  projects,
  onSelect,
  onAdd,
  onReorder,
}: {
  view: View
  projectName: string
  workspaceProject: string
  projects?: Project[]
  onSelect: (name: string) => void
  onAdd: () => void
  onReorder: (fromName: string, toName: string) => void
}) {
  const showAllProjects = view !== 'workspace'
  const activeProject = view === 'workspace' ? workspaceProject : projectName
  const [draggedProject, setDraggedProject] = useState<string | null>(null)

  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 min-w-0"
      style={{ height: 40, backgroundColor: '#EEE8D5', borderTop: '1px solid #D3CBB7' }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0 text-[#93a1a1]">
        Projects
      </span>

      <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
        <div className="flex items-center gap-1 w-max min-w-full pr-2">
          {showAllProjects && (
            <button
              onClick={() => onSelect('all')}
              className={`px-3 h-7 rounded-md text-[12px] font-medium cursor-pointer shrink-0 transition-colors ${
                activeProject === 'all'
                  ? 'bg-[#268bd2]/15 text-[#268bd2]'
                  : 'text-[#586e75] hover:text-[#073642] hover:bg-[#E2D9C2]'
              }`}
            >
              All Projects
            </button>
          )}

          {(projects ?? []).map(project => {
            const isActive = activeProject === project.name
            return (
              <button
                key={project.name}
                draggable
                onDragStart={() => setDraggedProject(project.name)}
                onDragEnd={() => setDraggedProject(null)}
                onDragOver={(event) => {
                  event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (!draggedProject || draggedProject === project.name) return
                  onReorder(draggedProject, project.name)
                  setDraggedProject(null)
                }}
                onClick={() => onSelect(project.name)}
                className={`px-3 h-7 rounded-md text-[12px] font-medium cursor-pointer shrink-0 transition-colors ${
                  isActive
                    ? 'bg-[#268bd2]/15 text-[#268bd2]'
                    : 'text-[#586e75] hover:text-[#073642] hover:bg-[#E2D9C2]'
                }`}
                style={{
                  opacity: draggedProject === project.name ? 0.55 : 1,
                }}
              >
                {project.name}
              </button>
            )
          })}
        </div>
      </div>

      <button
        onClick={onAdd}
        aria-label="Add project"
        title="Add project"
        className="w-7 h-7 rounded-md text-[18px] leading-none font-medium cursor-pointer shrink-0 text-[#586e75] hover:text-[#073642] hover:bg-[#E2D9C2] transition-colors"
      >
        +
      </button>
    </div>
  )
}

function App() {
  const saved = loadState()
  const [view, setView] = useState<View>(saved.view)
  const [projectName, setProjectName] = useState<string>(saved.project)
  const [lastConcreteProject, setLastConcreteProject] = useState<string>(
    saved.project !== 'all' ? saved.project : ''
  )
  const [projectOrder, setProjectOrder] = useState<string[]>([])

  const { data: projects, refresh: refreshProjects } = useProjects()
  const { data: progress } = useProgress()
  const browserNotifications = useBrowserNotifications()

  useEffect(() => {
    if (!projects) return
    const names = projects.map((project) => project.name)
    setProjectOrder((currentOrder) => {
      const remaining = new Set(names)
      const nextOrder = currentOrder.filter((name) => remaining.delete(name))
      nextOrder.push(...names.filter((name) => remaining.has(name)))
      return arraysEqual(currentOrder, nextOrder) ? currentOrder : nextOrder
    })
  }, [projects])

  const orderedProjects = useMemo(() => {
    if (!projects) return []
    if (projectOrder.length === 0) return projects
    const byName = new Map(projects.map((project) => [project.name, project]))
    const ordered = projectOrder
      .map((name) => byName.get(name))
      .filter((project): project is Project => Boolean(project))
    for (const project of projects) {
      if (!projectOrder.includes(project.name)) {
        ordered.push(project)
      }
    }
    return ordered
  }, [projectOrder, projects])

  const uncleared = progress?.filter(e => e.status === 'active').length ?? 0
  const concreteProject = lastConcreteProject || (orderedProjects[0]?.name ?? '')

  // Persist state changes
  useEffect(() => {
    saveState(view, projectName)
  }, [view, projectName])

  const handleProjectChange = useCallback((name: string) => {
    if (name === '__add__') {
      handleAddProject()
      return
    }
    setProjectName(name)
    if (name !== 'all') setLastConcreteProject(name)
  }, [])

  const handleAddProject = async () => {
    const path = prompt('Project path (absolute):')
    if (!path) return
    const name = path.replace(/\/+$/, '').split('/').pop() || ''
    if (!name) return
    try {
      await addProject(name, path)
      refreshProjects()
      setProjectName(name)
      setLastConcreteProject(name)
      setProjectOrder((currentOrder) => currentOrder.includes(name) ? currentOrder : [...currentOrder, name])
    } catch (err) {
      alert(`Failed to add project: ${err}`)
    }
  }

  const handleProjectReorder = useCallback(async (fromName: string, toName: string) => {
    const currentOrder = projectOrder.length > 0 ? projectOrder : orderedProjects.map((project) => project.name)
    if (fromName === toName) return
    const fromIndex = currentOrder.indexOf(fromName)
    const toIndex = currentOrder.indexOf(toName)
    if (fromIndex === -1 || toIndex === -1) return

    const nextOrder = moveItem(currentOrder, fromIndex, toIndex)
    setProjectOrder(nextOrder)
    try {
      await reorderProjects(nextOrder)
      refreshProjects()
    } catch (err) {
      setProjectOrder(projects?.map((project) => project.name) ?? [])
      alert(`Failed to reorder projects: ${err}`)
    }
  }, [orderedProjects, projectOrder, projects, refreshProjects])

  const handleViewChange = (v: View) => {
    setView(v)
    if (v === 'workspace' && projectName === 'all') {
      setProjectName(concreteProject)
    }
  }

  useEffect(() => {
    const visibleProjectOrder = buildVisibleProjectOrder(view, orderedProjects, true)
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (!/^[1-9]$/.test(event.key)) return

      const index = Number(event.key) - 1
      const targetProject = visibleProjectOrder[index]
      if (!targetProject) return

      event.preventDefault()
      handleProjectChange(targetProject)
    }

    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [handleProjectChange, orderedProjects, view])

  const workspaceProject = projectName === 'all' ? concreteProject : projectName
  const currentProjectPath = orderedProjects.find(p => p.name === workspaceProject)?.path ?? ''

  return (
    <div className="flex flex-col h-dvh bg-[#fdf6e3]">
      <header className="h-10 shrink-0 flex items-center px-3 gap-1" style={{ backgroundColor: '#EEE8D5', borderBottom: '1px solid #D3CBB7' }}>
        <div className="flex items-center gap-0.5">
          {navItems.map(item => {
            const isActive = view === item.id
            return (
              <button
                key={item.id}
                onClick={() => handleViewChange(item.id)}
                className={`relative flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-[#268bd2]/15 text-[#268bd2]'
                    : 'text-[#586e75] hover:text-[#073642] hover:bg-[#E2D9C2]'
                }`}
              >
                <span className="font-bold text-[11px]">{item.icon}</span>
                {item.label}
                {item.id === 'monitor' && uncleared > 0 && (
                  <span className="w-4 h-4 rounded-full bg-[#dc322f] text-[8px] text-white flex items-center justify-center font-bold">
                    {uncleared}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'monitor' && <Monitor filterProject={projectName === 'all' ? null : projectName} browserNotifications={browserNotifications} />}
        {view === 'workspace' && <Workspace key={workspaceProject} projectName={workspaceProject} projectPath={currentProjectPath} />}
      </main>

      <ProjectTabs
        view={view}
        projectName={projectName}
        workspaceProject={workspaceProject}
        projects={orderedProjects}
        onSelect={handleProjectChange}
        onAdd={handleAddProject}
        onReorder={handleProjectReorder}
      />
    </div>
  )
}

export default App
