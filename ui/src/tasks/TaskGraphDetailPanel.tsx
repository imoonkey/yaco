import { useState } from 'react'
import type { TaskGraphModel, TaskState, TaskGraphTask } from './taskGraphModel'
import type { Selection } from './taskGraphSelection'
import { STATE_COLORS } from './taskGraphConstants'

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
        style={{ color: 'var(--sol-base1)' }}
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
      <div className="flex rounded-full overflow-hidden" style={{ height: 6, backgroundColor: 'var(--sol-header-bg)' }}>
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
          <span key={seg.state} className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--sol-base01)' }}>
            <span style={{ color: STATE_COLORS[seg.state] }}>{'\u25CF'}</span>
            {counts[seg.state]} {STATE_LABELS[seg.state]?.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  )
}

function DepRow({ task, onNavigate, showState }: {
  task: TaskGraphTask
  onNavigate: (id: string) => void
  showState?: boolean
}) {
  return (
    <button
      onClick={() => onNavigate(task.id)}
      className="flex items-center gap-2 w-full text-left px-2 py-1 rounded cursor-pointer transition-colors"
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-list-hover-bg)')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
    >
      <span style={{ color: STATE_COLORS[task.state] }}>{'\u25CF'}</span>
      <span className="flex-1 truncate">{task.title}</span>
      {showState && (
        <span className="text-[11px] shrink-0" style={{ color: STATE_COLORS[task.state] }}>
          {STATE_LABELS[task.state]?.toLowerCase()}
        </span>
      )}
    </button>
  )
}

// Build full breadcrumb chain (clickable ancestor path)
function Breadcrumb({ taskId, graph, onNavigate }: {
  taskId: string
  graph: TaskGraphModel
  onNavigate: (id: string) => void
}) {
  const ancestors: { id: string; title: string }[] = []
  let current = graph.tasks.get(taskId)?.parent
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const t = graph.tasks.get(current)
    if (!t) break
    ancestors.unshift({ id: current, title: t.title })
    current = t.parent
  }

  if (ancestors.length === 0) return null

  return (
    <div className="flex items-center gap-1 flex-wrap text-[11px]" style={{ color: 'var(--sol-base1)' }}>
      {ancestors.map((a, i) => (
        <span key={a.id} className="flex items-center gap-1">
          {i > 0 && <span>{'\u203A'}</span>}
          <button
            onClick={() => onNavigate(a.id)}
            className="cursor-pointer transition-colors"
            style={{ color: 'var(--sol-base1)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--sol-base01)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--sol-base1)')}
          >
            {a.title}
          </button>
        </span>
      ))}
    </div>
  )
}

