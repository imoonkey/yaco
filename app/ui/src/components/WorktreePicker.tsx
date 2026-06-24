// WorktreePicker — the Files-panel-body worktree selector (design: §P2/§P2b/§P2c/§P2d).
//
// Mirrors the Changes "Compare ref" interaction (ChangesPanel + CompareRefPicker +
// RefSearchDropdown). The non-default state for a worktree is APP state, not a UI mode:
//
//   - PRIMARY active (`activeWorktree === null`): nothing persistent renders — exactly
//     as Compare ref shows nothing when not comparing. The Files header's `GitBranch`
//     toggle is the entry point that opens the dropdown.
//   - A NON-PRIMARY worktree active: a persistent INDICATOR box renders atop the Files
//     body AT ALL TIMES (tree and search mode) — the reminder, the analogue of the
//     CompareRefPicker box that stays shown while in compare mode. It carries the
//     worktree's branch + dirty/ahead-behind, an `X` that REMOVES the worktree
//     (`onSelect(null)` → back to primary, like Compare ref's exit-to-default), and is
//     itself a trigger that opens the dropdown.
//
// The picker is a real floating DROPDOWN (DialogShell, position:fixed, anchored — the
// RefSearchDropdown idiom), not an inline short list. Opened by the header toggle or by
// clicking the indicator box; anchored to the indicator box when non-primary, else to a
// zero-height host at the top of the body. The list is git-sourced (P1:
// `useProjectWorktrees`), so manually-created and task-less worktrees appear. Selecting
// a row calls `onSelect(id | null)` (primary → `null`) and closes.
import { useEffect, useRef, useState } from 'react'
import { GitBranch, Check, ChevronDown, X } from 'lucide-react'
import { DialogShell } from './DialogShell'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

interface WorktreePickerProps {
  worktrees: WorktreeInfo[]
  /** The selected worktree's absolute-path id, or null for the primary checkout. */
  activeWorktree: string | null
  /** Bind a worktree by id; null returns to the primary checkout. */
  onSelect: (id: string | null) => void
  /** Whether the floating dropdown is open (lives in FilesPanel's module store —
   *  the header toggle and this body region are PanelFrame siblings). */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Resolve the currently-selected worktree: the one whose id matches the selection,
 *  else the primary, else the first listed. The primary fallback runs even when
 *  `activeWorktree` is a non-null id no longer registered (a stale selection App clears
 *  on its next pass) — so a gone worktree reads as "on primary" (no indicator) and the
 *  header tooltip never names a worktree that has gone away. */
// eslint-disable-next-line react-refresh/only-export-components
export function currentWorktreeEntry(
  worktrees: WorktreeInfo[], activeWorktree: string | null,
): WorktreeInfo | null {
  if (worktrees.length === 0) return null
  return worktrees.find(wt => wt.id === activeWorktree)
    ?? worktrees.find(wt => wt.isPrimary)
    ?? worktrees[0]
}

/** Dirty dot + ahead/behind, shared by the indicator box and the dropdown rows. */
function WorktreeMeta({ wt }: { wt: WorktreeInfo }) {
  return (
    <>
      {(wt.ahead > 0 || wt.behind > 0) && (
        <span className="text-ui-2xs tabular-nums shrink-0 whitespace-nowrap" style={{ color: 'var(--sol-text-faint)' }}>
          {wt.ahead > 0 && `↑${wt.ahead}`}{wt.ahead > 0 && wt.behind > 0 && ' '}{wt.behind > 0 && `↓${wt.behind}`}
        </span>
      )}
      {wt.dirty && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-warning)' }} />
      )}
    </>
  )
}

