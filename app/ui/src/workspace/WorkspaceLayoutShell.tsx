// WorkspaceLayoutShell — picks the panel-tree renderer for the viewport.
//
// The panel tree is the sole workspace renderer: the legacy flat skeleton
// (`WorkspaceLayout`) and the `engine` migration flag were removed in T8, so this
// shell simply mounts `DesktopPanelTreeLayout` on desktop and
// `MobilePanelProjection` on mobile. Both read layout/commands/selection/env from
// context and need only the cross-cutting shell bits: the root ref, the quick-open
// overlay, and the interaction-capture that arms the close shortcut.
import type { ReactNode, RefObject } from 'react'
import { DesktopPanelTreeLayout } from './DesktopPanelTreeLayout'
import { MobilePanelProjection } from './MobilePanelProjection'

export type WorkspaceLayoutShellProps = {
  isMobile: boolean
  rootRef: RefObject<HTMLDivElement | null>
  searchOverlay: ReactNode | null
  onInteractionCapture: () => void
}

export function WorkspaceLayoutShell({ isMobile, ...shell }: WorkspaceLayoutShellProps) {
  return isMobile
    ? <MobilePanelProjection {...shell} />
    : <DesktopPanelTreeLayout {...shell} />
}
