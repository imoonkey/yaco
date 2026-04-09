import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Workspace } from './components/Workspace'
import { useProjects, useProgress, useSessions, removeProject, reorderProjects } from './hooks/useApi'
import { AddProjectDialog } from './components/AddProjectDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { NotificationPanel } from './components/NotificationPanel'
import { useNotifications } from './hooks/useNotifications'
import { useKeyboardViewport } from './hooks/useKeyboardViewport'
import { useSessionUnreadState } from './hooks/useSessionUnreadState'
import { toggleTheme } from './lib/theme'
import { Sun, Moon, Bell } from 'lucide-react'
import { Toaster, toast } from 'sonner'
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

const CLOCK_PILL = { backgroundColor: 'var(--sol-base02)', color: 'var(--sol-base2)', boxShadow: 'var(--elevation-1)' }

function Clock({ onPulse }: { onPulse?: (type: 'light' | 'strong') => void }) {
  const [now, setNow] = useState(() => new Date())
  const lastPulseMinRef = useRef(-1)

  useEffect(() => {
    // Align to minute boundary so we never skip :00/:15/:30/:45
    const tick = () => setNow(new Date())
    const msToNextMin = (60 - new Date().getSeconds()) * 1000
    const timeout = setTimeout(() => {
      tick()
      const id = setInterval(tick, 60_000)
      cleanup = () => clearInterval(id)
    }, msToNextMin)
    let cleanup = () => clearTimeout(timeout)
    return () => cleanup()
  }, [])

  useEffect(() => {
    if (!onPulse) return
    const m = now.getMinutes()
    if (m === lastPulseMinRef.current) return
    if (document.visibilityState !== 'visible') return

    if (m === 0 || m === 30) {
      lastPulseMinRef.current = m
      onPulse('strong')
    } else if (m === 15 || m === 45) {
      lastPulseMinRef.current = m
      onPulse('light')
    }
  }, [now, onPulse])

  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' })
  const monthDay = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const dateStr = `${weekday} ${monthDay}`

  return (
    <span className="flex items-center gap-1.5" style={{ fontFamily: 'var(--font-ui)' }}>
      <span className="text-[13px] tracking-tight" style={{ color: 'var(--sol-text-dim)' }}>{dateStr}</span>
      <span
        className="text-[13px] tabular-nums rounded-lg px-2.5 py-0.5"
        style={CLOCK_PILL}
      >
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </span>
  )
}

