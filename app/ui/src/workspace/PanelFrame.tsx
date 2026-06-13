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
import type { ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import type { PanelHeaderHook } from './panelRegistry'
import type { PanelChrome } from './panelMeta'
import type { PanelChromeSlot } from './panelChrome'
import type { PanelId } from './context'
import { SectionHeader } from './SectionHeader'
import { PanelMenu } from './PanelMenu'
import { usePanelInstance } from './panelInstance'
import { useDrag } from './WorkspaceDragContext'

export type PanelFrameProps = {
  chrome: PanelChrome
  title: string
  /** Panel-local hook publishing the header's dynamic title/actions/badge/stats.
   *  Omitted for headers with none, and ignored for unframed chrome. */
  useHeader?: PanelHeaderHook
  /** Renderer-supplied collapse + body sizing. Omitted ⇒ expanded, default fill. */
  slot?: PanelChromeSlot
  /** The hosted panel's id. Supplied by `PanelHost` so the framed header can
   *  surface the flexible-layout `PanelMenu`; omitted by isolation tests that
   *  mount a frame directly, which then render no menu. */
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
  const drag = useDrag()
  // The flexible-layout menu sits after the panel's own actions (rightmost), in a
  // single flex row so a panel that publishes its actions as a block element does
  // not push the kebab onto a second line (which would grow the fixed-height header
  // and shove the action row under the adjacent resize handle). The dock grab
  // handle leads the SAME row (one flex line) as the drag SOURCE for this dock —
  // dragstart records a `dock` payload tagged with our pane mime. Only present when
  // PanelHost supplies the id; SectionHeader hides actions (and so both) while
  // collapsed.
  const grab = panelId ? (
    <button type="button" draggable={!collapsed}
      onDragStart={(e) => drag.start(e, { kind: 'dock', instanceId: instance?.instanceId ?? panelId, panel: panelId })}
      onDragEnd={drag.clear}
      aria-label={`Move ${dynamicTitle ?? title} panel`} title="Drag to move panel"
      className="flex items-center justify-center w-4 h-4 cursor-grab active:cursor-grabbing"
      style={{ color: 'var(--sol-text-faint)' }}>
      <GripVertical size={13} aria-hidden="true" />
    </button>
  ) : null
  const headerActions = panelId
    ? <div className="flex items-center gap-0.5">{grab}{actions}<PanelMenu panel={panelId} /></div>
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
