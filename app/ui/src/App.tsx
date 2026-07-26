import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Workspace } from './components/Workspace'
import { useProjects, useSessions, useUsage, removeProject, reorderProjects } from './hooks/useApi'
import { useProjectWorktrees } from './hooks/useProjectWorktrees'
import { AddProjectDialog } from './components/AddProjectDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { UsageQuotaRail } from './components/UsageQuotaRail'
import { NotificationBell } from './components/NotificationBell'
import { ChannelsHeaderButton } from './components/WeChatLoginDialog'
import { useAttention, type AttentionItem } from './hooks/useAttention'
import { useSpeech } from './hooks/useSpeech'
import { speechTextFor } from './lib/attentionContent'
import { useKeyboardViewport } from './hooks/useKeyboardViewport'
import { useIsMobile } from './hooks/useIsMobile'
import { toggleTheme } from './lib/theme'
import { computeProjectSessionCounts } from './lib/sessionCounts'
import { Sun, Moon } from 'lucide-react'
import { Toaster, toast } from 'sonner'
import type { WorkspaceVisibilityReport, AttachSessionIntent } from './workspace/visibility'
import type { Project } from './types'

const STORAGE_KEY = 'yaco-ui-state'

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

function loadWorktree(project: string): string | null {
  return localStorage.getItem(`yaco-worktree:${project}`)
}

function saveWorktree(project: string, wt: string | null) {
  if (wt) localStorage.setItem(`yaco-worktree:${project}`, wt)
  else localStorage.removeItem(`yaco-worktree:${project}`)
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
    <span className="flex items-center gap-1.5">
      <span className="text-ui-lg tracking-tight" style={{ color: 'var(--sol-text-dim)' }}>{dateStr}</span>
      <span
        className="text-ui-lg tabular-nums rounded-lg px-2.5 py-0.5"
        style={CLOCK_PILL}
      >
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </span>
  )
}

