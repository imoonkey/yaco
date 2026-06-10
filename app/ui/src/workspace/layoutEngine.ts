// Layout engine flag — the migration valve that decides whether the desktop
// renders through the legacy fixed skeleton (`WorkspaceLayout`) or the new
// panel-tree renderer (`DesktopPanelTreeLayout`).
//
// Design (phase 5/6 → T6.5 cutover): the tree renderer shipped behind a
// migration-window flag, and T6.5 flips the DEFAULT to `tree` once parity is
// proven — so everyone renders through the panel tree by default and `legacy`
// becomes the explicit opt-out fallback for instant rollback on any subtle
// breakage, per the URL query (`?panelTree=0`) or the `yaco-panel-tree=legacy`
// localStorage key. This valve is deleted in phase 8.
//
// It is intentionally NOT persisted in the panel-layout model — keeping it out of
// the stored shape means the flag is purely additive and never migrates.

export type LayoutEngine = 'legacy' | 'tree'

const STORAGE_KEY = 'yaco-panel-tree'

/** Resolve the active layout engine. Precedence: an explicit `?panelTree=0|1`
 *  query wins (so a URL can force either engine for a session), then the
 *  `yaco-panel-tree` localStorage key (`'legacy'` opts out), else `tree` — the
 *  post-cutover default. Any access failure (no window, blocked storage) falls
 *  back to `tree`. */
export function resolveLayoutEngine(): LayoutEngine {
  if (typeof window === 'undefined') return 'tree'
  try {
    const param = new URLSearchParams(window.location.search).get('panelTree')
    if (param === '1') return 'tree'
    if (param === '0') return 'legacy'
    if (window.localStorage.getItem(STORAGE_KEY) === 'legacy') return 'legacy'
  } catch {
    // Unavailable/blocked storage or a malformed URL — keep the safe default.
  }
  return 'tree'
}
