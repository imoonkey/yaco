// PanelFrame — the framed/unframed wrapper chrome a panel renders inside.
//
// Design: framed panels (projects/files/changes/sessions) share a panel header
// derived from `SectionHeader`; unframed panels (editor/terminal/tasks) already
// own their chrome, so the frame is a passthrough. A framed panel publishes its
// dynamic title/actions/badge/stats through a panel-local `useHeader` hook (see
// panelRegistry) that this frame lays out. Collapse wiring (the `collapsePanel`
// command + layout state) lands in a later phase — this header is the static
// seam panels render into now.
import type { ReactNode } from 'react'
import type { PanelChrome, PanelHeaderHook } from './panelRegistry'

export type PanelFrameProps = {
  chrome: PanelChrome
  title: string
  /** Panel-local hook publishing the header's dynamic title/actions/badge/stats.
   *  Omitted for headers with none, and ignored for unframed chrome. */
  useHeader?: PanelHeaderHook
  children: ReactNode
}

// A header that publishes nothing. Stable module constant so a framed panel
// without a `useHeader` always calls one consistent hook in `FramedHeader`.
const EMPTY_HEADER: PanelHeaderHook = () => ({})

export function PanelFrame({ chrome, title, useHeader, children }: PanelFrameProps) {
  if (chrome === 'unframed') return <>{children}</>

  return (
    <div className="flex flex-col h-full min-h-0">
      <FramedHeader title={title} useHeader={useHeader ?? EMPTY_HEADER} />
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </div>
  )
}

function FramedHeader({ title, useHeader }: { title: string; useHeader: PanelHeaderHook }) {
  const { title: dynamicTitle, actions, badge, stats } = useHeader()
  return (
    <div
      className="section-header-bar flex items-center h-7 px-2 text-ui-sm font-semibold uppercase tracking-wider select-none shrink-0"
      style={{
        color: 'var(--sol-text-brown)',
        borderBottom: '1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)',
      }}
    >
      <span className="flex-1 truncate">{dynamicTitle ?? title}</span>
      {stats && <div className="flex items-center" onClick={(e) => e.stopPropagation()}>{stats}</div>}
      {badge != null && badge > 0 && (
        <span
          className="w-[18px] h-[14px] rounded-full text-ui-2xs flex items-center justify-center font-bold"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--sol-warning) 19%, transparent)',
            color: 'var(--sol-warning)',
          }}
        >
          {badge}
        </span>
      )}
      {actions && <div className="flex items-center">{actions}</div>}
    </div>
  )
}
