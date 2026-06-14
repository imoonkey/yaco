// ChangesPanel — the framed Changes section as a self-contained panel.
//
// Design (ChangesPanel): owns compare mode, compare base/head refs, the compare
// fetch, `CompareRefPicker`, the changes list body, and the header stats/actions.
// Consumes the shared git status from the data context and opens diff tabs
// through commands. It is a pure consumer of the T1b contexts: it re-instantiates
// no poller (git changes/stats come from `data.git`).
//
// Header/body split: a framed panel publishes its dynamic header through the
// `useHeader` hook contract while its `Component` renders the body. PanelFrame
// renders those two as SIBLINGS, so they cannot share React local state. Compare
// state therefore lives in the module-scoped store below — keyed by
// (project, worktree) so it resets on a project/worktree switch (matching the
// original `WorkspaceScreen`, which remounted on that key) yet survives a
// collapse/hide. It never becomes a workspace context (design: "Compare state
// does not become global").
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { GitCompareArrows, X } from 'lucide-react'
import { GitChangeItem } from '../WorkspaceSidebar'
import { CompareRefPicker } from '../CompareRefPicker'
import { SectionRefreshButton } from '../SectionHeader'
import { fetchGitCompare } from '../../hooks/useApi'
import type { GitChange } from '../../types'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection, useWorkspaceCommands,
} from '../context'
import { PANEL_META } from '../panelMeta'
import type { PanelDefinition, PanelHeaderSlots } from '../panelRegistry'

// --- Panel-local compare store -------------------------------------------

type CompareResult = { files: GitChange[]; stats: { added: number; deleted: number }; key: string }
type CompareState = { mode: boolean; base: string; head: string; result: CompareResult | null }
type CompareSlot = CompareState & { key: string }

const DEFAULT_COMPARE: CompareState = { mode: false, base: 'main', head: 'HEAD', result: null }

// One slot, stamped with its (project, worktree) key. A key mismatch reads as the
// default, and the slot is DISCARDED the moment the active key changes (see
// `useCompareState`) — so navigating project A → B → A starts A fresh instead of
// resurrecting A's stale compare state, matching the original `WorkspaceScreen`
// which remounted (and reset) on that key.
let compareSlot: CompareSlot | null = null
const compareListeners = new Set<() => void>()

function compareKey(projectName: string, worktree?: string | null): string {
  return `${projectName}:${worktree ?? ''}`
}

function readCompare(key: string): CompareState {
  return compareSlot && compareSlot.key === key ? compareSlot : DEFAULT_COMPARE
}

function setCompare(key: string, patch: Partial<CompareState>): void {
  const current = compareSlot && compareSlot.key === key ? compareSlot : { key, ...DEFAULT_COMPARE }
  compareSlot = { ...current, ...patch, key }
  compareListeners.forEach((listener) => listener())
}

// Drop any slot held for a different key. Called when the active key changes so a
// later return to a previous key cannot read its stale state. Current-key readers
// already see the default (key mismatch), so no notify is needed.
function discardStaleCompare(key: string): void {
  if (compareSlot && compareSlot.key !== key) compareSlot = null
}

function subscribeCompare(listener: () => void): () => void {
  compareListeners.add(listener)
  return () => { compareListeners.delete(listener) }
}

function useCompareState(key: string): CompareState {
  // Reset on a project/worktree switch: discard a slot stamped for a prior key so
  // compare mode/refs/result start at the default for the new (project, worktree).
  useEffect(() => { discardStaleCompare(key) }, [key])
  return useSyncExternalStore(subscribeCompare, () => readCompare(key))
}

// Fetch the compare diff and store it. Shared by the body's refs effect and the
// header's refresh action. Mirrors the original `loadCompareResult`: on error,
// fall back to an empty result so the body shows "No differences", not a spinner.
async function loadCompare(
  key: string, projectName: string, base: string, head: string,
  worktree: string | null | undefined, signal?: AbortSignal,
): Promise<void> {
  if (!projectName) return
  const resultKey = `${base}:${head}`
  try {
    const result = await fetchGitCompare(projectName, base, head, worktree)
    if (!signal?.aborted) setCompare(key, { result: { files: result.files, stats: result.stats, key: resultKey } })
  } catch {
    if (!signal?.aborted) setCompare(key, { result: { files: [], stats: { added: 0, deleted: 0 }, key: resultKey } })
  }
}

// --- Body ----------------------------------------------------------------

