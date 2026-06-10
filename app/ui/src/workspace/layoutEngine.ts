// Layout engine flag — the migration valve that decides whether the desktop
// renders through the legacy fixed skeleton (`WorkspaceLayout`) or the new
// panel-tree renderer (`DesktopPanelTreeLayout`).
//
// Design (phase 5 / desktop-tree-renderer): the tree renderer ships behind a
// migration-window flag, not a hard cutover. The DEFAULT is `legacy` so existing
// behavior is untouched; flipping to `tree` is opt-in per the URL query
// (`?panelTree=1`) or a localStorage key (`yaco-panel-tree`), so a single user can
// flip back instantly on any subtle breakage. This valve is deleted in phase 8.
//
// It is intentionally NOT persisted in the panel-layout model — keeping it out of
// the stored shape means the flag is purely additive and never migrates.

export type LayoutEngine = 'legacy' | 'tree'

const STORAGE_KEY = 'yaco-panel-tree'

/** Resolve the active layout engine. Precedence: an explicit `?panelTree=0|1`
 *  query wins (so a URL can force either engine for a session), then the
 *  `yaco-panel-tree` localStorage key (`'tree'` opts in), else `legacy`. Any
 *  access failure (no window, blocked storage) falls back to `legacy`. */
export function resolveLayoutEngine(): LayoutEngine {
  if (typeof window === 'undefined') return 'legacy'
  try {
    const param = new URLSearchParams(window.location.search).get('panelTree')
    if (param === '1') return 'tree'
    if (param === '0') return 'legacy'
    if (window.localStorage.getItem(STORAGE_KEY) === 'tree') return 'tree'
  } catch {
    // Unavailable/blocked storage or a malformed URL — keep the safe default.
  }
  return 'legacy'
}
