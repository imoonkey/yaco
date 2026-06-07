// --- Git status presentation constants (shared by file explorer, diff, and sidebar) ---

export const GIT_COLORS: Record<string, string> = { M: 'var(--sol-warning)', U: 'var(--sol-diff-add)', A: 'var(--sol-diff-add)', D: 'var(--sol-diff-del)' }

export const GIT_STATUS_LABELS: Record<string, string> = { M: 'Modified', U: 'Untracked', A: 'Added', D: 'Deleted' }
