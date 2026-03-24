import { useState } from 'react'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { TaskGraphModel, TaskState, TaskGraphTask } from './taskGraphModel'
import type { Selection } from './taskGraphSelection'

const STATE_COLORS: Record<string, string> = {
  ready: SOLARIZED_LIGHT.blue,
  running: SOLARIZED_LIGHT.yellow,
  done: SOLARIZED_LIGHT.green,
  blocked: SOLARIZED_LIGHT.red,
  cancelled: SOLARIZED_LIGHT.base1,
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Ready',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

const STATE_PRIORITY: Record<string, number> = {
  blocked: 0,
  ready: 1,
  running: 2,
  done: 3,
  cancelled: 4,
}

function StateBadge({ state }: { state: TaskState }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ backgroundColor: STATE_COLORS[state] + '22', color: STATE_COLORS[state] }}
    >
      {STATE_LABELS[state]}
    </span>
  )
}

function CollapsibleSection({ title, count, defaultExpanded, children }: {
  title: string
  count: number
  defaultExpanded?: boolean
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? count <= 5)

  return (
    <div>
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 w-full text-left font-medium mb-1 cursor-pointer"
        style={{ color: SOLARIZED_LIGHT.base1 }}
      >
        <span className="text-[10px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>{title} ({count})</span>
      </button>
      <div style={{
        maxHeight: expanded ? 1000 : 0,
        overflow: 'hidden',
        transition: 'max-height 150ms ease-out',
      }}>
        {children}
      </div>
    </div>
  )
}

