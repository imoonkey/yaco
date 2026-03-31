import { useState, useEffect, useMemo, useCallback } from 'react'
import { Workspace } from './components/Workspace'
import { useProjects, useProgress, useSessions, removeProject, reorderProjects } from './hooks/useApi'
import { AddProjectDialog } from './components/AddProjectDialog'
import { useBrowserNotifications } from './hooks/useBrowserNotifications'
import { useKeyboardViewport } from './hooks/useKeyboardViewport'
import { useSessionUnreadState } from './hooks/useSessionUnreadState'
import type { WorkspaceVisibilityReport, AttachSessionIntent } from './hooks/useSessionUnreadState'
import type { Project } from './types'

const STORAGE_KEY = 'workflow-ui-state'

function loadProject(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Tolerate old shape { view, project } — just read project
      const p = parsed.project ?? ''
      return p === 'all' ? '' : p
    }
  } catch { /* ignore */ }
  return ''
}

function saveProject(project: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ project }))
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items
  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function App() {
  useKeyboardViewport()
  const [projectName, setProjectName] = useState<string>(loadProject)
  const [projectOrder, setProjectOrder] = useState<string[]>([])

  const { data: projects, refresh: refreshProjects } = useProjects()
  const { data: progress } = useProgress()
  const { data: allSessions } = useSessions()
  const [showAddDialog, setShowAddDialog] = useState(false)

  // App/Workspace bridge state
  const [visibilityReport, setVisibilityReport] = useState<WorkspaceVisibilityReport | null>(null)
  const [attachIntent, setAttachIntent] = useState<AttachSessionIntent | null>(null)

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

  // Resolve active project — fall back to first project if saved one doesn't exist
  const activeProject = useMemo(() => {
    if (projectName && orderedProjects.some(p => p.name === projectName)) return projectName
    return orderedProjects[0]?.name ?? ''
  }, [projectName, orderedProjects])

  const currentProjectPath = orderedProjects.find(p => p.name === activeProject)?.path ?? ''

  // Unread state — purely derived from progress, sessions, and localStorage read timestamps
  const { sessionUnreadCounts, projectUnreadCounts, markSessionRead, markAllRead } = useSessionUnreadState(
    progress,
    allSessions,
    activeProject,
    visibilityReport,
  )

  // Browser notifications with project/session routing
  const handleNotificationClick = useCallback((project: string, sessionName: string) => {
    setProjectName(project)
    if (sessionName) {
      setAttachIntent({ token: Date.now(), projectName: project, sessionName })
    }
  }, [])

  const browserNotifications = useBrowserNotifications(handleNotificationClick)

  // Persist project selection
  useEffect(() => {
    saveProject(activeProject)
  }, [activeProject])

  const handleProjectChange = useCallback((name: string) => {
    setProjectName(name)
  }, [])

  const handleAddProject = useCallback(() => {
    setShowAddDialog(true)
  }, [])

  const handleProjectAdded = (name: string) => {
    setShowAddDialog(false)
    refreshProjects()
    setProjectName(name)
    setProjectOrder((currentOrder) => currentOrder.includes(name) ? currentOrder : [...currentOrder, name])
  }

  const handleRemoveProject = useCallback(async (project: Project) => {
    if (!confirm(`Remove project '${project.name}'? (Files on disk are not affected)`)) return
    try {
      await removeProject(project.name)
      refreshProjects()
      setProjectOrder(prev => prev.filter(n => n !== project.name))
      if (activeProject === project.name) {
        const idx = orderedProjects.findIndex(p => p.name === project.name)
        const neighbor = orderedProjects[idx + 1] ?? orderedProjects[idx - 1]
        setProjectName(neighbor?.name ?? '')
      }
    } catch (err) {
      alert(`Failed to remove project: ${err}`)
    }
  }, [orderedProjects, activeProject, refreshProjects])

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

  // Cmd+1-9 switches sidebar project list (no 'all' entry)
  useEffect(() => {
    const projectNames = orderedProjects.map(p => p.name)
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (!/^[1-9]$/.test(event.key)) return

      const index = Number(event.key) - 1
      const targetProject = projectNames[index]
      if (!targetProject) return

      event.preventDefault()
      handleProjectChange(targetProject)
    }

    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [handleProjectChange, orderedProjects])

  return (
    <div className="flex flex-col h-dvh bg-[#fdf6e3]">
      <header className="h-10 shrink-0 flex items-center px-3 gap-2" style={{ backgroundColor: '#EEE8D5', borderBottom: '1px solid #D3CBB7' }}>
        <span className="text-[13px] font-semibold text-[#073642]">Workflow</span>
        <div className="flex-1" />
        {browserNotifications.permission === 'default' && (
          <button
            onClick={browserNotifications.requestPermission}
            className="text-[10px] px-2 py-1 rounded bg-[#268bd2]/10 hover:bg-[#268bd2]/20 text-[#268bd2] border border-[#268bd2]/20 cursor-pointer"
          >
            Enable Alerts
          </button>
        )}
        {browserNotifications.permission === 'denied' && (
          <span className="text-[10px] text-[#93a1a1]">Alerts blocked</span>
        )}
        <button
          onClick={handleAddProject}
          aria-label="Add project"
          title="Add project"
          className="w-7 h-7 rounded-md text-[18px] leading-none font-medium cursor-pointer shrink-0 text-[#586e75] hover:text-[#073642] hover:bg-[#E2D9C2] transition-colors"
        >
          +
        </button>
      </header>

      <main className="flex-1 overflow-hidden">
        {activeProject && (
          <Workspace
            key={activeProject}
            projectName={activeProject}
            projectPath={currentProjectPath}
            projects={orderedProjects}
            activeProject={activeProject}
            projectUnreadCounts={projectUnreadCounts}
            onProjectSelect={handleProjectChange}
            onProjectReorder={handleProjectReorder}
            onProjectRemove={handleRemoveProject}
            onMarkAllRead={markAllRead}
            sessionUnreadCounts={sessionUnreadCounts}
            markSessionRead={markSessionRead}
            onVisibilityReport={setVisibilityReport}
            attachIntent={attachIntent}
          />
        )}
        {!activeProject && (
          <div className="flex items-center justify-center h-full text-[13px]" style={{ color: '#93a1a1' }}>
            <button onClick={handleAddProject} className="px-4 py-2 rounded-md bg-[#268bd2]/10 hover:bg-[#268bd2]/20 text-[#268bd2] cursor-pointer">
              Add a project to get started
            </button>
          </div>
        )}
      </main>

      {showAddDialog && (
        <AddProjectDialog
          onAdded={handleProjectAdded}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  )
}

export default App
