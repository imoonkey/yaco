// WorkspaceLayoutShell — the engine switch (design: phase 5 / WorkspaceLayoutShell).
//
// It chooses the desktop renderer off the SAME workspace contexts: `engine:
// 'tree'` mounts the new `DesktopPanelTreeLayout`, `engine: 'legacy'` keeps the
// existing `WorkspaceLayout` skeleton. The DEFAULT is legacy (see
// `resolveLayoutEngine`), so existing behavior is untouched until the flag is
// flipped. The tree renderer is desktop-only in this phase — mobile keeps the
// legacy projection until phase 6 — so a mobile viewport always falls back to the
// legacy renderer regardless of engine.
//
// Both renderers consume the identical `WorkspaceLayoutProps` from
// `WorkspaceScreen`; the tree renderer reads layout/commands/selection from
// context and needs only the cross-cutting shell bits (root ref, the quick-open
// overlay, and the interaction-capture that arms the close shortcut).
import { useState } from 'react'
import { WorkspaceLayout, type WorkspaceLayoutProps } from './WorkspaceLayout'
import { DesktopPanelTreeLayout } from './DesktopPanelTreeLayout'
import { resolveLayoutEngine } from './layoutEngine'

export function WorkspaceLayoutShell(props: WorkspaceLayoutProps) {
  // Resolve once per mount: the flag is a session-stable URL/localStorage read.
  const [engine] = useState(resolveLayoutEngine)

  if (engine === 'tree' && !props.isMobile) {
    return (
      <DesktopPanelTreeLayout
        rootRef={props.rootRef}
        searchOverlay={props.searchOverlay}
        onInteractionCapture={props.onInteractionCapture}
      />
    )
  }
  return <WorkspaceLayout {...props} />
}