function SegmentedProgressBar({ tasks }: { tasks: TaskGraphTask[] }) {
  const total = tasks.length
  if (total === 0) return null

  const counts: Record<string, number> = { done: 0, running: 0, ready: 0, blocked: 0, cancelled: 0 }
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1

  const segments: { state: string; pct: number }[] = []
  for (const state of ['done', 'running', 'ready', 'blocked', 'cancelled']) {
    if (counts[state] > 0) {
      segments.push({ state, pct: (counts[state] / total) * 100 })
    }
  }

  return (
    <div>
      <div className="flex rounded-full overflow-hidden" style={{ height: 6, backgroundColor: SOLARIZED_LIGHT.base2 }}>
        {segments.map(seg => (
          <div
            key={seg.state}
            style={{
              width: `${seg.pct}%`,
              backgroundColor: STATE_COLORS[seg.state],
              transition: 'width 300ms ease-out',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
        {segments.map(seg => (
          <span key={seg.state} className="inline-flex items-center gap-1 text-[11px]" style={{ color: SOLARIZED_LIGHT.base01 }}>
            <span style={{ color: STATE_COLORS[seg.state] }}>{'\u25CF'}</span>
            {counts[seg.state]} {STATE_LABELS[seg.state]?.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  )
}

function DepRow({ task, graph, onNavigate, showState }: {
  task: TaskGraphTask
  graph: TaskGraphModel
  onNavigate: (id: string) => void
  showState?: boolean
}) {
  const milestoneTag = task.topLevelId ? graph.tasks.get(task.topLevelId)?.title : null

  return (
    <button
      onClick={() => onNavigate(task.id)}
      className="flex items-center gap-2 w-full text-left px-2 py-1 rounded cursor-pointer transition-colors"
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = SOLARIZED_LIGHT.listHoverBackground)}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
    >
      <span style={{ color: STATE_COLORS[task.state] }}>{'\u25CF'}</span>
      <span className="flex-1 truncate">{task.title}</span>
      {milestoneTag && (
        <span className="text-[10px] shrink-0" style={{ color: SOLARIZED_LIGHT.base1 }}>
          ({milestoneTag})
        </span>
      )}
      {showState && (
        <span className="text-[11px] shrink-0" style={{ color: STATE_COLORS[task.state] }}>
          {STATE_LABELS[task.state]?.toLowerCase()}
        </span>
      )}
    </button>
  )
}

function TaskDetail({ taskId, graph, onNavigate }: {
  taskId: string
  graph: TaskGraphModel
  onNavigate: (id: string) => void
}) {
  const task = graph.tasks.get(taskId)
  if (!task) return null

  const deps = task.depends.map(id => graph.tasks.get(id)).filter(Boolean) as TaskGraphTask[]
  const dependents = ((graph.dependentsByTask.get(taskId) ?? []).map(id => graph.tasks.get(id)).filter(Boolean)) as TaskGraphTask[]

  return (
    <div className="flex flex-col gap-3 p-3 text-[12px]" style={{ color: SOLARIZED_LIGHT.base01 }}>
      {/* Breadcrumb */}
      {task.topLevelId && (
        <button
          onClick={() => onNavigate(task.topLevelId!)}
          className="text-[11px] text-left cursor-pointer transition-colors"
          style={{ color: SOLARIZED_LIGHT.base1 }}
          onMouseEnter={e => (e.currentTarget.style.color = SOLARIZED_LIGHT.base01)}
          onMouseLeave={e => (e.currentTarget.style.color = SOLARIZED_LIGHT.base1)}
        >
          {'\u25C0'} {graph.tasks.get(task.topLevelId)?.title}
        </button>
      )}

      {/* Title + state */}
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[14px]" style={{ color: SOLARIZED_LIGHT.base02 }}>
          {task.title}
        </span>
        <StateBadge state={task.state} />
      </div>

      {/* Description */}
      {task.description && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Description</div>
          <div style={{ color: SOLARIZED_LIGHT.base00 }}>{task.description}</div>
        </div>
      )}

      {/* Accept criteria */}
      {task.acceptCriteria.length > 0 && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Accept Criteria</div>
          <ul className="list-none pl-0">
            {task.acceptCriteria.map((ac, i) => (
              <li key={i} className="flex items-start gap-1.5 mb-0.5">
                <span style={{ color: SOLARIZED_LIGHT.base1 }}>{'\u2610'}</span>
                <span>{ac}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dependencies */}
      {deps.length > 0 && (
        <CollapsibleSection title="Dependencies" count={deps.length}>
          {deps.map(dep => (
            <DepRow key={dep.id} task={dep} graph={graph} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* Dependents */}
      {dependents.length > 0 && (
        <CollapsibleSection title="Dependents" count={dependents.length}>
          {dependents.map(dep => (
            <DepRow key={dep.id} task={dep} graph={graph} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* Scope */}
      {task.scope.length > 0 && (
        <CollapsibleSection title="Scope" count={task.scope.length}>
          {task.scope.map((s, i) => (
            <div
              key={i}
              className="px-2 py-0.5 rounded text-[11px] font-mono mb-0.5"
              style={{ backgroundColor: SOLARIZED_LIGHT.base2, color: SOLARIZED_LIGHT.base01 }}
            >
              {s}
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* Note */}
      {task.note && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Note</div>
          <div style={{ color: SOLARIZED_LIGHT.base00 }}>{task.note}</div>
        </div>
      )}
    </div>
  )
}

function MilestoneDetail({ milestoneId, graph, onNavigate, isCollapsed, onToggleCollapse }: {
  milestoneId: string
  graph: TaskGraphModel
  onNavigate: (id: string) => void
  isCollapsed: boolean
  onToggleCollapse: (id: string) => void
}) {
  const col = graph.layout.columns.find(c => c.id === milestoneId)
  if (!col) return null

  const msTask = graph.tasks.get(milestoneId)
  const tasks = col.taskIds.map(id => graph.tasks.get(id)).filter(Boolean) as TaskGraphTask[]

  // Sort by state priority then title
  const sortedTasks = [...tasks].sort((a, b) => {
    const sp = (STATE_PRIORITY[a.state] ?? 4) - (STATE_PRIORITY[b.state] ?? 4)
    if (sp !== 0) return sp
    return a.title.localeCompare(b.title)
  })

  // External dependencies: cross-milestone deps aggregated by milestone
  const externalDeps = new Map<string, { milestoneTitle: string; count: number }>()
  for (const task of tasks) {
    for (const depId of task.depends) {
      const depTask = graph.tasks.get(depId)
      if (!depTask) continue
      const depMsId = depTask.topLevelId
      if (depMsId && depMsId !== milestoneId) {
        const existing = externalDeps.get(depMsId)
        if (existing) {
          existing.count++
        } else {
          externalDeps.set(depMsId, {
            milestoneTitle: graph.tasks.get(depMsId)?.title ?? depMsId,
            count: 1,
          })
        }
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-[12px]" style={{ color: SOLARIZED_LIGHT.base01 }}>
      {/* Title + progress + collapse toggle */}
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[14px] flex-1" style={{ color: SOLARIZED_LIGHT.base02 }}>
          {col.title}
        </span>
        <span className="text-[11px]" style={{ color: SOLARIZED_LIGHT.base1 }}>
          {col.progress.done}/{col.progress.total}
        </span>
        {col.taskIds.length > 0 && (
          <button
            onClick={() => onToggleCollapse(milestoneId)}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors"
            style={{ color: SOLARIZED_LIGHT.base1, border: `1px solid ${SOLARIZED_LIGHT.border}` }}
          >
            {isCollapsed ? 'Expand' : 'Collapse'}
          </button>
        )}
      </div>

      {/* Progress bar + legend */}
      <SegmentedProgressBar tasks={tasks} />

      {/* Description */}
      {msTask?.description && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Description</div>
          <div style={{ color: SOLARIZED_LIGHT.base00 }}>{msTask.description}</div>
        </div>
      )}

      {/* Accept criteria */}
      {msTask && msTask.acceptCriteria.length > 0 && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Accept Criteria</div>
          <ul className="list-none pl-0">
            {msTask.acceptCriteria.map((ac, i) => (
              <li key={i} className="flex items-start gap-1.5 mb-0.5">
                <span style={{ color: SOLARIZED_LIGHT.base1 }}>{'\u2610'}</span>
                <span>{ac}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Children */}
      {sortedTasks.length > 0 && (
        <CollapsibleSection title="Children" count={sortedTasks.length}>
          {sortedTasks.map(task => (
            <DepRow key={task.id} task={task} graph={graph} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* External dependencies */}
      {externalDeps.size > 0 && (
        <CollapsibleSection title="External Dependencies" count={externalDeps.size}>
          {Array.from(externalDeps.entries()).map(([msId, { milestoneTitle, count }]) => (
            <button
              key={msId}
              onClick={() => onNavigate(msId)}
              className="flex items-center gap-2 w-full text-left px-2 py-1 rounded cursor-pointer transition-colors"
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = SOLARIZED_LIGHT.listHoverBackground)}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <span style={{ color: SOLARIZED_LIGHT.base1 }}>{'\u2192'}</span>
              <span>{milestoneTitle}</span>
              <span className="text-[10px]" style={{ color: SOLARIZED_LIGHT.base1 }}>
                ({count} task{count !== 1 ? 's' : ''} depend)
              </span>
            </button>
          ))}
        </CollapsibleSection>
      )}

      {/* Note */}
      {msTask?.note && (
        <div>
          <div className="font-medium mb-1" style={{ color: SOLARIZED_LIGHT.base1 }}>Note</div>
          <div style={{ color: SOLARIZED_LIGHT.base00 }}>{msTask.note}</div>
        </div>
      )}
    </div>
  )
}

export function TaskGraphDetailPanel({ selection, graph, isMobile, onClose, onNavigate, collapsedMilestones, onToggleCollapse }: {
  selection: Selection
  graph: TaskGraphModel
  isMobile: boolean
  onClose: () => void
  onNavigate: (id: string) => void
  collapsedMilestones: Set<string>
  onToggleCollapse: (id: string) => void
}) {
  if (!selection) return null

  const content = selection.type === 'task'
    ? <TaskDetail taskId={selection.id} graph={graph} onNavigate={onNavigate} />
    : <MilestoneDetail
        milestoneId={selection.id}
        graph={graph}
        onNavigate={onNavigate}
        isCollapsed={collapsedMilestones.has(selection.id)}
        onToggleCollapse={onToggleCollapse}
      />

  if (isMobile) {
    return (
      <div
        className="absolute bottom-0 left-0 right-0 rounded-t-xl shadow-lg overflow-y-auto z-20"
        style={{
          maxHeight: '40vh',
          backgroundColor: SOLARIZED_LIGHT.base3,
          borderTop: `1px solid ${SOLARIZED_LIGHT.border}`,
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center py-2" onClick={onClose} style={{ cursor: 'pointer' }}>
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: SOLARIZED_LIGHT.base1 }} />
        </div>
        {content}
      </div>
    )
  }

  return (
    <div
      className="shrink-0 overflow-y-auto"
      style={{
        width: 300,
        backgroundColor: SOLARIZED_LIGHT.base3,
        borderLeft: `1px solid ${SOLARIZED_LIGHT.border}`,
        boxShadow: '-2px 0 8px rgba(0,0,0,0.04)',
        transition: 'transform 200ms ease-out',
      }}
    >
      {/* Close button */}
      <div className="flex justify-end p-2">
        <button
          onClick={onClose}
          className="w-6 h-6 rounded text-[14px] cursor-pointer transition-colors"
          style={{ color: SOLARIZED_LIGHT.base1 }}
          title="Close"
        >
          {'\u2715'}
        </button>
      </div>
      {content}
    </div>
  )
}
