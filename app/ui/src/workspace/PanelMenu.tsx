// PanelMenu — the flexible-layout operations surfaced on a framed panel header.
//
// Design (T8 / flexible-operations): "Header/menu commands can move a panel,
// split beside a target panel, return a panel to default placement, and reset
// layout." This kebab menu is the UI for the panel-layout commands the model
// already implements (movePanel / splitPanel / resetLayout). Each menu action
// maps to one command:
//   - Move left / right → splitPanel beside the leftmost / rightmost OTHER
//     standalone leaf (a vertical split, so a wide panel never overflows the
//     narrow dock column the way a horizontal split would).
//   - Reset position    → movePanel(panel, { kind: 'default' }).
//   - Reset layout       → resetLayout().
//
// It is rendered only on the desktop tree (the layout it rearranges) and only
// when the workspace command/layout contexts are present — so the panel isolation
// tests, which mount a framed panel without those contexts, get no menu and are
// unaffected.
import { useContext } from 'react'
import { MoreVertical } from 'lucide-react'
import { Menu, MenuItem, MenuDivider } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'
import {
  WorkspaceCommandsContext, WorkspaceLayoutContext, WorkspaceEnvContext, type PanelId,
} from './context'
import { leafPanelsInOrder } from './panelLayoutModel'

export function PanelMenu({ panel }: { panel: PanelId }) {
  const commands = useContext(WorkspaceCommandsContext)
  const layoutCtx = useContext(WorkspaceLayoutContext)
  const env = useContext(WorkspaceEnvContext)
  const menu = useContextMenu()

  // Mobile projects no desktop tree, and the isolation tests omit these contexts;
  // either way there is nothing to rearrange, so render no menu.
  if (!commands || !layoutCtx || env?.viewport?.isMobile) return null

  // Relocation targets: the leftmost / rightmost OTHER visible standalone leaf.
  const others = leafPanelsInOrder(layoutCtx.panelLayout.desktop).filter((p) => p !== panel)
  const leftTarget = others[0]
  const rightTarget = others[others.length - 1]

  const run = (action: () => void) => () => { action(); menu.close() }

  return (
    <>
      <button
        type="button"
        className="section-header-icon-btn"
        title="Panel menu"
        aria-label="Panel menu"
        aria-haspopup="menu"
        onClick={menu.open}
      >
        <MoreVertical />
      </button>
      {menu.position && (
        <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
          {leftTarget && (
            <MenuItem label="Move left" onClick={run(() => commands.splitPanel(leftTarget, panel, 'above'))} />
          )}
          {rightTarget && (
            <MenuItem label="Move right" onClick={run(() => commands.splitPanel(rightTarget, panel, 'below'))} />
          )}
          <MenuItem label="Reset position" onClick={run(() => commands.movePanel(panel, { kind: 'default' }))} />
          <MenuDivider />
          <MenuItem label="Reset layout" onClick={run(() => commands.resetLayout())} />
        </Menu>
      )}
    </>
  )
}
