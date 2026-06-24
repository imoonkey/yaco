// WorktreePicker — the Files-panel-body worktree selector (design: §P2/§P2b).
//
// Lives at the TOP of the Files panel body (mirroring how `CompareRefPicker` sits
// atop the Changes body), styled like the Changes "Compare ref" box: an accent
// top-border + tinted container whose trigger is a Compare-ref row — a small
// `worktree` label column, the current branch in mono, and a rotating `ChevronDown`.
//
// Body: a body-anchored, fixed-position dropdown (same technique as
// `RefSearchDropdown` — anchor ref + `position: fixed`) listing every git-registered
// worktree by BRANCH name, the main working tree tagged with a `primary` chip, each
// row carrying ahead/behind + a dirty dot. Rows follow the RefSearchDropdown idiom
// (h-[24px], blue-12% focus bg, mouseEnter focus); there is no search input — the
// list is short.
//
// The list is git-sourced (P1: `useProjectWorktrees`), so manually-created and
// task-less worktrees appear. Selecting a row calls `onSelect(id | null)` — the
// primary maps to `null`, every other worktree to its absolute-path id.
import { useState, useRef, useEffect } from 'react'
import type { CSSProperties } from 'react'
import { GitBranch, ChevronDown, Check } from 'lucide-react'
import { DialogShell } from './DialogShell'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

interface WorktreePickerProps {
  worktrees: WorktreeInfo[]
  /** The selected worktree's absolute-path id, or null for the primary checkout. */
  activeWorktree: string | null
  onSelect: (id: string | null) => void
}

/** Resolve the currently-selected entry: the worktree whose id matches the
 *  selection, else the primary, else the first listed. The primary fallback runs
 *  even when `activeWorktree` is a non-null id that is no longer registered (a
 *  stale selection App clears on its next pass), so the trigger never shows a
 *  linked branch for a worktree that has gone away. */
function currentEntry(worktrees: WorktreeInfo[], activeWorktree: string | null): WorktreeInfo {
  return worktrees.find(wt => wt.id === activeWorktree)
    ?? worktrees.find(wt => wt.isPrimary)
    ?? worktrees[0]
}

export function WorktreePicker({ worktrees, activeWorktree, onSelect }: WorktreePickerProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  // Nothing to pick (non-git project, or the list is still loading): render no
  // affordance rather than an empty box.
  if (worktrees.length === 0) return null

  const current = currentEntry(worktrees, activeWorktree)

  return (
    <div
      className="mx-1 mt-1 rounded-md flex flex-col shrink-0"
      style={{
        borderTop: '2px solid var(--sol-accent)',
        backgroundColor: 'color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))',
      }}
    >
      {/* Trigger row — the Compare-ref row idiom (label · mono value · chevron).
          A <button> (not the CompareRefPicker <div>) so the `Select worktree`
          aria-label selector stays a stable form control; the flex-col parent
          stretches it to full width. */}
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center h-[22px] cursor-pointer rounded-sm mx-1 my-1"
        style={{ transition: 'background-color 120ms' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        title={`Worktree: ${current.name}`}
        aria-label="Select worktree"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className="shrink-0 text-ui-2xs uppercase tracking-wider font-semibold px-1.5"
          style={{ color: 'var(--sol-text)' }}
        >worktree</span>
        <span
          className="flex-1 text-ui-md truncate font-medium text-left"
          style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}
        >{current.branch}</span>
        <ChevronDown
          size={10}
          className="shrink-0 mr-1"
          style={{
            color: open ? 'var(--sol-accent)' : 'var(--sol-text)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1), color 120ms',
          }}
        />
      </button>
      {open && (
        <WorktreeDropdown
          anchorRef={anchorRef}
          worktrees={worktrees}
          activeWorktree={activeWorktree}
          onSelect={id => { onSelect(id); setOpen(false) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** The body-anchored worktree list. Mounts only while open (state resets
 *  naturally); position is computed from the trigger in an effect so the ref is
 *  not read during render, then right-clamped so it never spills past the viewport.
 *  Focus starts on the active row and follows the mouse (RefSearchDropdown idiom). */
function WorktreeDropdown({ anchorRef, worktrees, activeWorktree, onSelect, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
}) {
  const activeIdx = Math.max(0, worktrees.findIndex(wt =>
    wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree))
  const [focusIdx, setFocusIdx] = useState(activeIdx)
  const [posStyle, setPosStyle] = useState<CSSProperties>({ position: 'fixed', left: 0, top: 0, width: 200 })
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const width = Math.max(rect.width, 200)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setPosStyle({ position: 'fixed', left, top: rect.bottom + 4, width })
  }, [anchorRef])

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      // A popover selector that re-roots the view on selection — don't return focus to
      // the trigger on close. With the workspace no longer remounting per worktree
      // (P3 drop-remount), the trigger button survives the switch, so restoring focus
      // to it leaves a focused toggle that a later stray Enter (e.g. confirming
      // quick-open) re-activates, reopening the dropdown unexpectedly.
      restoreFocus={false}
      className="rounded-lg overflow-hidden z-50 py-1"
      style={posStyle}
    >
      <div role="listbox" aria-label="Worktrees" className="flex flex-col max-h-[min(320px,50vh)] overflow-y-auto">
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
    </DialogShell>
  )
}
