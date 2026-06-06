import { useMemo, useCallback, useEffect, useRef } from 'react'
import { X, ExternalLink, Terminal, Tag, FileCode, Link2, ChevronRight, FileText, FolderGit2, GitBranch } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import type { TaskV2, TaskState, Priority, RawTaskV2 } from './model/taskModel'
import type { TaskMutations } from './hooks/useTaskData'
import { STATE_COLORS } from './taskGraphConstants'
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

function SectionHeader({ children, divider = true }: { children: React.ReactNode; divider?: boolean }) {
  return (
    <div className={divider ? 'mb-1' : ''}>
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--sol-muted)' }}
      >
        {children}
      </div>
      {divider && <div className="mt-1" style={{ height: 1, backgroundColor: 'var(--sol-border)' }} />}
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
      <span className="text-[10px] font-medium shrink-0" style={{ color: STATE_COLORS[task.state] }}>
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

const STATE_PRIORITY: Record<string, number> = {
  blocked: 0, ready: 1, running: 2, done: 3, cancelled: 4,
}

/** Collect all leaf descendants of a task for progress calculation */
function getLeafDescendants(taskId: string, allTasks: Map<string, TaskV2>): TaskV2[] {
  const children = Array.from(allTasks.values()).filter(t => t.parent === taskId)
  if (children.length === 0) return []
  const leaves: TaskV2[] = []
  const stack = [...children]
  while (stack.length > 0) {
    const t = stack.pop()!
    const grandchildren = Array.from(allTasks.values()).filter(c => c.parent === t.id)
    if (grandchildren.length === 0) {
      leaves.push(t)
    } else {
      stack.push(...grandchildren)
    }
  }
  return leaves
}

function ChildrenProgressBar({ leaves }: { leaves: TaskV2[] }) {
  if (leaves.length === 0) return null
  const counts: Record<string, number> = { done: 0, running: 0, ready: 0, blocked: 0, cancelled: 0 }
  for (const t of leaves) counts[t.state] = (counts[t.state] ?? 0) + 1
  const segments = ['done', 'running', 'ready', 'blocked', 'cancelled']
    .filter(s => counts[s] > 0)
    .map(s => ({ state: s, pct: (counts[s] / leaves.length) * 100 }))

  return (
    <div>
      <div className="flex rounded overflow-hidden" style={{ height: 4, backgroundColor: 'var(--sol-subtle-bg)' }}>
        {segments.map(seg => (
          <div
            key={seg.state}
            style={{ width: `${seg.pct}%`, backgroundColor: STATE_COLORS[seg.state], transition: 'width 300ms ease-out' }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
        {segments.map(seg => (
          <span key={seg.state} className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--sol-muted)' }}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: STATE_COLORS[seg.state] }} />
            {counts[seg.state]} {seg.state}
          </span>
        ))}
      </div>
    </div>
  )
}

export type TaskDetailPanelProps = {
  task: TaskV2 | null
  allTasks: Map<string, TaskV2>
  onClose: () => void
  onSelectTask: (id: string) => void
  onOpenTerminal?: (agent: string) => void
  onOpenFile?: (path: string) => void
  mutate: TaskMutations
  readOnly?: boolean
  width?: number
  isResizing?: boolean
  onResizeStart?: (e: React.MouseEvent) => void
}

export function TaskDetailPanel({
  task,
  allTasks,
  onClose,
  onSelectTask,
  onOpenTerminal,
  onOpenFile,
  mutate,
  readOnly = false,
  width = 380,
  isResizing = false,
  onResizeStart,
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

  const taskId = task?.id
  const children = useMemo(() => {
    if (!taskId) return []
    const kids = Array.from(allTasks.values()).filter(t => t.parent === taskId)
    return kids.sort((a, b) => {
      const sp = (STATE_PRIORITY[a.state] ?? 4) - (STATE_PRIORITY[b.state] ?? 4)
      return sp !== 0 ? sp : a.title.localeCompare(b.title)
    })
  }, [allTasks, taskId])

  const leafDescendants = useMemo(
    () => taskId && children.length > 0 ? getLeafDescendants(taskId, allTasks) : [],
    [taskId, allTasks, children.length],
  )

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
    <div className="flex flex-col gap-4 p-4 text-[12px]" style={{ color: 'var(--sol-text)' }}>
      {/* Breadcrumb + ID */}
      <div className="flex items-center justify-between gap-2">
        <Breadcrumb task={task} allTasks={allTasks} onSelectTask={onSelectTask} />
        <span
          className="shrink-0 text-[11px] px-1.5 py-0.5 rounded"
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--sol-text-dim)',
            backgroundColor: 'var(--sol-subtle-bg)',
          }}
        >
          {task.id}
        </span>
      </div>

      {/* Title — editable */}
      <InlineEdit
        value={task.title}
        onSave={v => patch('title', v)}
        readOnly={readOnly}
        displayClassName="text-[16px] font-bold tracking-[-0.02em] leading-tight"
        className="text-[16px] font-bold tracking-[-0.02em]"
      />

      {/* State / Priority / Estimate row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <SectionHeader divider={false}>State</SectionHeader>
          <InlineEdit
            value={task.state}
            onSave={v => patch('state', v)}
            type="dropdown"
            options={stateOptions}
            readOnly={readOnly}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <SectionHeader divider={false}>Priority</SectionHeader>
          <InlineEdit
            value={task.priority}
            onSave={v => patch('priority', v)}
            type="dropdown"
            options={ALL_PRIORITIES}
            readOnly={readOnly}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <SectionHeader divider={false}>Estimate</SectionHeader>
          <InlineEdit
            value={task.estimate ?? ''}
            onSave={v => patch('estimate', v || null)}
            type="dropdown"
            options={ESTIMATE_OPTIONS}
            readOnly={readOnly}
            displayClassName="text-[11px] font-semibold"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <SectionHeader divider={false}>Workset</SectionHeader>
          <span className="text-[11px] font-semibold capitalize" style={{ color: 'var(--sol-text)' }}>
            {task.workset}
          </span>
        </div>
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

      {/* Worktree */}
      {task.worktree && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Worktree</SectionHeader>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <FolderGit2 size={12} style={{ color: task.worktreeStatus?.active ? 'var(--sol-green)' : 'var(--sol-muted)' }} />
              <span className="font-mono text-[12px]" style={{ color: 'var(--sol-text)' }}>{task.worktree}</span>
              {task.worktreeStatus?.active && (
                <span
                  className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded"
                  style={{ color: 'var(--sol-green)', backgroundColor: 'color-mix(in srgb, var(--sol-green) 10%, transparent)' }}
                >
                  Active
                </span>
              )}
            </div>
            {task.worktreeStatus?.active && (
              <>
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--sol-text)' }}>
                  <GitBranch size={11} style={{ color: 'var(--sol-muted)' }} />
                  <span className="font-mono">{task.worktreeStatus.branch}</span>
                  {task.worktreeStatus.dirty && (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1 py-px rounded"
                      style={{ color: 'var(--sol-warning)', backgroundColor: 'color-mix(in srgb, var(--sol-warning) 10%, transparent)' }}
                    >
                      Modified
                    </span>
                  )}
                </div>
                {(task.worktreeStatus.ahead > 0 || task.worktreeStatus.behind > 0) && (
                  <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--sol-muted)' }}>
                    {task.worktreeStatus.ahead > 0 && (
                      <span className="tabular-nums">&uarr;{task.worktreeStatus.ahead} ahead</span>
                    )}
                    {task.worktreeStatus.behind > 0 && (
                      <span className="tabular-nums">&darr;{task.worktreeStatus.behind} behind</span>
                    )}
                  </div>
                )}
              </>
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
          readOnly={readOnly}
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

      {/* Children (for parent/milestone tasks) */}
      {children.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Children ({children.length})</SectionHeader>
          {leafDescendants.length > 0 && (
            <div className="mb-1">
              <div className="text-[11px] mb-1" style={{ color: 'var(--sol-muted)' }}>
                {leafDescendants.filter(t => t.state === 'done').length}/{leafDescendants.length} done
              </div>
              <ChildrenProgressBar leaves={leafDescendants} />
            </div>
          )}
          {children.map(child => (
            <DepRow key={child.id} task={child} onSelect={onSelectTask} />
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

      {/* Design doc link — opens in editor for file paths, new tab for URLs */}
      {task.design && (
        <div className="flex flex-col gap-1">
          <SectionHeader>Design Doc</SectionHeader>
          {/^https?:\/\//.test(task.design) ? (
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
          ) : (
            <button
              onClick={() => onOpenFile?.(task.design!)}
              className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer transition-colors hover:underline text-left"
              style={{ color: 'var(--sol-blue)' }}
            >
              <FileText size={12} />
              {task.design}
            </button>
          )}
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
          readOnly={readOnly}
          displayClassName="whitespace-pre-wrap"
        />
      </div>
    </div>
  )

  // Mobile: bottom sheet with backdrop
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          className="absolute inset-0 z-10"
          style={{ backgroundColor: 'var(--sol-overlay-bg)' }}
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="complementary"
          aria-label="Task details"
          className="absolute bottom-0 left-0 right-0 rounded-t-xl shadow-lg overflow-y-auto z-20"
          style={{
            maxHeight: '75vh',
            backgroundColor: 'var(--sol-bg)',
            borderTop: '1px solid var(--sol-border)',
            animation: 'panel-slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
          }}
        >
          {/* Header: drag handle + close button */}
          <div className="sticky top-0 z-10" style={{ backgroundColor: 'var(--sol-bg)' }}>
            <div className="flex justify-center pt-2 pb-1 cursor-pointer" onClick={onClose}>
              <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--sol-base1)' }} />
            </div>
            <div
              className="flex items-center justify-between px-4 pb-2"
              style={{ borderBottom: '1px solid var(--sol-border)' }}
            >
              <span className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--sol-muted)' }}>
                  Task Details
                </span>
                {readOnly && (
                  <span
                    className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded"
                    style={{ color: 'var(--sol-base1)', backgroundColor: 'var(--sol-subtle-bg)' }}
                  >
                    Archived
                  </span>
                )}
              </span>
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded cursor-pointer transition-colors hover:bg-sol-hover-bg"
                style={{ color: 'var(--sol-base1)' }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          {content}
        </div>
      </>
    )
  }

  // Desktop: right overlay panel
  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label="Task details"
      className="absolute top-0 right-0 bottom-0 z-20 flex flex-col shadow-lg"
      style={{
        width,
        maxWidth: 'calc(100% - 48px)',
        backgroundColor: 'var(--sol-bg)',
        borderLeft: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-3)',
        animation: 'panel-slide-right 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      {onResizeStart && (
        <div
          role="separator"
          aria-label="Resize task details"
          aria-orientation="vertical"
          onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e) }}
          className="absolute top-0 bottom-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize"
          style={{ touchAction: 'none' }}
        >
          <div
            className="absolute top-0 bottom-0 left-1/2 w-px"
            style={{
              backgroundColor: isResizing ? 'var(--sol-accent)' : 'var(--sol-border)',
              transform: 'translateX(-0.5px)',
              transition: 'background-color var(--transition-fast)',
            }}
          />
        </div>
      )}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{ height: 36, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)' }}
      >
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--sol-muted)' }}>
            Task Details
          </span>
          {readOnly && (
            <span
              className="text-[9px] font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded"
              style={{ color: 'var(--sol-base1)', backgroundColor: 'var(--sol-subtle-bg)' }}
            >
              Archived
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded cursor-pointer transition-colors hover:bg-sol-hover-bg"
          style={{ color: 'var(--sol-base1)' }}
          title="Close (Esc)"
          aria-label="Close task details"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {content}
      </div>
    </div>
  )
}
