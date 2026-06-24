// WorktreePicker — the Files-panel-body worktree selector (design: §P2/§P2b/§P2c).
//
// Rendered at the TOP of the Files panel body, but only when the header's worktree
// toggle is OPEN (FilesPanel gates it through a module-scoped open store, mirroring
// ChangesPanel's compare mode). Styled like the Changes "Compare ref" box: an accent
// top-border + tinted container.
//
// The container holds the worktree LIST INLINE — the rows render directly (pushing the
// file tree down), like `CompareRefPicker` sits inline in the Changes body. There is no
// trigger row and no floating dropdown: the header toggle owns visibility. Rows follow
// the RefSearchDropdown idiom (h-[24px], blue-12% focus bg, mouseEnter focus); there is
// no search input — the list is short.
//
// The list is git-sourced (P1: `useProjectWorktrees`), so manually-created and
// task-less worktrees appear. Selecting a row calls `onSelect(id | null)` — the
// primary maps to `null`, every other worktree to its absolute-path id (FilesPanel's
// handler also closes the picker).
import { useState } from 'react'
import { GitBranch, Check } from 'lucide-react'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

interface WorktreePickerProps {
  worktrees: WorktreeInfo[]
  /** The selected worktree's absolute-path id, or null for the primary checkout. */
  activeWorktree: string | null
  onSelect: (id: string | null) => void
}

export function WorktreePicker({ worktrees, activeWorktree, onSelect }: WorktreePickerProps) {
  // Nothing to pick (non-git project, or the list is still loading): render no
  // affordance rather than an empty box. The header toggle guards on the same count.
  const activeIdx = Math.max(0, worktrees.findIndex(wt =>
    wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree))
  const [focusIdx, setFocusIdx] = useState(activeIdx)
  if (worktrees.length === 0) return null

  return (
    <div
      className="mx-1 mt-1 rounded-md flex flex-col shrink-0"
      style={{
        borderTop: '2px solid var(--sol-accent)',
        backgroundColor: 'color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))',
      }}
    >
      <div
        role="listbox"
        aria-label="Worktrees"
        className="flex flex-col max-h-[min(320px,50vh)] overflow-y-auto py-1"
      >
        {worktrees.map((wt, idx) => {
          const isActive = wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree
          const isFocused = idx === focusIdx
          return (
            <button
              key={wt.id}
              type="button"
              role="option"
              aria-selected={isActive}
              data-worktree-id={wt.id}
              onClick={() => onSelect(wt.isPrimary ? null : wt.id)}
              onMouseEnter={() => setFocusIdx(idx)}
              className="flex items-center gap-1.5 px-2 h-[24px] text-ui-md cursor-pointer text-left"
              style={{
                backgroundColor: isFocused ? 'color-mix(in srgb, var(--sol-blue) 12%, transparent)' : undefined,
                color: isFocused ? 'var(--sol-blue)' : 'var(--sol-text)',
                transition: 'background-color 80ms',
              }}
              title={wt.name}
            >
              <GitBranch size={11} className="shrink-0 opacity-60" />
              <span className="truncate flex-1" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}>
                {wt.branch}
              </span>
              {wt.isPrimary && (
                <span
                  className="text-ui-2xs uppercase tracking-wider px-1 rounded shrink-0"
                  style={{ color: 'var(--sol-text-faint)', border: '1px solid var(--sol-border)', background: 'var(--sol-subtle-bg)' }}
                >
                  primary
                </span>
              )}
              {(wt.ahead > 0 || wt.behind > 0) && (
                <span className="text-ui-2xs tabular-nums shrink-0 whitespace-nowrap" style={{ color: 'var(--sol-text-faint)' }}>
                  {wt.ahead > 0 && `↑${wt.ahead}`}{wt.ahead > 0 && wt.behind > 0 && ' '}{wt.behind > 0 && `↓${wt.behind}`}
                </span>
              )}
              {wt.dirty && (
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-warning)' }} />
              )}
              <Check size={12} className="shrink-0" style={{ opacity: isActive ? 1 : 0 }} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
