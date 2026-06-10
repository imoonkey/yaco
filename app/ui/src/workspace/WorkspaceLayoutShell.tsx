// WorkspaceLayoutShell — the engine switch (design: phase 5 / WorkspaceLayoutShell).
//
// It chooses the renderer off the SAME workspace contexts: `engine: 'tree'`
// mounts the new panel-tree renderers (`DesktopPanelTreeLayout` on desktop,
// `MobilePanelProjection` on mobile), `engine: 'legacy'` keeps the existing
// `WorkspaceLayout` skeleton for both. The DEFAULT is legacy (see
// `resolveLayoutEngine`), so existing behavior is untouched until the flag is
// flipped, and either renderer can roll back instantly on a subtle breakage.
//
// Both renderers consume the identical `WorkspaceLayoutProps` from
// `WorkspaceScreen`; the tree renderers read layout/commands/selection/env from
// context and need only the cross-cutting shell bits (root ref, the quick-open
// overlay, and the interaction-capture that arms the close shortcut).
import { useState } from 'react'
import { WorkspaceLayout, type WorkspaceLayoutProps } from './WorkspaceLayout'
import { DesktopPanelTreeLayout } from './DesktopPanelTreeLayout'
import { MobilePanelProjection } from './MobilePanelProjection'
import { resolveLayoutEngine } from './layoutEngine'

export function WorkspaceLayoutShell(props: WorkspaceLayoutProps) {
  // Resolve once per mount: the flag is a session-stable URL/localStorage read.
  const [engine] = useState(resolveLayoutEngine)

  if (engine === 'tree') {
    const shell = {
      rootRef: props.rootRef,
      searchOverlay: props.searchOverlay,
      onInteractionCapture: props.onInteractionCapture,
    }
    return props.isMobile
      ? <MobilePanelProjection {...shell} />
      : <DesktopPanelTreeLayout {...shell} />
  }
  return <WorkspaceLayout {...props} />
}