function TaskDetailView({ taskId, graph, onNavigate, collapsedTaskIds, onToggleCollapse }: {
  taskId: string
  graph: TaskGraphModel
  onNavigate: (id: string) => void
  collapsedTaskIds: Set<string>
  onToggleCollapse: (id: string) => void
}) {
  const task = graph.tasks.get(taskId)
  if (!task) return null

  const deps = task.depends.map(id => graph.tasks.get(id)).filter(Boolean) as TaskGraphTask[]
  const dependents = ((graph.dependentsByTask.get(taskId) ?? []).map(id => graph.tasks.get(id)).filter(Boolean)) as TaskGraphTask[]

  // Group-specific data
  const childIds = graph.childIdsByTask.get(taskId) ?? []
  const children = childIds.map(id => graph.tasks.get(id)).filter(Boolean) as TaskGraphTask[]
  const sortedChildren = [...children].sort((a, b) => {
    const sp = (STATE_PRIORITY[a.state] ?? 4) - (STATE_PRIORITY[b.state] ?? 4)
    if (sp !== 0) return sp
    return a.title.localeCompare(b.title)
  })

  const isCollapsed = collapsedTaskIds.has(taskId)

  // Subtree leaf progress
  const subtreeIds = graph.subtreeIdsByTask.get(taskId) ?? [taskId]
  const leafTasks = subtreeIds
    .map(id => graph.tasks.get(id))
    .filter((t): t is TaskGraphTask => !!t && !t.hasChildren)

  // External dependencies (deps outside this subtree)
  const subtreeSet = new Set(subtreeIds)
  const externalDeps = new Map<string, { title: string; count: number }>()
  for (const tid of subtreeIds) {
    const t = graph.tasks.get(tid)
    if (!t) continue
    for (const depId of t.depends) {
      if (subtreeSet.has(depId)) continue
      const depTask = graph.tasks.get(depId)
      if (!depTask) continue
      // Find root ancestor of dep for grouping
      let rootId = depId
      let p = depTask.parent
      const vis = new Set<string>()
      while (p && !vis.has(p)) {
        vis.add(p)
        rootId = p
        p = graph.tasks.get(p)?.parent ?? null
      }
      const existing = externalDeps.get(rootId)
      if (existing) {
        existing.count++
      } else {
        externalDeps.set(rootId, { title: graph.tasks.get(rootId)?.title ?? rootId, count: 1 })
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-[12px]" style={{ color: 'var(--sol-base01)' }}>
      {/* Breadcrumb */}
      <Breadcrumb taskId={taskId} graph={graph} onNavigate={onNavigate} />

      {/* Title + state */}
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[14px]" style={{ color: 'var(--sol-base02)' }}>
          {task.title}
        </span>
        <StateBadge state={task.state} />
      </div>

      {/* Group: progress + collapse toggle */}
      {task.hasChildren && (
        <div className="flex items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--sol-base1)' }}>
            {leafTasks.filter(t => t.state === 'done').length}/{leafTasks.length} done
          </span>
          <button
            onClick={() => onToggleCollapse(taskId)}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors"
            style={{ color: 'var(--sol-base1)', border: '1px solid var(--sol-border)' }}
          >
            {isCollapsed ? 'Expand' : 'Collapse'}
          </button>
        </div>
      )}

      {/* Progress bar for groups */}
      {task.hasChildren && leafTasks.length > 0 && (
        <SegmentedProgressBar tasks={leafTasks} />
      )}

      {/* Description */}
      {task.description && (
        <div>
          <div className="font-medium mb-1" style={{ color: 'var(--sol-base1)' }}>Description</div>
          <div style={{ color: 'var(--sol-base00)' }}>{task.description}</div>
        </div>
      )}

      {/* Accept criteria */}
      {task.acceptCriteria.length > 0 && (
        <div>
          <div className="font-medium mb-1" style={{ color: 'var(--sol-base1)' }}>Accept Criteria</div>
          <ul className="list-none pl-0">
            {task.acceptCriteria.map((ac, i) => (
              <li key={i} className="flex items-start gap-1.5 mb-0.5">
                <span style={{ color: 'var(--sol-base1)' }}>{'\u2610'}</span>
                <span>{ac}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Children (group tasks) */}
      {sortedChildren.length > 0 && (
        <CollapsibleSection title="Children" count={sortedChildren.length}>
          {sortedChildren.map(child => (
            <DepRow key={child.id} task={child} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* Dependencies */}
      {deps.length > 0 && (
        <CollapsibleSection title="Dependencies" count={deps.length}>
          {deps.map(dep => (
            <DepRow key={dep.id} task={dep} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* Dependents */}
      {dependents.length > 0 && (
        <CollapsibleSection title="Dependents" count={dependents.length}>
          {dependents.map(dep => (
            <DepRow key={dep.id} task={dep} onNavigate={onNavigate} showState />
          ))}
        </CollapsibleSection>
      )}

      {/* External dependencies (for groups) */}
      {task.hasChildren && externalDeps.size > 0 && (
        <CollapsibleSection title="External Dependencies" count={externalDeps.size}>
          {Array.from(externalDeps.entries()).map(([rootId, { title, count }]) => (
            <button
              key={rootId}
              onClick={() => onNavigate(rootId)}
              className="flex items-center gap-2 w-full text-left px-2 py-1 rounded cursor-pointer transition-colors"
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-list-hover-bg)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <span style={{ color: 'var(--sol-base1)' }}>{'\u2192'}</span>
              <span>{title}</span>
              <span className="text-[10px]" style={{ color: 'var(--sol-base1)' }}>
                ({count} dep{count !== 1 ? 's' : ''})
              </span>
            </button>
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
              style={{ backgroundColor: 'var(--sol-header-bg)', color: 'var(--sol-base01)' }}
            >
              {s}
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* Note */}
      {task.note && (
        <div>
          <div className="font-medium mb-1" style={{ color: 'var(--sol-base1)' }}>Note</div>
          <div style={{ color: 'var(--sol-base00)' }}>{task.note}</div>
        </div>
      )}
    </div>
  )
}

export function TaskGraphDetailPanel({ selection, graph, isMobile, onClose, onNavigate, collapsedTaskIds, onToggleCollapse }: {
  selection: Selection
  graph: TaskGraphModel
  isMobile: boolean
  onClose: () => void
  onNavigate: (id: string) => void
  collapsedTaskIds: Set<string>
  onToggleCollapse: (id: string) => void
}) {
  if (!selection) return null

  const content = (
    <TaskDetailView
      taskId={selection}
      graph={graph}
      onNavigate={onNavigate}
      collapsedTaskIds={collapsedTaskIds}
      onToggleCollapse={onToggleCollapse}
    />
  )

  if (isMobile) {
    return (
      <div
        className="absolute bottom-0 left-0 right-0 rounded-t-xl shadow-lg overflow-y-auto z-20"
        style={{
          maxHeight: '40vh',
          backgroundColor: 'var(--sol-bg)',
          borderTop: '1px solid var(--sol-border)',
        }}
      >
        <div className="flex justify-center py-2" onClick={onClose} style={{ cursor: 'pointer' }}>
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--sol-base1)' }} />
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
        backgroundColor: 'var(--sol-bg)',
        borderLeft: '1px solid var(--sol-border)',
        boxShadow: '-2px 0 8px rgba(0,0,0,0.04)',
        transition: 'transform 200ms ease-out',
      }}
    >
      <div className="flex justify-end p-2">
        <button
          onClick={onClose}
          className="w-6 h-6 rounded text-[14px] cursor-pointer transition-colors"
          style={{ color: 'var(--sol-base1)' }}
          title="Close"
        >
          {'\u2715'}
        </button>
      </div>
      {content}
    </div>
  )
}
