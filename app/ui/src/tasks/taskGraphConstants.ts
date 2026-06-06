// Pseudo-Gantt layout constants (unscaled; zoom is applied in the canvas).
export const PX_PER_UNIT = 48   // pixels per optimistic schedule unit
export const LEFT_COL_PAD = 24  // right padding of the frozen left task column / time pane
export const MIN_BAR = 8        // minimum rendered bar width floor

export const STATE_COLORS: Record<string, string> = {
  ready: 'var(--sol-blue)',
  running: 'var(--sol-yellow)',
  done: 'var(--sol-green)',
  blocked: 'var(--sol-red)',
  cancelled: 'var(--sol-base1)',
}

/** Solarized accent palette for worktree visual grouping */
const WORKTREE_COLORS = [
  'var(--sol-cyan)',
  'var(--sol-violet)',
  'var(--sol-magenta)',
  'var(--sol-orange)',
  'var(--sol-blue)',
  'var(--sol-green)',
]

/** Deterministic color for a worktree slug */
export function getWorktreeColor(slug: string): string {
  let hash = 0
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) - hash + slug.charCodeAt(i)) | 0
  }
  return WORKTREE_COLORS[Math.abs(hash) % WORKTREE_COLORS.length]
}
