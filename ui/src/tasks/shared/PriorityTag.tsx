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
      className="text-[10px] font-bold uppercase tracking-[0.04em] rounded px-1 py-px"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
