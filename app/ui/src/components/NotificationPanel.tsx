import { useState, useEffect } from 'react'
import { X, AlertTriangle, CornerDownLeft, History, SquareTerminal, ListChecks } from 'lucide-react'
import { DialogShell, useDialogClose } from './DialogShell'
import { badgeColorVar, badgeTint, tierColor } from '../lib/attentionColors'
import { identityKey, stateLabel, noticeContent } from '../lib/attentionContent'
import type { AttentionItem, BadgeColor } from '../hooks/useAttention'

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function PanelCloseButton() {
  const close = useDialogClose()
  return (
    <button onClick={close ?? undefined} className="cursor-pointer" style={{ color: 'var(--sol-text)' }}>
      <X size={14} />
    </button>
  )
}

function Row({ item, muted, onClick, onDismiss }: {
  item: AttentionItem
  muted: boolean
  onClick: (item: AttentionItem) => void
  /** When provided, render a per-row dismiss (×) that tombstones this generation
   *  WITHOUT triggering the row's navigation (stops propagation). Needs-you only. */
  onDismiss?: (item: AttentionItem) => void
}) {
  const accent = tierColor(item.tier)
  const accentVar = accent ? badgeColorVar(accent) : null
  const notice = noticeContent(item)
  // Kind glyph distinguishes an agent session from a task-graph node — they route
  // to different places on click. Faint, so the colored state label keeps emphasis.
  const isTask = item.subject.kind === 'task'
  const KindIcon = isTask ? ListChecks : SquareTerminal
  // The state label leads the content in its tier hue. Recent rows are muted —
  // they keep their original tier (a seen handoff stays gold), so tier-coloring
  // would blur them into Ready; the group greys them out instead.
  const labelColor = muted ? 'var(--sol-text-faint)' : (accentVar ?? 'var(--sol-text-faint)')
  return (
    <div
      className="notif-row px-3 py-2 cursor-pointer"
      style={{
        borderBottom: '1px solid var(--sol-border)',
        borderLeft: `3px solid ${muted ? 'transparent' : (accentVar ?? 'transparent')}`,
        '--notif-tint': muted ? 'transparent' : badgeTint(accent, 12),
        '--notif-tint-hover': muted || !accent ? 'var(--sol-hover-bg)' : badgeTint(accent, 22),
      } as React.CSSProperties}
      onClick={() => onClick(item)}
    >
      {/* Scan line: kind glyph + identity anchor it; project · time as faint meta. */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="shrink-0 flex" style={{ color: 'var(--sol-text-faint)' }} aria-label={isTask ? 'Task' : 'Session'}>
            <KindIcon size={13} />
          </span>
          <span className="text-ui-sm font-semibold truncate" style={{ color: muted ? 'var(--sol-text)' : 'var(--sol-text-dark)' }}>
            {identityKey(item)}
          </span>
        </span>
        {item.count > 1 && (
          <span
            className="text-ui-2xs font-semibold rounded px-1 shrink-0"
            style={{ backgroundColor: 'color-mix(in srgb, var(--sol-text-faint) 22%, transparent)', color: 'var(--sol-text-dim)' }}
          >
            {item.count}
          </span>
        )}
        <span className="flex items-center gap-1 shrink-0 text-ui-2xs" style={{ color: 'var(--sol-text-faint)' }}>
          <span className="truncate max-w-[96px]">{item.subject.project}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span className="whitespace-nowrap">{timeAgo(item.tsMs)}</span>
          {onDismiss && (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => { e.stopPropagation(); onDismiss(item) }}
              className="flex items-center cursor-pointer opacity-60 hover:opacity-100 ml-0.5"
            >
              <X size={12} />
            </button>
          )}
        </span>
      </div>
      {/* Content (the hero): colored state lead-in + the captured notice, 2 lines. */}
      <div className="text-ui-md line-clamp-2 mt-0.5" style={{ color: muted ? 'var(--sol-text-faint)' : 'var(--sol-text)', lineHeight: 'var(--lh-normal)' }}>
        <span className="font-semibold" style={{ color: labelColor }}>{stateLabel(item)}</span>
        {notice && <span style={{ color: 'var(--sol-text-faint)' }}> — </span>}
        {notice}
      </div>
    </div>
  )
}

