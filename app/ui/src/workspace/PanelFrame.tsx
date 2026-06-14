// PanelFrame — the framed/unframed wrapper chrome a panel renders inside.
//
// Design: framed panels (projects/files/changes/sessions) share a panel header
// derived from `SectionHeader`; unframed panels (editor/terminal/tasks) already
// own their chrome, so the frame is a passthrough. A framed panel publishes its
// dynamic title/actions/badge/stats through a panel-local `useHeader` hook (see
// panelRegistry) that this frame lays out.
//
// Collapse + body sizing come from a renderer-supplied `PanelChromeSlot` (see
// panelChrome): the framed header IS a `SectionHeader` (role="button",
// aria-expanded, "<title> section" label, chevron, actions hidden while
// collapsed) wired to the slot's collapse state, and the body hides when
// collapsed and adopts the slot's height/flex so it measures like the old
// per-section body wrapper. No slot ⇒ expanded, default fill (isolation tests
// and renderers that do not size sections both rely on this).
import { useContext, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import type { PanelHeaderHook } from './panelRegistry'
import type { PanelChrome } from './panelMeta'
import type { PanelChromeSlot } from './panelChrome'
import type { PanelId } from './context'
import { WorkspaceCommandsContext } from './context'
import { SectionHeader } from './SectionHeader'
import { usePanelInstance } from './panelInstance'
import { useDragControls } from './WorkspaceDragContext'
import { Menu, MenuItem } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'

export type PanelFrameProps = {
  chrome: PanelChrome
  title: string
  /** Panel-local hook publishing the header's dynamic title/actions/badge/stats.
   *  Omitted for headers with none, and ignored for unframed chrome. */
  useHeader?: PanelHeaderHook
  /** Renderer-supplied collapse + body sizing. Omitted ⇒ expanded, default fill. */
  slot?: PanelChromeSlot
  /** The hosted panel's id. Supplied by `PanelHost` so the framed header can
   *  expose the dock drag grip; omitted by isolation tests that mount a frame
   *  directly, which then render no grip. */
  panelId?: PanelId
  children: ReactNode
}

// A header that publishes nothing. Stable module constant so a framed panel
// without a `useHeader` always calls one consistent hook in `FramedHeader`.
const EMPTY_HEADER: PanelHeaderHook = () => ({})

const NOOP = () => {}

export function PanelFrame({ chrome, title, useHeader, slot, panelId, children }: PanelFrameProps) {
  if (chrome === 'unframed') return <>{children}</>

  const collapsed = slot?.collapsed ?? false
  return (
    <div className={slot?.containerClassName ?? 'flex flex-col h-full min-h-0'} style={slot?.containerStyle}>
      <FramedHeader
        title={title}
        useHeader={useHeader ?? EMPTY_HEADER}
        collapsed={collapsed}
        onToggle={slot?.onToggle ?? NOOP}
        panelId={panelId}
      />
      {!collapsed && (
        <div className={slot?.bodyClassName ?? 'flex-1 min-h-0 overflow-auto'} style={slot?.bodyStyle}>
          {children}
        </div>
      )}
    </div>
  )
}

function FramedHeader({ title, useHeader, collapsed, onToggle, panelId }: {
  title: string; useHeader: PanelHeaderHook; collapsed: boolean; onToggle: () => void; panelId?: PanelId
}) {
  const { title: dynamicTitle, actions, badge, stats } = useHeader()
  const instance = usePanelInstance()
  const drag = useDragControls()
  const commands = useContext(WorkspaceCommandsContext)
  const resetMenu = useContextMenu()
  // The dock grab handle is the rightmost header affordance and the drag SOURCE for
  // framed docks. Right-click/long-press on the same grip exposes the one recovery
  // action that DnD does not replace: Reset layout.
  const grab = panelId ? (
    <>
      <button type="button" draggable={!collapsed}
        onDragStart={(e) => drag.start(e, { kind: 'dock', instanceId: instance?.instanceId ?? panelId, panel: panelId })}
        onDragEnd={drag.clear}
        aria-label={`Move ${dynamicTitle ?? title} panel`} title="Drag to move panel; right-click or long-press to reset layout"
        aria-haspopup={commands ? 'menu' : undefined}
        className="flex items-center justify-center w-4 h-4 cursor-grab active:cursor-grabbing"
        style={{ color: 'var(--sol-text-faint)' }}
        {...(commands ? resetMenu.bind() : {})}>
        <GripVertical size={13} aria-hidden="true" />
      </button>
      {commands && resetMenu.position && (
        <Menu position={resetMenu.position} exiting={resetMenu.exiting} armed={resetMenu.armed} focusOnOpen={resetMenu.focusOnOpen} onExitDone={resetMenu.onExitDone}>
          <MenuItem label="Reset layout" onClick={() => { commands.resetLayout(); resetMenu.close() }} />
        </Menu>
      )}
    </>
  ) : null
  const headerActions = panelId
    ? <div className="flex items-center gap-0.5">{actions}{grab}</div>
    : actions
  return (
    <SectionHeader
      title={dynamicTitle ?? title}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={headerActions}
      badge={badge}
      stats={stats}
    />
  )
}
