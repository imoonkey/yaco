import { STATE_COLORS } from '../taskGraphConstants'
import type { TaskState } from '../model/taskModel'

/** 8px SVG dot with distinct shape per state */
export function StateDot({ state, size = 8 }: { state: TaskState; size?: number }) {
  const color = STATE_COLORS[state] ?? 'var(--sol-base1)'
  const r = size / 2
  const cx = r
  const cy = r

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {state === 'ready' && (
        <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={1.5} />
      )}
      {state === 'running' && (
        <>
          <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={1.5} />
          <path
            d={`M ${cx} ${cy - r + 1} A ${r - 1} ${r - 1} 0 0 1 ${cx} ${cy + r - 1} Z`}
            fill={color}
          />
        </>
      )}
      {state === 'done' && (
        <circle cx={cx} cy={cy} r={r - 0.5} fill={color} />
      )}
      {state === 'blocked' && (
        <>
          <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={1.5} />
          <line
            x1={cx - r * 0.5}
            y1={cy - r * 0.5}
            x2={cx + r * 0.5}
            y2={cy + r * 0.5}
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'cancelled' && (
        <>
          <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={1.5} />
          <line
            x1={cx - r * 0.5}
            y1={cy}
            x2={cx + r * 0.5}
            y2={cy}
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  )
}