function Section({
  label,
  Icon,
  tone,
  items,
  action,
  muted = false,
  onClickItem,
  onDismissItem,
}: {
  label: string
  Icon: typeof AlertTriangle
  tone: BadgeColor
  items: AttentionItem[]
  action?: React.ReactNode
  muted?: boolean
  onClickItem: (item: AttentionItem) => void
  onDismissItem?: (item: AttentionItem) => void
}) {
  if (items.length === 0) return null
  const toneVar = tone ? badgeColorVar(tone) : null
  return (
    <div>
      <div
        className="flex items-center justify-between px-3 py-1.5 sticky top-0 z-10"
        style={{
          backgroundColor: badgeTint(tone, 30, 'var(--sol-header-bg)'),
          borderBottom: `1px solid ${badgeTint(tone, 32, 'var(--sol-border)')}`,
        }}
      >
        <span className="flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--sol-text-brown)' }}>
          <Icon size={12} style={{ color: toneVar ?? 'var(--sol-text-faint)' }} />
          {label}
        </span>
        {action}
      </div>
      {items.map(item => <Row key={item.generation} item={item} muted={muted} onClick={onClickItem} onDismiss={onDismissItem} />)}
    </div>
  )
}

export function NotificationPanel({
  needsYou,
  ready,
  recent,
  onClickItem,
  onDismissNeedsYou,
  onClear,
  onMarkAllRead,
  onClose,
}: {
  needsYou: AttentionItem[]
  ready: AttentionItem[]
  recent: AttentionItem[]
  onClickItem: (item: AttentionItem) => void
  onDismissNeedsYou: (item: AttentionItem) => void
  onClear: () => void
  onMarkAllRead: () => void
  onClose: () => void
}) {
  // Force a re-render every 60s so relative timestamps stay fresh.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const empty = needsYou.length === 0 && ready.length === 0 && recent.length === 0

  // "Mark all read" clears both actionable sections (dismiss surfaced Needs-you +
  // ack Ready). Render it once, on the TOPMOST non-empty actionable section, so it
  // is reachable in a Needs-you-only snapshot (not just when Ready has rows).
  const markAllReadButton = (
    <button
      onClick={(e) => { e.stopPropagation(); onMarkAllRead() }}
      className="text-ui-sm cursor-pointer hover:underline"
      style={{ color: 'var(--sol-text)' }}
    >
      Mark all read
    </button>
  )

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      className="absolute right-0 top-8 z-50 rounded-xl w-[340px] max-w-[calc(100vw-24px)] max-h-[440px] flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--sol-glass-bg)' }}
    >
      <div className="flex items-center justify-between px-3 h-10 shrink-0" style={{ borderBottom: '1px solid var(--sol-border)' }}>
        <span className="text-ui-lg font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          Notifications
        </span>
        <PanelCloseButton />
      </div>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="px-3 py-6 text-center text-ui-md" style={{ color: 'var(--sol-text)' }}>
            Nothing needs you
          </div>
        ) : (
          <>
            <Section
              label="Needs you"
              Icon={AlertTriangle}
              tone="red"
              items={needsYou}
              onClickItem={onClickItem}
              onDismissItem={onDismissNeedsYou}
              action={needsYou.length > 0 ? markAllReadButton : undefined}
            />
            <Section
              label="Ready"
              Icon={CornerDownLeft}
              tone="yellow"
              items={ready}
              onClickItem={onClickItem}
              action={needsYou.length === 0 && ready.length > 0 ? markAllReadButton : undefined}
            />
            <Section
              label="Recent"
              Icon={History}
              tone={null}
              items={recent}
              muted
              onClickItem={onClickItem}
              action={recent.length > 0 ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onClear() }}
                  className="text-ui-sm cursor-pointer hover:underline"
                  style={{ color: 'var(--sol-text)' }}
                >
                  Clear
                </button>
              ) : undefined}
            />
          </>
        )}
      </div>
    </DialogShell>
  )
}