function App() {
  useKeyboardViewport()
  const isMobile = useIsMobile()
  const [projectName, setProjectName] = useState<string>(loadProject)
  const [projectOrder, setProjectOrder] = useState<string[]>([])
  const [pulseType, setPulseType] = useState<'none' | 'light' | 'strong'>('none')
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handlePulse = useCallback((type: 'light' | 'strong') => {
    clearTimeout(pulseTimerRef.current)
    setPulseType(type)
    pulseTimerRef.current = setTimeout(() => setPulseType('none'), type === 'light' ? 3000 : 4000)
  }, [])

  const { data: projects, refresh: refreshProjects } = useProjects()
  const { data: allSessions } = useSessions()
  const usage = useUsage()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<Project | null>(null)

  // App/Workspace bridge state
  const [visibilityReport, setVisibilityReport] = useState<WorkspaceVisibilityReport | null>(null)
  const [attachIntent, setAttachIntent] = useState<AttachSessionIntent | null>(null)
  // Stable, App-owned top-bar slot the workspace portals its desktop voice control
  // into (the control lives inside the workspace provider; the slot is App chrome).
  const [voiceSlot, setVoiceSlot] = useState<HTMLSpanElement | null>(null)

  // Reconcile saved project order with the live project list (adjust during render).
  const [prevProjects, setPrevProjects] = useState(projects)
  if (projects !== prevProjects) {
    setPrevProjects(projects)
    if (projects) {
      const names = projects.map((project) => project.name)
      setProjectOrder((currentOrder) => {
        const remaining = new Set(names)
        const nextOrder = currentOrder.filter((name) => remaining.delete(name))
        nextOrder.push(...names.filter((name) => remaining.has(name)))
        return arraysEqual(currentOrder, nextOrder) ? currentOrder : nextOrder
      })
    }
  }

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

  // Worktree state for the active project
  const [activeWorktree, setActiveWorktree] = useState<string | null>(null)
  const worktrees = useProjectWorktrees(activeProject || null)

  // Worktree reset + validation are coupled with the async worktree list
  // (useProjectWorktrees); keep the original effect timing to preserve restore-on-switch
  // behavior rather than collapse it into render.
  /* eslint-disable react-hooks/set-state-in-effect */
  // Reset worktree when project changes; restore from localStorage
  useEffect(() => {
    if (!activeProject) { setActiveWorktree(null); return }
    setActiveWorktree(loadWorktree(activeProject))
  }, [activeProject])

  // Validate activeWorktree (an abspath) is still a registered worktree. Guard on a
  // loaded list: `worktrees` is briefly [] while useProjectWorktrees refetches on a
  // project switch, and clearing then would drop a valid restored selection. The
  // git-sourced list always has >=1 entry (the primary) once loaded, so length>0
  // distinguishes "loaded, selection gone" (clear) from "not loaded yet" (wait).
  useEffect(() => {
    if (!activeWorktree || worktrees.length === 0) return
    if (!worktrees.some(w => w.id === activeWorktree)) {
      setActiveWorktree(null)
    }
  }, [activeWorktree, worktrees])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist worktree selection
  useEffect(() => {
    if (!activeProject) return
    saveWorktree(activeProject, activeWorktree)
  }, [activeProject, activeWorktree])

  // Per-project session counts: { active, total }
  const projectSessionCounts = useMemo(
    () => allSessions ? computeProjectSessionCounts(allSessions) : {},
    [allSessions],
  )

  const currentProjectPath = orderedProjects.find(p => p.name === activeProject)?.path ?? ''

  // Attention routing: clicking an item (toast / OS notification / bell row)
  // switches to its project and attaches the session (if any).
  const handleNotificationClick = useCallback((item: AttentionItem) => {
    const s = item.subject
    setProjectName(s.project)
    const sessionName = s.kind === 'session' ? s.sessionName : s.sessionNames[0]
    if (sessionName) {
      setAttachIntent({ token: Date.now(), projectName: s.project, sessionName })
    }
  }, [])

  // The active-viewing target (visible + focused + attached session) whose
  // interrupts useAttention suppresses and auto-acks. Derived from the
  // workspace's visibility report (its attached + shown session).
  const activeTarget = useMemo(
    () => (visibilityReport?.attachedSession && visibilityReport.terminalVisible
      ? { project: visibilityReport.projectName, sessionName: visibilityReport.attachedSession }
      : null),
    [visibilityReport],
  )

  // Facet B — server-projected attention feed (bell sections, badges, interrupts).
  // Voice read-back speaks the freshly-surfaced batch when foreground (useSpeech
  // gates on enabled/supported, so this is a cheap no-op when off).
  const { supported: speechSupported, enabled: speechEnabled, setEnabled: setSpeechEnabled, speak } = useSpeech()
  const speakItems = useCallback(
    (items: AttentionItem[]) => speak(speechTextFor(items)),
    [speak],
  )
  const attention = useAttention(activeTarget, handleNotificationClick, speakItems)
  const { snapshot, ackSession, ackTask, clear, dismissNeedsYou, requestPermission } = attention

  const notificationBellProps = {
    snapshot,
    onItemClick: handleNotificationClick,
    ackSession,
    ackTask,
    dismissNeedsYou,
    clear,
    requestPermission,
    voiceReadback: { supported: speechSupported, enabled: speechEnabled, setEnabled: setSpeechEnabled },
  }

  // Project-list "Mark All Read" (per project, from the sidebar menu). Same contract
  // as the bell-panel mark-all-read, scoped to one project: dismiss every surfaced
  // Needs-you (ACT) row by its own generation and ack every surfaced Ready (REVIEW)
  // row by its subject. Deliberately NOT `ackProject` — a project-scoped
  // projectReadAt advance could pre-suppress a delegated block that escalates later
  // (design r1 MAJOR-3) — and not recentClearedAt. REVIEW rows are still marked read
  // via the per-subject acks, so nothing regresses.
  const handleProjectMarkAllRead = useCallback((project: string) => {
    for (const item of snapshot.needsYou) {
      if (item.subject.project === project) dismissNeedsYou(item)
    }
    for (const item of snapshot.ready) {
      const s = item.subject
      if (s.project !== project) continue
      if (s.kind === 'session') ackSession(s.project, s.sessionName)
      else ackTask(s.project, s.taskId)
    }
  }, [snapshot.needsYou, snapshot.ready, dismissNeedsYou, ackSession, ackTask])

  // Owned-idle leaf "↩ your turn" set: `proj::name` for every session that has
  // an unacked owned REVIEW (a `session_idle` Ready item). The dot is never
  // recolored — this is a separate leaf chip (spec §5.6, OQ4).
  const readySessionKeys = useMemo(() => {
    const set = new Set<string>()
    for (const item of snapshot.ready) {
      if (item.type !== 'session_idle') continue
      const s = item.subject
      if (s.kind === 'session') set.add(`${s.project}::${s.sessionName}`)
    }
    return set
  }, [snapshot.ready])

  // Task chips for the active project's graph. The "blocked" chip lights ONLY from
  // a LIVE Needs-you `task_blocked` — a dismissed or resolved one falls to Recent
  // (muted past-tense) or is tombstoned, so reading `recent`/`ready` would wrongly
  // keep the chip lit. The "done" chip lights from a `task_done` that reached
  // Ready or Recent. Keyed by task id.
  const attentionTaskIds = useMemo(() => {
    const blocked = new Set<string>()
    const done = new Set<string>()
    const addDone = (item: AttentionItem) => {
      const s = item.subject
      if (s.kind === 'task' && s.project === activeProject && item.type === 'task_done') done.add(s.taskId)
    }
    for (const item of snapshot.needsYou) {
      const s = item.subject
      if (s.kind === 'task' && s.project === activeProject && item.type === 'task_blocked') blocked.add(s.taskId)
    }
    for (const item of snapshot.ready) addDone(item)
    for (const item of snapshot.recent) addDone(item)
    return { blocked, done }
  }, [snapshot, activeProject])

  // Persist project selection
  useEffect(() => {
    saveProject(activeProject)
  }, [activeProject])

  const handleProjectChange = useCallback((name: string) => {
    setProjectName(name)
  }, [])

  const handleWorktreeSelect = useCallback((id: string | null) => {
    setActiveWorktree(id)
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
    <div className="flex flex-col h-full bg-[var(--sol-bg)]">
      {!isMobile && (
        <div className="flex h-10 shrink-0 items-center justify-between px-3" style={{ color: 'var(--sol-text-dim)' }}>
          <span className="text-ui-lg font-semibold">{activeProject || 'YACO'}</span>
          <UsageQuotaRail state={usage} />
          <span className="flex items-center gap-2">
            <span ref={setVoiceSlot} className="flex items-center" />
            <NotificationBell {...notificationBellProps} />
            <ChannelsHeaderButton />
            <span className="theme-toggle inline-flex rounded border border-[var(--sol-border)] p-0.5 cursor-pointer" onClick={toggleTheme} title="Toggle theme" role="button" aria-label="Toggle theme">
              <span className="icon-sun rounded px-1.5 py-0.5 leading-none transition-colors flex items-center justify-center"><Sun size={14} strokeWidth={2.5} /></span>
              <span className="icon-moon rounded px-1.5 py-0.5 leading-none transition-colors flex items-center justify-center"><Moon size={14} strokeWidth={2.5} /></span>
            </span>
            <Clock onPulse={handlePulse} />
          </span>
        </div>
      )}
      <main className="flex-1 overflow-hidden">
        {activeProject && (
          <Workspace
            key={activeProject}
            projectName={activeProject}
            projectPath={currentProjectPath}
            worktree={activeWorktree}
            worktrees={worktrees}
            activeWorktree={activeWorktree}
            onWorktreeSelect={handleWorktreeSelect}
            projects={orderedProjects}
            activeProject={activeProject}
            badgesByProject={snapshot.badgesByProject}
            badgesBySession={snapshot.badgesBySession}
            readySessionKeys={readySessionKeys}
            attentionTaskIds={attentionTaskIds}
            projectSessionCounts={projectSessionCounts}
            onProjectSelect={handleProjectChange}
            onProjectReorder={handleProjectReorder}
            onProjectRemove={handleRemoveProject}
            onAddProject={handleAddProject}
            onMarkAllRead={handleProjectMarkAllRead}
            ackSession={ackSession}
            onVisibilityReport={setVisibilityReport}
            attachIntent={attachIntent}
            clearAttachIntent={() => setAttachIntent(null)}
            notificationBell={<NotificationBell {...notificationBellProps} size={14} />}
            voiceSlot={voiceSlot}
          />
        )}
        {!activeProject && (
          <div className="flex items-center justify-center h-full text-ui-lg" style={{ color: 'var(--sol-muted)' }}>
            <button onClick={handleAddProject} className="px-4 py-2 rounded-md bg-[var(--sol-blue)]/10 hover:bg-[var(--sol-blue)]/20 text-[var(--sol-blue)] cursor-pointer">
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
            background: 'radial-gradient(ellipse at center, transparent 40%, color-mix(in srgb, var(--sol-yellow) 50%, transparent) 100%)',
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
            borderRadius: 8,
            fontSize: 'var(--text-ui-md)',
            cursor: 'pointer',
          },
        }}
      />
    </div>
  )
}

export default App
