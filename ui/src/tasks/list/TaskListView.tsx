import { useCallback, useRef, useState, useEffect } from 'react'
import { Rows3, Group } from 'lucide-react'
import type { TaskV2 } from '../model/taskModel'
import type { TaskMutations } from '../hooks/useTaskData'
import { useTaskList } from '../hooks/useTaskList'
import { ListHeader } from './ListHeader'
import { ListRow } from './ListRow'

type Density = 'compact' | 'comfortable'
const ROW_HEIGHTS: Record<Density, number> = { compact: 36, comfortable: 48 }

interface TaskListViewProps {
  tasks: Map<string, TaskV2>
  filteredTaskIds: Set<string>
  onSelectTask: (id: string) => void
  selectedTaskId: string | null
  multiSelectedIds: Set<string>
  onSetMultiSelected: (ids: Set<string>) => void
  mutate: TaskMutations
}

export function TaskListView({
  tasks,
  filteredTaskIds,
  onSelectTask,
  selectedTaskId,
  multiSelectedIds,
  onSetMultiSelected,
  mutate,
}: TaskListViewProps) {
  const {
    sortCol, sortDir, toggleSort,
    setGroupByParent,
    sortedTasks, groups,
    editingTaskId, setEditingTaskId,
    computeSelection,
  } = useTaskList(tasks, filteredTaskIds)

  const [density, setDensity] = useState<Density>('compact')
  const rowHeight = ROW_HEIGHTS[density]

  // Virtual scroll
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(800)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setViewportH(entry.contentRect.height))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
  }, [])

  const handleRowClick = useCallback((taskId: string, e: React.MouseEvent) => {
    const result = computeSelection(taskId, multiSelectedIds, e.shiftKey, e.metaKey)
    if (result.action === 'select') {
      onSetMultiSelected(new Set())
      onSelectTask(taskId)
    } else {
      onSetMultiSelected(result.ids)
    }
  }, [computeSelection, multiSelectedIds, onSetMultiSelected, onSelectTask])

  const handleSaveTitle = useCallback((taskId: string, title: string) => {
    setEditingTaskId(null)
    if (title.trim() && title !== tasks.get(taskId)?.title) {
      mutate.updateTask(taskId, { title: title.trim() })
    }
  }, [tasks, mutate, setEditingTaskId])

  const toggleDensity = useCallback(() => {
    setDensity(d => d === 'compact' ? 'comfortable' : 'compact')
  }, [])

  // Flat render (no grouping)
  if (!groups) {
    const buffer = 5
    const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer)
    const endIdx = Math.min(sortedTasks.length, Math.ceil((scrollTop + viewportH) / rowHeight) + buffer)
    const topPad = startIdx * rowHeight
    const bottomPad = Math.max(0, (sortedTasks.length - endIdx) * rowHeight)

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-2" style={{ height: 28, backgroundColor: 'var(--sol-bg)' }}>
          <div className="text-[11px]" style={{ color: 'var(--sol-text-dim)' }}>
            {sortedTasks.length} task{sortedTasks.length !== 1 ? 's' : ''}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setGroupByParent(true)}
              className="p-1 rounded hover:bg-sol-hover-bg"
              style={{ color: 'var(--sol-base1)' }}
              title="Group by parent"
            >
              <Group size={14} />
            </button>
            <button
              onClick={toggleDensity}
              className="p-1 rounded hover:bg-sol-hover-bg"
              style={{ color: 'var(--sol-base1)' }}
              title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
            >
              <Rows3 size={14} />
            </button>
          </div>
        </div>
        <ListHeader sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0" role="grid" onScroll={handleScroll}>
          <div style={{ height: topPad }} />
          {sortedTasks.slice(startIdx, endIdx).map(task => (
            <ListRow
              key={task.id}
              task={task}
              allTasks={tasks}
              selected={selectedTaskId === task.id}
              multiSelected={multiSelectedIds.has(task.id)}
              editing={editingTaskId === task.id}
              rowHeight={rowHeight}
              onClick={(e) => handleRowClick(task.id, e)}
              onDoubleClickTitle={() => setEditingTaskId(task.id)}
              onSaveTitle={(v) => handleSaveTitle(task.id, v)}
              onCancelEdit={() => setEditingTaskId(null)}
            />
          ))}
          <div style={{ height: bottomPad }} />
        </div>
      </div>
    )
  }

  // Grouped render
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2" style={{ height: 28, backgroundColor: 'var(--sol-bg)' }}>
        <div className="text-[11px]" style={{ color: 'var(--sol-text-dim)' }}>
          {sortedTasks.length} task{sortedTasks.length !== 1 ? 's' : ''} in {groups.length} group{groups.length !== 1 ? 's' : ''}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setGroupByParent(false)}
            className="p-1 rounded hover:bg-sol-hover-bg"
            style={{ color: 'var(--sol-accent)' }}
            title="Ungroup"
          >
            <Group size={14} />
          </button>
          <button
            onClick={toggleDensity}
            className="p-1 rounded hover:bg-sol-hover-bg"
            style={{ color: 'var(--sol-base1)' }}
            title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
          >
            <Rows3 size={14} />
          </button>
        </div>
      </div>
      <ListHeader sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.map(group => (
          <div key={group.parentId ?? '__none'}>
            <GroupHeader
              title={group.parentTitle}
              doneCount={group.doneCount}
              totalCount={group.totalCount}
            />
            {group.tasks.map(task => (
              <ListRow
                key={task.id}
                task={task}
                allTasks={tasks}
                selected={selectedTaskId === task.id}
                multiSelected={multiSelectedIds.has(task.id)}
                editing={editingTaskId === task.id}
                rowHeight={rowHeight}
                onClick={(e) => handleRowClick(task.id, e)}
                onDoubleClickTitle={() => setEditingTaskId(task.id)}
                onSaveTitle={(v) => handleSaveTitle(task.id, v)}
                onCancelEdit={() => setEditingTaskId(null)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function GroupHeader({ title, doneCount, totalCount }: { title: string; doneCount: number; totalCount: number }) {
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  return (
    <div
      className="flex items-center gap-2 px-3 border-b"
      style={{
        height: 28,
        backgroundColor: 'var(--sol-subtle-bg)',
        borderColor: 'var(--sol-border)',
      }}
    >
      <span className="text-[12px] font-semibold" style={{ color: 'var(--sol-text)' }}>
        {title}
      </span>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ width: 48, backgroundColor: 'var(--sol-border)' }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: 'var(--sol-green)' }}
        />
      </div>
      <span className="text-[10px]" style={{ color: 'var(--sol-text-dim)' }}>
        {doneCount}/{totalCount}
      </span>
    </div>
  )
}
