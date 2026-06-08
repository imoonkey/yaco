// Sticky time ruler for the Pseudo-Gantt time pane. Tick labels are optimistic
// units (not dates). Matches the shipped zoom pattern: the <svg> is sized to the
// scaled bounds and a single <g transform="scale()"> wraps unscaled coords, so the
// ruler zooms in lock step with the panes.
export const RULER_HEIGHT = 26

export function TaskGanttRuler({ ticks, scale, timeWidth }: {
  ticks: { x: number; label: string }[]
  scale: number
  timeWidth: number   // unscaled time-pane width
}) {
  return (
    <svg
      className="block"
      data-testid="gantt-ruler"
      width={timeWidth * scale}
      height={RULER_HEIGHT * scale}
      style={{ position: 'sticky', top: 0, zIndex: 1 }}
    >
      <g transform={`scale(${scale})`}>
        <rect x={0} y={0} width={timeWidth} height={RULER_HEIGHT} fill="var(--sol-header-bg)" />
        <line x1={0} y1={RULER_HEIGHT - 0.5} x2={timeWidth} y2={RULER_HEIGHT - 0.5} stroke="var(--sol-border)" strokeWidth={1} />
        {ticks.map(tick => (
          <g key={tick.label}>
            <line x1={tick.x} y1={RULER_HEIGHT - 6} x2={tick.x} y2={RULER_HEIGHT} stroke="var(--sol-border)" strokeWidth={1} />
            <text x={tick.x + 3} y={RULER_HEIGHT - 9} fontSize={10} fill="var(--sol-text-faint)" className="tabular-nums">
              {tick.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  )
}
