import { useState } from 'react'
import { useWorkstreams, updateWorkstreamStatus } from '../hooks/useApi'
import type { WorkstreamStatus, Checkpoint } from '../types'

const statusBadge: Record<WorkstreamStatus, { label: string; text: string; bg: string }> = {
  active:       { label: 'Active',  text: 'text-[#859900]', bg: 'bg-[#859900]/10' },
  human_review: { label: 'Review',  text: 'text-[#6c71c4]', bg: 'bg-[#6c71c4]/10' },
  blocked:      { label: 'Blocked', text: 'text-[#dc322f]', bg: 'bg-[#dc322f]/10' },
  parked:       { label: 'Parked',  text: 'text-[#93a1a1]', bg: 'bg-[#93a1a1]/8' },
  done:         { label: 'Done',    text: 'text-[#268bd2]', bg: 'bg-[#268bd2]/10' },
}

// Human-only statuses that can be set from the UI
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
  const [showActions, setShowActions] = useState(false)
  const badge = statusBadge[ws.status]

  return (
    <div
      className="border border-[#eee8d5] rounded-lg p-4 hover:border-[#93a1a1]/40 cursor-pointer transition-colors bg-[#fdf6e3]"
      onClick={() => setShowActions(!showActions)}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm text-[#073642] font-medium">{ws.name}</div>
          <div className="text-[11px] text-[#93a1a1] mt-0.5">
            {ws.project} — doc/todo/{ws.id}/{ws.doc ?? ''}
          </div>
        </div>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${badge.text} ${badge.bg}`}>
          {badge.label}
        </span>
      </div>
      {ws.checkpoints.length > 0 && (
        <div className="flex items-center gap-3 mt-3">
          <CheckpointDots checkpoints={ws.checkpoints} />
          <span className="text-[11px] text-[#93a1a1]">
            {ws.checkpoints.filter(c => c.done).length}/{ws.checkpoints.length} checkpoints
          </span>
        </div>
      )}
      {showActions && (
        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-[#eee8d5]">
          {humanStatuses.filter(s => s !== ws.status).map(s => (
            <button
              key={s}
              onClick={(e) => { e.stopPropagation(); onStatusChange(ws.project, ws.id, s) }}
              className={`text-[10px] px-2 py-0.5 rounded border cursor-pointer ${statusBadge[s].text} ${statusBadge[s].bg} border-[#93a1a1]/20 hover:border-[#93a1a1]/40`}
            >
              {statusBadge[s].label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function RoadmapView({ filterProject }: { filterProject: string | null }) {
  const { data: workstreams, refresh } = useWorkstreams()
  const all = workstreams ?? []

  const filtered = filterProject ? all.filter(w => w.project === filterProject) : all

  const grouped: Record<string, typeof all> = { active: [], human_review: [], blocked: [], parked: [], done: [] }
  for (const ws of filtered) {
    grouped[ws.status]?.push(ws)
  }

  const sections: { key: WorkstreamStatus; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'human_review', label: 'Human Review' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'parked', label: 'Parked' },
    { key: 'done', label: 'Done' },
  ]

  const activeCount = filtered.filter(w => w.status === 'active' || w.status === 'human_review' || w.status === 'blocked').length

  const handleStatusChange = async (project: string, id: string, status: WorkstreamStatus) => {
    await updateWorkstreamStatus(project, id, status)
    refresh()
  }

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-base font-medium text-[#073642] mb-1">Roadmap</h2>
      <p className="text-[12px] text-[#93a1a1] mb-5">
        {activeCount} active workstreams
        <span className="ml-1 text-[#b58900]">— from doc/todo/*/workstream.json</span>
      </p>

      {filtered.length === 0 && (
        <div className="text-[12px] text-[#93a1a1] py-8 text-center">No workstreams found</div>
      )}

      {sections.map(({ key, label }) => {
        const items = grouped[key]
        if (!items || items.length === 0) return null
        return (
          <div key={key} className="mb-6">
            <div className="text-[11px] text-[#93a1a1] uppercase tracking-wide mb-2">{label}</div>
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
}