// This file's public export is the panel definition (object), not the body, so
// fast-refresh's "only export components" cannot apply — the body and header are
// internal to the panel and reached through the def.
// eslint-disable-next-line react-refresh/only-export-components
function ChangesPanelBody() {
  const env = useWorkspaceEnv()
  const { git } = useWorkspaceDataContext()
  const { activeEditorTabId } = useWorkspaceSelection()
  const { openDiff, openDiffTabId, expandFolderInFiles, revealPathInFiles } = useWorkspaceCommands()
  const { name: projectName, worktree } = env.project
  const key = compareKey(projectName, worktree)
  const { mode, base, head, result } = useCompareState(key)

  const compareFiles = result?.files ?? []
  const compareLoading = mode && result?.key !== `${base}:${head}`

  // Fetch compare data when refs (or project/worktree) change, mirroring the
  // original screen effect — aborting an in-flight load on change/unmount.
  useEffect(() => {
    if (!mode || !projectName) return
    const controller = new AbortController()
    void loadCompare(key, projectName, base, head, worktree, controller.signal)
    return () => controller.abort()
  }, [mode, base, head, projectName, worktree, key])

  if (mode) {
    return (
      <>
        <CompareRefPicker
          base={base}
          compare={head}
          onChange={(b, c) => setCompare(key, { base: b, head: c })}
          projectName={projectName}
        />
        {compareLoading && (
          <div className="changes-skeleton">
            <div className="changes-skeleton-row" style={{ width: '85%' }} />
            <div className="changes-skeleton-row" style={{ width: '60%' }} />
            <div className="changes-skeleton-row" style={{ width: '72%' }} />
            <div className="changes-skeleton-row" style={{ width: '50%' }} />
          </div>
        )}
        {!compareLoading && compareFiles.map((c) => {
          const tabId = `diff:${c.path}?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(head)}`
          return (
            <GitChangeItem key={c.path} change={c}
              isActive={activeEditorTabId === tabId}
              onActivate={() => openDiffTabId(tabId)}
              onOpenPinned={() => openDiffTabId(tabId, { preview: false })}
              onPathClick={revealPathInFiles}
            />
          )
        })}
        {!compareLoading && compareFiles.length === 0 && (
          <div className="flex flex-col items-center py-4 gap-1">
            <span className="text-ui-sm font-medium" style={{ color: 'var(--sol-text)' }}>No differences</span>
            <span className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>These refs are identical</span>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {git.changes.map((c) => {
        const isDir = c.path.endsWith('/')
        return (
          <GitChangeItem key={c.path} change={c}
            isActive={!isDir && activeEditorTabId === `diff:${c.path}`}
            onActivate={isDir ? () => expandFolderInFiles(c.path.slice(0, -1)) : () => openDiff(c.path)}
            onOpenPinned={isDir ? undefined : () => openDiff(c.path, { preview: false })}
            onPathClick={isDir ? expandFolderInFiles : revealPathInFiles}
          />
        )
      })}
      {git.changes.length === 0 && (
        <div className="flex flex-col items-center py-4 gap-1">
          <span className="text-ui-sm font-medium" style={{ color: 'var(--sol-text)' }}>No changes</span>
          <span className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>Working tree is clean</span>
        </div>
      )}
    </>
  )
}

// --- Header --------------------------------------------------------------

function useChangesHeader(): PanelHeaderSlots {
  const env = useWorkspaceEnv()
  const { git } = useWorkspaceDataContext()
  const { name: projectName, worktree } = env.project
  const key = compareKey(projectName, worktree)
  const { mode, base, head, result } = useCompareState(key)

  const compareFiles = result?.files ?? []
  const rawStats = mode ? result?.stats : git.stats
  const stats: ReactNode = rawStats && (rawStats.added > 0 || rawStats.deleted > 0) ? (
    <span className="flex items-center gap-1 text-ui-xs font-semibold mr-1" style={{ letterSpacing: '-0.01em' }}>
      {rawStats.added > 0 && <span style={{ color: 'var(--sol-green)' }}>+{rawStats.added}</span>}
      {rawStats.deleted > 0 && <span style={{ color: 'var(--sol-red)' }}>-{rawStats.deleted}</span>}
    </span>
  ) : undefined

  const handleRefresh = () => (
    mode ? loadCompare(key, projectName, base, head, worktree) : git.refresh()
  )

  const actions = (
    <div className="flex gap-0.5 items-center">
      <button
        type="button"
        onClick={() => setCompare(key, { mode: !mode })}
        className="section-header-icon-btn"
        title={mode ? 'Exit compare mode' : 'Compare refs'}
        aria-label={mode ? 'Exit compare mode' : 'Compare refs'}
        aria-pressed={mode}
      >
        <GitCompareArrows />
      </button>
      {mode && (
        <button
          type="button"
          onClick={() => setCompare(key, { mode: false })}
          className="section-header-icon-btn"
          title="Exit compare mode"
          aria-label="Exit compare mode"
        >
          <X />
        </button>
      )}
      <SectionRefreshButton onClick={handleRefresh} title={mode ? 'Refresh compare' : 'Refresh changes'} />
    </div>
  )

  return {
    title: mode ? 'Compare' : (git.stale ? 'Changes (stale)' : 'Changes'),
    badge: mode ? (compareFiles.length || undefined) : (git.changes.length || undefined),
    stats,
    actions,
  }
}

// --- Definition ----------------------------------------------------------

export const changesPanelDef: PanelDefinition = {
  ...PANEL_META.changes,
  Component: ChangesPanelBody,
  useHeader: useChangesHeader,
}
