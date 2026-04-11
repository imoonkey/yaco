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
