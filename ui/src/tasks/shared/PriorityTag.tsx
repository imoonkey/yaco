import type { Priority } from '../model/taskModel'

const PRIORITY_COLORS: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: '',
  low: 'var(--sol-base1)',
}

const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  normal: '',
  low: 'LOW',
}

/** Colored priority label — hidden for normal priority */
export function PriorityTag({ priority }: { priority: Priority }) {
  if (priority === 'normal') return null

  const color = PRIORITY_COLORS[priority]

  return (
    <span
      className="text-[10px] font-bold uppercase tracking-wide"
      style={{ color }}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