function App() {
  useKeyboardViewport()
  const [projectName, setProjectName] = useState<string>(loadProject)
  const [projectOrder, setProjectOrder] = useState<string[]>([])
  const [pulseType, setPulseType] = useState<'none' | 'light' | 'strong'>('none')
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const handlePulse = useCallback((type: 'light' | 'strong') => {
    clearTimeout(pulseTimerRef.current)
    setPulseType(type)
    pulseTimerRef.current = setTimeout(() => setPulseType('none'), type === 'light' ? 3000 : 4000)
  }, [])

  const { data: projects, refresh: refreshProjects } = useProjects()
  const { data: progress } = useProgress()
  const { data: allSessions } = useSessions()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<Project | null>(null)

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

  // Per-project session counts: { active, total }
  const projectSessionCounts = useMemo(() => {
    const counts: Record<string, { active: number; total: number }> = {}
    if (!allSessions) return counts
    for (const s of allSessions) {
      const c = counts[s.project] ??= { active: 0, total: 0 }
      c.total++
      if (s.status === 'processing') c.active++
    }
    return counts
  }, [allSessions])

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

  const { notifications, unreadCount, markAllRead: markNotificationsRead, clearAll: clearNotifications } = useNotifications(handleNotificationClick)
  const [showNotifications, setShowNotifications] = useState(false)

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
    setConfirmRemove(project)
  }, [])

  const doRemoveProject = useCallback(async () => {
    const project = confirmRemove
    if (!project) return
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
      toast.error(`Failed to remove project: ${err}`)
    }
  }, [confirmRemove, orderedProjects, activeProject, refreshProjects])

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
      toast.error(`Failed to reorder projects: ${err}`)
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
    <div className="flex flex-col h-dvh bg-[var(--sol-bg)]">
      <div className="hidden md:flex h-10 shrink-0 items-center justify-between px-3" style={{ color: 'var(--sol-text-dim)', fontFamily: 'var(--font-ui)' }}>
        <span className="text-[13px] font-semibold">{activeProject || 'Workflow'}</span>
        <span className="flex items-center gap-2">
          <span className="relative">
            <button
              className="flex items-center justify-center cursor-pointer hover:opacity-80"
              style={{ color: 'var(--sol-text-dim)', transition: 'color 120ms, transform 120ms' }}
              onClick={() => { setShowNotifications(v => !v); if (!showNotifications) markNotificationsRead() }}
              title="Notifications"
            >
              <Bell size={15} />
            </button>
            {unreadCount > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full text-[8px] font-bold text-white flex items-center justify-center px-0.5"
                style={{ backgroundColor: 'var(--sol-orange)' }}
              >
                {unreadCount}
              </span>
            )}
            {showNotifications && (
              <NotificationPanel
                notifications={notifications}
                onClickItem={(n) => { handleNotificationClick(n.project, n.sessionName); setShowNotifications(false) }}
                onMarkAllRead={markNotificationsRead}
                onClearAll={clearNotifications}
                onClose={() => setShowNotifications(false)}
              />
            )}
          </span>
          <span className="theme-toggle inline-flex rounded border border-[var(--sol-border)] p-0.5 cursor-pointer" onClick={toggleTheme} title="Toggle theme">
            <span className="icon-sun rounded px-1.5 py-0.5 leading-none transition-colors flex items-center justify-center"><Sun size={14} strokeWidth={2.5} /></span>
            <span className="icon-moon rounded px-1.5 py-0.5 leading-none transition-colors flex items-center justify-center"><Moon size={14} strokeWidth={2.5} /></span>
          </span>
          <Clock onPulse={handlePulse} />
        </span>
      </div>
      <main className="flex-1 overflow-hidden">
        {activeProject && (
          <Workspace
            key={activeProject}
            projectName={activeProject}
            projectPath={currentProjectPath}
            projects={orderedProjects}
            activeProject={activeProject}
            projectUnreadCounts={projectUnreadCounts}
            projectSessionCounts={projectSessionCounts}
            onProjectSelect={handleProjectChange}
            onProjectReorder={handleProjectReorder}
            onProjectRemove={handleRemoveProject}
            onAddProject={handleAddProject}
            onMarkAllRead={markAllRead}
            sessionUnreadCounts={sessionUnreadCounts}
            markSessionRead={markSessionRead}
            onVisibilityReport={setVisibilityReport}
            attachIntent={attachIntent}
            clearAttachIntent={() => setAttachIntent(null)}
          />
        )}
        {!activeProject && (
          <div className="flex items-center justify-center h-full text-[13px]" style={{ color: 'var(--sol-muted)' }}>
            <button onClick={handleAddProject} className="px-4 py-2 rounded-md bg-[var(--sol-blue)]/10 hover:bg-[var(--sol-blue)]/20 text-[var(--sol-blue)] cursor-pointer">
              Add a project to get started
            </button>
          </div>
        )}
      </main>
      <div className="hidden md:flex h-10 shrink-0 items-center justify-between px-3" style={{ color: 'var(--sol-text-dim)', fontFamily: 'var(--font-ui)' }}>
        <span className="text-[13px] font-semibold">{activeProject || 'Workflow'}</span>
        <Clock />
      </div>

      {showAddDialog && (
        <AddProjectDialog
          onAdded={handleProjectAdded}
          onClose={() => setShowAddDialog(false)}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove '${confirmRemove.name}'?`}
          description="Files on disk are not affected."
          confirmLabel="Remove"
          danger
          onConfirm={doRemoveProject}
          onClose={() => setConfirmRemove(null)}
        />
      )}

      {pulseType !== 'none' && (
        <div
          data-rhythm-pulse
          className="fixed inset-0 pointer-events-none z-50"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 40%, rgba(181, 137, 0, 0.5) 100%)',
            opacity: pulseType === 'light' ? 0.35 : 0.7,
            animation: `rhythm-pulse ${pulseType === 'light' ? '3s' : '4s'} ease-in-out forwards`,
          }}
        />
      )}

      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--sol-editor-bg)',
            color: 'var(--sol-text)',
            border: '1px solid var(--sol-border)',
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            cursor: 'pointer',
          },
        }}
      />
    </div>
  )
}

export default App