export function WorktreePicker({ worktrees, activeWorktree, onSelect, open, onOpenChange }: WorktreePickerProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  // Nothing to pick (non-git project, or the list is still loading): render no
  // affordance. The header toggle guards on the same count.
  if (worktrees.length === 0) return null

  const current = currentWorktreeEntry(worktrees, activeWorktree)
  // A gone/stale selection resolves to primary → treated as "on primary" (no indicator).
  const onPrimary = !current || current.isPrimary

  return (
    <>
      {onPrimary ? (
        // Primary active: nothing persistent — just a zero-height anchor at the top of
        // the body so the dropdown (opened from the header toggle) has something to
        // drop from.
        <div ref={anchorRef} className="mx-1" />
      ) : (
        // Non-primary active: the persistent indicator box (Compare-ref styling). A
        // clickable region opens the dropdown; a sibling X removes the worktree (→
        // primary). The two affordances are siblings (no nested interactive element).
        <div
          ref={anchorRef}
          className="mx-1 mt-1 rounded-md"
          style={{
            borderTop: '2px solid var(--sol-accent)',
            backgroundColor: 'color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))',
          }}
        >
          <div className="flex items-center h-[24px] mx-1 my-1 gap-1">
            <div
              role="button"
              aria-label={`Worktree: ${current!.branch}`}
              className="flex flex-1 min-w-0 items-center h-full cursor-pointer rounded-sm px-1 gap-1.5"
              style={{ transition: 'background-color 120ms' }}
              onClick={() => onOpenChange(!open)}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <span
                className="shrink-0 text-ui-2xs uppercase tracking-wider font-semibold"
                style={{ color: 'var(--sol-text)' }}
              >worktree</span>
              <span
                className="flex-1 text-ui-md truncate font-medium"
                style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}
              >{current!.branch}</span>
              <WorktreeMeta wt={current!} />
              <ChevronDown
                size={10}
                className="shrink-0"
                style={{
                  color: open ? 'var(--sol-accent)' : 'var(--sol-text)',
                  transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1), color 120ms',
                }}
              />
            </div>
            <button
              type="button"
              aria-label="Remove worktree (return to primary)"
              title="Remove worktree (return to primary)"
              className="flex items-center justify-center shrink-0 w-[18px] h-[18px] rounded-sm"
              style={{ color: 'var(--sol-text)', transition: 'color 120ms, background-color 120ms' }}
              onClick={() => onSelect(null)}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--sol-accent)'; e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--sol-text)'; e.currentTarget.style.backgroundColor = '' }}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      <WorktreeDropdown
        open={open}
        anchorRef={anchorRef}
        worktrees={worktrees}
        activeWorktree={activeWorktree}
        onSelect={id => { onSelect(id); onOpenChange(false) }}
        onClose={() => onOpenChange(false)}
      />
    </>
  )
}

/** The floating worktree list — the RefSearchDropdown idiom (DialogShell, position:fixed,
 *  anchored), restyled for worktrees. No search input (the list is short). */
function WorktreeDropdown({ open, anchorRef, worktrees, activeWorktree, onSelect, onClose }: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
}) {
  // Position from the anchor in an effect (avoid ref access during render), matching
  // RefSearchDropdown.
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({ position: 'fixed', left: 0, top: 0, width: 200 })
  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPosStyle({ position: 'fixed', left: rect.left, top: rect.bottom + 2, width: Math.max(rect.width, 200) })
  }, [open, anchorRef])

  // Focus starts on the active row (or the first), so keyboard users land usefully.
  const activeIdx = Math.max(0, worktrees.findIndex(wt =>
    wt.isPrimary ? activeWorktree === null : wt.id === activeWorktree))
  const [focusIdx, setFocusIdx] = useState(activeIdx)

  if (!open) return null

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      // Do NOT restore focus to the trigger on close. The picker can be opened from the
      // header GitBranch *button*; a worktree switch does NOT remount the workspace, so
      // restoring focus would leave that button focused after a selection — and a later
      // stray Enter (e.g. confirming a quick-open) would re-activate it and reopen the
      // picker. Compare ref avoids this because its trigger is a body <div>, not a button.
      restoreFocus={false}
      className="rounded-lg overflow-hidden z-50"
      style={posStyle}
    >
      <div role="listbox" aria-label="Worktrees" className="flex flex-col max-h-[min(320px,50vh)] overflow-y-auto py-1">
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
              <WorktreeMeta wt={wt} />
              <Check size={12} className="shrink-0" style={{ opacity: isActive ? 1 : 0 }} />
            </button>
          )
        })}
      </div>
    </DialogShell>
  )
}
