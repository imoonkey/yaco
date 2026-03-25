import { useState } from 'react'
import { useSessions, useProgress, useWorkstreams, dismissProgress as apiDismiss, updateWorkstreamStatus } from '../hooks/useApi'
import { useIsMobile } from '../hooks/useIsMobile'
import type { ProgressEntry, ProgressType, AgentSession, SessionStatus, WorkstreamStatus, Checkpoint } from '../types'
import { ProviderIcon } from './SessionIcons'
import { PaneSwitch } from './PaneSwitch'

type MonitorPane = 'sessions' | 'notifications' | 'roadmap'

// --- Notifications ---
const typeConfig: Record<ProgressType, { label: string; text: string; bg: string; border: string }> = {
  blocked:      { label: 'BLOCKED', text: 'text-[#dc322f]', bg: 'bg-[#dc322f]/8',  border: 'border-[#dc322f]/20' },
  human_review: { label: 'REVIEW',  text: 'text-[#6c71c4]', bg: 'bg-[#6c71c4]/8',  border: 'border-[#6c71c4]/20' },
  info:         { label: 'INFO',    text: 'text-[#268bd2]', bg: 'bg-[#268bd2]/5',   border: 'border-[#268bd2]/15' },
  session_idle: { label: 'IDLE',    text: 'text-[#859900]', bg: 'bg-[#859900]/5',   border: 'border-[#859900]/15' },
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function NotificationCard({ entry, onDismiss }: { entry: ProgressEntry; onDismiss: () => void }) {
  const cfg = typeConfig[entry.type]
  const isDismissed = entry.status === 'dismissed'
  return (
    <div className={`border rounded-lg p-3 ${cfg.bg} ${cfg.border} ${isDismissed ? 'opacity-35' : ''}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cfg.text} bg-[#fdf6e3]/80`}>{cfg.label}</span>
          <span className="text-[10px] text-[#93a1a1] uppercase">{entry.agent}</span>
        </div>
        <span className="text-[10px] text-[#93a1a1]">{timeAgo(entry.timestamp)}</span>
      </div>
      <div className="text-[12px] text-[#073642] mb-1.5">{entry.message}</div>
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-[#93a1a1]">
          {entry.project} / {entry.workstream}
        </div>
        {!isDismissed && (
          <button
            onClick={onDismiss}
            className="text-[10px] px-2 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/30 text-[#586e75] cursor-pointer"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

// --- Sessions ---
const statusDisplay: Record<SessionStatus, { label: string; text: string; dot: string }> = {
  processing: { label: 'Running', text: 'text-[#2aa198]', dot: 'bg-[#2aa198] status-pulse' },
  idle:       { label: 'Idle',    text: 'text-[#93a1a1]', dot: 'bg-[#93a1a1]' },
}

function SessionCard({ session }: { session: AgentSession }) {
  const cfg = statusDisplay[session.status]
  return (
    <div className="border border-[#eee8d5] rounded-lg p-3 cursor-pointer hover:border-[#93a1a1]/40 transition-colors bg-[#fdf6e3]">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
        <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
        <span className={`text-[11px] font-bold uppercase ${cfg.text}`}>{cfg.label}</span>
      </div>
      <div className="text-[12px] text-[#073642] mt-1">{session.name}</div>
    </div>
  )
}

// --- Roadmap (inline) ---
const statusBadge: Record<WorkstreamStatus, { label: string; text: string; bg: string }> = {
  active:       { label: 'Active',  text: 'text-[#859900]', bg: 'bg-[#859900]/10' },
  human_review: { label: 'Review',  text: 'text-[#6c71c4]', bg: 'bg-[#6c71c4]/10' },
  blocked:      { label: 'Blocked', text: 'text-[#dc322f]', bg: 'bg-[#dc322f]/10' },
  parked:       { label: 'Parked',  text: 'text-[#93a1a1]', bg: 'bg-[#93a1a1]/8' },
  done:         { label: 'Done',    text: 'text-[#268bd2]', bg: 'bg-[#268bd2]/10' },
}

const humanStatuses: WorkstreamStatus[] = ['active', 'parked', 'done']

function CheckpointDots({ checkpoints }: { checkpoints: Checkpoint[] }) {
  return (
    <div className="flex items-center gap-1">
      {checkpoints.map((cp, i) => (
        <div
          key={i}
          className={`w-2 h-2 rounded-full ${cp.done ? 'bg-[#859900]' : 'bg-[#eee8d5] border border-[#93a1a1]/40'}`}
          title={cp.label}
        />
      ))}
    </div>
  )
}

function WorkstreamRow({ ws, onStatusChange }: {
  ws: { id: string; name: string; status: WorkstreamStatus; project: string; doc?: string; checkpoints: Checkpoint[] }
  onStatusChange: (project: string, id: string, status: WorkstreamStatus) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const badge = statusBadge[ws.status]

  return (
    <div
      className="border border-[#eee8d5] rounded-lg p-3 hover:border-[#93a1a1]/40 cursor-pointer transition-colors bg-[#fdf6e3]"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="text-[12px] text-[#073642] font-medium">{ws.name}</div>
          <div className="text-[10px] text-[#93a1a1] mt-0.5">{ws.project}</div>
        </div>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.text} ${badge.bg}`}>
          {badge.label}
        </span>
      </div>
      {ws.checkpoints.length > 0 && !expanded && (
        <div className="flex items-center gap-2 mt-2">
          <CheckpointDots checkpoints={ws.checkpoints} />
          <span className="text-[10px] text-[#93a1a1]">
            {ws.checkpoints.filter(c => c.done).length}/{ws.checkpoints.length}
          </span>
        </div>
      )}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-[#eee8d5] space-y-2">
          {ws.checkpoints.map((cp, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${
                cp.done ? 'bg-[#859900] border-[#859900]' : 'border-[#93a1a1]/40'
              }`}>
                {cp.done && <span className="text-white text-[8px]">✓</span>}
              </span>
              <span className={cp.done ? 'text-[#93a1a1] line-through' : 'text-[#073642]'}>{cp.label}</span>
              {cp.need_human_review && (
                <span className="text-[9px] px-1 rounded bg-[#6c71c4]/10 text-[#6c71c4]">review</span>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1 pt-1">
            {humanStatuses.filter(s => s !== ws.status).map(s => (
              <button
                key={s}
                onClick={(e) => { e.stopPropagation(); onStatusChange(ws.project, ws.id, s) }}
                className={`text-[9px] px-2 py-0.5 rounded border cursor-pointer ${statusBadge[s].text} ${statusBadge[s].bg} border-[#93a1a1]/20 hover:border-[#93a1a1]/40`}
              >
                {statusBadge[s].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Three-column Monitor ---
export function Monitor({ filterProject, browserNotifications }: {
  filterProject: string | null
  browserNotifications: { permission: NotificationPermission | 'unsupported'; requestPermission: () => void }
}) {
  const isMobile = useIsMobile()
  const [mobilePane, setMobilePane] = useState<MonitorPane>('notifications')
  const { data: sessions } = useSessions()
  const { data: progress, refresh: refreshProgress } = useProgress()
  const { data: workstreams, refresh: refreshWorkstreams } = useWorkstreams()

  // Sessions
  const allSessions = filterProject
    ? (sessions ?? []).filter(s => s.project === filterProject)
    : (sessions ?? [])
  const processing = allSessions.filter(s => s.status === 'processing')
  const idle = allSessions.filter(s => s.status === 'idle')

  // Notifications
  const allProgress = filterProject
    ? (progress ?? []).filter(e => e.project === filterProject)
    : (progress ?? [])
  const activeEntries = allProgress.filter(e => e.status === 'active')
  const dismissedEntries = allProgress.filter(e => e.status === 'dismissed')

  // Workstreams
  const allWorkstreams = filterProject
    ? (workstreams ?? []).filter(w => w.project === filterProject)
    : (workstreams ?? [])
  const grouped: Record<string, typeof allWorkstreams> = { active: [], human_review: [], blocked: [], parked: [], done: [] }
  for (const ws of allWorkstreams) {
    grouped[ws.status]?.push(ws)
  }
  const sections: { key: WorkstreamStatus; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'human_review', label: 'Human Review' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'parked', label: 'Parked' },
    { key: 'done', label: 'Done' },
  ]

  const handleDismiss = async (entry: ProgressEntry) => {
    await apiDismiss(entry.project, entry.workstream, entry.id)
    refreshProgress()
  }

  const handleStatusChange = async (project: string, id: string, status: WorkstreamStatus) => {
    await updateWorkstreamStatus(project, id, status)
    refreshWorkstreams()
  }

  const sessionsPane = (
    <div className="h-full overflow-y-auto p-5">
      <h2 className="text-base font-medium text-[#073642] mb-1">Sessions</h2>
      <p className="text-[12px] text-[#93a1a1] mb-4">
        {processing.length} processing, {idle.length} idle
      </p>

      {allSessions.length === 0 && (
        <div className="text-[12px] text-[#93a1a1] py-8 text-center">No active sessions</div>
      )}

      {processing.length > 0 && (
        <>
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Processing</div>
          <div className="space-y-2 mb-5">{processing.map(s => <SessionCard key={s.name} session={s} />)}</div>
        </>
      )}
      {idle.length > 0 && (
        <>
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Idle</div>
          <div className="space-y-2">{idle.map(s => <SessionCard key={s.name} session={s} />)}</div>
        </>
      )}
    </div>
  )

  const notificationsPane = (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-medium text-[#073642]">Notifications</h2>
        {browserNotifications.permission === 'default' && (
          <button
            onClick={browserNotifications.requestPermission}
            className="text-[10px] px-2 py-1 rounded bg-[#268bd2]/10 hover:bg-[#268bd2]/20 text-[#268bd2] border border-[#268bd2]/20 cursor-pointer"
          >
            Enable Browser Alerts
          </button>
        )}
        {browserNotifications.permission === 'denied' && (
          <span className="text-[10px] text-[#93a1a1]">Browser alerts blocked</span>
        )}
      </div>
      <p className="text-[12px] text-[#93a1a1] mb-4">
        {activeEntries.length} active
      </p>

      {activeEntries.length === 0 && dismissedEntries.length === 0 && (
        <div className="text-[12px] text-[#93a1a1] py-8 text-center">No notifications</div>
      )}

      {activeEntries.length > 0 && (
        <div className="space-y-2 mb-5">
          {activeEntries.map(e => <NotificationCard key={e.id} entry={e} onDismiss={() => handleDismiss(e)} />)}
        </div>
      )}

      {dismissedEntries.length > 0 && (
        <>
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">Dismissed</div>
          <div className="space-y-2">
            {dismissedEntries.map(e => <NotificationCard key={e.id} entry={e} onDismiss={() => {}} />)}
          </div>
        </>
      )}
    </div>
  )

  const roadmapPane = (
    <div className="h-full overflow-y-auto p-5">
      <h2 className="text-base font-medium text-[#073642] mb-1">Roadmap</h2>
      <p className="text-[12px] text-[#93a1a1] mb-4">
        {allWorkstreams.filter(w => w.status !== 'done' && w.status !== 'parked').length} active workstreams
      </p>

      {allWorkstreams.length === 0 && (
        <div className="text-[12px] text-[#93a1a1] py-8 text-center">No workstreams</div>
      )}

      {sections.map(({ key, label }) => {
        const items = grouped[key]
        if (!items || items.length === 0) return null
        return (
          <div key={key} className="mb-4">
            <div className="text-[10px] text-[#93a1a1] uppercase tracking-wide mb-2">{label}</div>
            <div className="space-y-2">
              {items.map(ws => (
                <WorkstreamRow key={`${ws.project}-${ws.id}`} ws={ws} onStatusChange={handleStatusChange} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )

  if (isMobile) {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 border-b border-[#eee8d5] px-3 py-2 bg-[#fdf6e3]">
          <PaneSwitch
            options={[
              { id: 'sessions', label: 'Sessions' },
              { id: 'notifications', label: 'Notifications' },
              { id: 'roadmap', label: 'Roadmap' },
            ]}
            value={mobilePane}
            onChange={(value) => setMobilePane(value as MonitorPane)}
          />
        </div>
        <div className="flex-1 min-h-0">
          {mobilePane === 'sessions' && sessionsPane}
          {mobilePane === 'notifications' && notificationsPane}
          {mobilePane === 'roadmap' && roadmapPane}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* Left: Sessions */}
      <div className="w-1/3 border-r border-[#eee8d5] min-h-0">{sessionsPane}</div>

      {/* Center: Notifications */}
      <div className="w-1/3 border-r border-[#eee8d5] min-h-0">{notificationsPane}</div>

      {/* Right: Roadmap */}
      <div className="w-1/3 min-h-0">{roadmapPane}</div>
    </div>
  )
}
