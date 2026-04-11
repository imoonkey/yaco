import { useCallback, useEffect, useRef } from 'react'
import { X, ExternalLink, Terminal, Tag, FileCode, Link2, ChevronRight } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import type { TaskV2, TaskState, Priority, RawTaskV2 } from './model/taskModel'
import type { TaskMutations } from './hooks/useTaskData'
import { STATE_COLORS } from './taskGraphConstants'
import { StateBadge } from './shared/StateBadge'
import { PriorityTag } from './shared/PriorityTag'
import { StateDot } from './shared/StateDot'
import { InlineEdit } from './shared/InlineEdit'

const ALL_STATES: { value: TaskState; label: string }[] = [
  { value: 'ready', label: 'Ready' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'cancelled', label: 'Cancelled' },
]

const ALL_PRIORITIES: { value: Priority; label: string; color?: string }[] = [
  { value: 'critical', label: 'Critical', color: 'var(--sol-red)' },
  { value: 'high', label: 'High', color: 'var(--sol-orange)' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low', color: 'var(--sol-base1)' },
]

const ESTIMATE_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'xs', label: 'XS' },
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
  { value: 'xl', label: 'XL' },
]

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] font-bold uppercase tracking-[0.06em]"
      style={{ color: 'var(--sol-muted)' }}
    >
      {children}
    </div>
  )
}

function Breadcrumb({ task, allTasks, onSelectTask }: {
  task: TaskV2
  allTasks: Map<string, TaskV2>
  onSelectTask: (id: string) => void
}) {
  const ancestors: { id: string; title: string }[] = []
  let current = task.parent
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const t = allTasks.get(current)
    if (!t) break
    ancestors.unshift({ id: current, title: t.title })
    current = t.parent
  }
  if (ancestors.length === 0) return null

  return (
    <div className="flex items-center gap-1 flex-wrap text-[11px]" style={{ color: 'var(--sol-base1)' }}>
      {ancestors.map((a, i) => (
        <span key={a.id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={10} />}
          <button
            onClick={() => onSelectTask(a.id)}
            className="cursor-pointer transition-colors hover:text-[var(--sol-base01)]"
            style={{ color: 'var(--sol-base1)' }}
          >
            {a.title}
          </button>
        </span>
      ))}
    </div>
  )
}

function DepRow({ task, onSelect }: { task: TaskV2; onSelect: (id: string) => void }) {
  return (
    <button
      onClick={() => onSelect(task.id)}
      className="flex items-center gap-2 w-full text-left px-2 py-1 rounded cursor-pointer transition-colors hover:bg-sol-hover-bg"
    >
      <StateDot state={task.state} />
      <span className="flex-1 truncate text-[12px]">{task.title}</span>
      <span className="text-[11px] shrink-0" style={{ color: STATE_COLORS[task.state] }}>
        {task.state}
      </span>
    </button>
  )
}

function AcceptCriteriaItem({ text, checked, onToggle }: {
  text: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex items-start gap-2 py-0.5 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 accent-[var(--sol-green)]"
      />
      <span
        className="text-[12px]"
        style={{
          color: checked ? 'var(--sol-base1)' : 'var(--sol-base01)',
          textDecoration: checked ? 'line-through' : 'none',
        }}
      >
        {text}
      </span>
    </label>
  )
}

export type TaskDetailPanelProps = {
  task: TaskV2 | null
  allTasks: Map<string, TaskV2>
  onClose: () => void
  onSelectTask: (id: string) => void
  onOpenTerminal?: (agent: string) => void
  mutate: TaskMutations
}

