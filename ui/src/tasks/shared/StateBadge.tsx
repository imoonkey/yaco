import { STATE_COLORS } from '../taskGraphConstants'
import type { TaskState } from '../model/taskModel'
import { StateDot } from './StateDot'

const STATE_LABELS: Record<TaskState, string> = {
  ready: 'Ready',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

/** Colored badge: dot + label, 12% opacity background */
export function StateBadge({ state }: { state: TaskState }) {
  const color = STATE_COLORS[state] ?? 'var(--sol-base1)'

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
      }}
    >
      <StateDot state={state} size={6} />
      {STATE_LABELS[state]}
    </span>
  )
}
