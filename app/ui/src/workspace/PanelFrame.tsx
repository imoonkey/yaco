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
import type { PanelHeaderHook } from './panelRegistry'
import type { PanelChrome } from './panelMeta'
import type { PanelChromeSlot } from './panelChrome'
import { SectionHeader } from './SectionHeader'

export type PanelFrameProps = {
  chrome: PanelChrome
  title: string
  /** Panel-local hook publishing the header's dynamic title/actions/badge/stats.
   *  Omitted for headers with none, and ignored for unframed chrome. */
  useHeader?: PanelHeaderHook
  /** Renderer-supplied collapse + body sizing. Omitted ⇒ expanded, default fill. */
  slot?: PanelChromeSlot
  children: ReactNode
}

// A header that publishes nothing. Stable module constant so a framed panel
// without a `useHeader` always calls one consistent hook in `FramedHeader`.
const EMPTY_HEADER: PanelHeaderHook = () => ({})

const NOOP = () => {}

export function PanelFrame({ chrome, title, useHeader, slot, children }: PanelFrameProps) {
  if (chrome === 'unframed') return <>{children}</>

  const collapsed = slot?.collapsed ?? false
  return (
    <div className={slot?.containerClassName ?? 'flex flex-col h-full min-h-0'} style={slot?.containerStyle}>
      <FramedHeader
        title={title}
        useHeader={useHeader ?? EMPTY_HEADER}
        collapsed={collapsed}
        onToggle={slot?.onToggle ?? NOOP}
      />
      {!collapsed && (
        <div className={slot?.bodyClassName ?? 'flex-1 min-h-0 overflow-auto'} style={slot?.bodyStyle}>
          {children}
        </div>
      )}
    </div>
  )
}

function FramedHeader({ title, useHeader, collapsed, onToggle }: {
  title: string; useHeader: PanelHeaderHook; collapsed: boolean; onToggle: () => void
}) {
  const { title: dynamicTitle, actions, badge, stats } = useHeader()
  return (
    <SectionHeader
      title={dynamicTitle ?? title}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={actions}
      badge={badge}
      stats={stats}
    />
  )
}