export function TaskDetailPanel({
  task,
  allTasks,
  onClose,
  onSelectTask,
  onOpenTerminal,
  mutate,
}: TaskDetailPanelProps) {
  const isMobile = useIsMobile()
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const patch = useCallback((field: string, value: unknown) => {
    if (!task) return
    mutate.updateTask(task.id, { [field]: value } as Partial<RawTaskV2>)
  }, [task, mutate])

  if (!task) return null

  const deps = task.depends
    .map(id => allTasks.get(id))
    .filter((t): t is TaskV2 => !!t)

  const dependents = Array.from(allTasks.values())
    .filter(t => t.depends.includes(task.id))

  const stateOptions = ALL_STATES.map(s => ({
    ...s,
    color: STATE_COLORS[s.value],
  }))

  const content = (
    <div className="flex flex-col gap-4 p-4 text-[12px]" style={{ color: 'var(--sol-base01)' }}>
      {/* Breadcrumb */}
      <Breadcrumb task={task} allTasks={allTasks} onSelectTask={onSelectTask} />

      {/* Title — editable */}
      <InlineEdit
        value={task.title}
        onSave={v => patch('title', v)}
        displayClassName="text-[18px] font-bold"
        className="text-[18px] font-bold"
      />

      {/* State / Priority / Estimate row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <SectionHeader>State</SectionHeader>
          <InlineEdit
            value={task.state}
            onSave={v => patch('state', v)}
            type="dropdown"
            options={stateOptions}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <SectionHeader>Priority</SectionHeader>
          <InlineEdit
            value={task.priority}
            onSave={v => patch('priority', v)}
            type="dropdown"
            options={ALL_PRIORITIES}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <SectionHeader>Estimate</SectionHeader>
          <InlineEdit
            value={task.estimate ?? ''}
            onSave={v => patch('estimate', v || null)}
            type="dropdown"
            options={ESTIMATE_OPTIONS}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
      </div>

      {/* Badges summary */}
      <div className="flex items-center gap-2 flex-wrap">
        <StateBadge state={task.state} />
        <PriorityTag priority={task.priority} />
      </div>

      {/* Agent */}
      {task.agent && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Agent</SectionHeader>
          <div className="flex items-center gap-2">
            {task.state === 'running' && (
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: 'var(--sol-green)' }}
              />
            )}
            <span>{task.agent}</span>
            {onOpenTerminal && (
              <button
                onClick={() => onOpenTerminal(task.agent!)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors hover:bg-sol-hover-bg"
                style={{ border: '1px solid var(--sol-border)' }}
              >
                <Terminal size={12} />
                Open Terminal
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Tags</SectionHeader>
          <div className="flex items-center gap-1.5 flex-wrap">
            {task.tags.map(tag => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px]"
                style={{
                  backgroundColor: 'var(--sol-subtle-bg)',
                  color: 'var(--sol-base01)',
                }}
              >
                <Tag size={10} />
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      <div className="flex flex-col gap-1">
        <SectionHeader>Description</SectionHeader>
        <InlineEdit
          value={task.description ?? ''}
          onSave={v => patch('description', v || null)}
          type="textarea"
          placeholder="Add description..."
          displayClassName="whitespace-pre-wrap"
        />
      </div>

      {/* Accept Criteria */}
      {task.acceptCriteria.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Acceptance Criteria</SectionHeader>
          {task.acceptCriteria.map((ac, i) => (
            <AcceptCriteriaItem
              key={i}
              text={ac}
              checked={task.state === 'done'}
              onToggle={() => {
                // Toggle individual criteria not supported in V2 schema yet;
                // toggling marks entire task done/ready
                patch('state', task.state === 'done' ? 'ready' : 'done')
              }}
            />
          ))}
        </div>
      )}

      {/* Dependencies */}
      {deps.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Dependencies ({deps.length})</SectionHeader>
          {deps.map(dep => (
            <DepRow key={dep.id} task={dep} onSelect={onSelectTask} />
          ))}
        </div>
      )}

      {/* Dependents */}
      {dependents.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Dependents ({dependents.length})</SectionHeader>
          {dependents.map(dep => (
            <DepRow key={dep.id} task={dep} onSelect={onSelectTask} />
          ))}
        </div>
      )}

      {/* Scope files */}
      {task.scope.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Scope</SectionHeader>
          {task.scope.map((s, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono"
              style={{ backgroundColor: 'var(--sol-header-bg)', color: 'var(--sol-base01)' }}
            >
              <FileCode size={12} />
              {s}
            </div>
          ))}
        </div>
      )}

      {/* Design doc link */}
      {task.design && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Design Doc</SectionHeader>
          <a
            href={task.design}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] transition-colors hover:underline"
            style={{ color: 'var(--sol-blue)' }}
          >
            <Link2 size={12} />
            {task.design}
            <ExternalLink size={10} />
          </a>
        </div>
      )}

      {/* Notes */}
      <div className="flex flex-col gap-1">
        <SectionHeader>Notes</SectionHeader>
        <InlineEdit
          value={task.note ?? ''}
          onSave={v => patch('note', v || null)}
          type="textarea"
          placeholder="Add notes..."
          displayClassName="whitespace-pre-wrap"
        />
      </div>
    </div>
  )

  // Mobile: bottom sheet
  if (isMobile) {
    return (
      <div
        ref={panelRef}
        className="absolute bottom-0 left-0 right-0 rounded-t-xl shadow-lg overflow-y-auto z-20"
        style={{
          maxHeight: '50vh',
          backgroundColor: 'var(--sol-bg)',
          borderTop: '1px solid var(--sol-border)',
          animation: 'panel-slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        <div className="flex justify-center py-2 cursor-pointer" onClick={onClose}>
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--sol-base1)' }} />
        </div>
        {content}
      </div>
    )
  }

  // Desktop: right panel 360px
  return (
    <div
      ref={panelRef}
      className="shrink-0 overflow-y-auto"
      style={{
        width: 360,
        backgroundColor: 'var(--sol-bg)',
        borderLeft: '1px solid var(--sol-border)',
        boxShadow: '-2px 0 8px rgba(0,0,0,0.04)',
        animation: 'panel-slide-right 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <div className="flex items-center justify-between p-3 sticky top-0 z-10" style={{ backgroundColor: 'var(--sol-bg)' }}>
        <span className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--sol-muted)' }}>
          Task Details
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded cursor-pointer transition-colors hover:bg-sol-hover-bg"
          style={{ color: 'var(--sol-base1)' }}
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>
      {content}
    </div>
  )
}
