// Mobile usage chrome: a header icon that carries the peak quota number, opening
// a bottom sheet with the SAME provider cards the desktop rail's popover shows
// (single column). Mobile has no room for the desktop rail, so the icon is the
// glance surface and the sheet is the detail.
import { useMemo, useState, type ReactNode } from 'react'
import { Gauge, RefreshCw, X } from 'lucide-react'
import { DialogShell, useDialogClose } from './DialogShell'
import { UsageCards } from './UsageCards'
import { compactGroups, peakPercent, summaryLabel, tone, type UsageGroup, type UsageState } from './usageModel'

export function MobileUsageIndicator({ state, size = 15 }: { state: UsageState; size?: number }) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => compactGroups(state.data), [state.data])
  const peak = peakPercent(groups)
  const summary = summaryLabel(groups)

  return (
    <>
      <span className="relative flex shrink-0 items-center">
        <button
          type="button"
          className="chrome-icon-btn flex h-7 w-7 cursor-pointer items-center justify-center rounded"
          onClick={() => setOpen(true)}
          title="Usage"
          aria-label={summary ? `Usage. ${summary}` : 'Usage'}
        >
          <Gauge size={size} />
        </button>
        {peak !== null && (
          <span
            className="pointer-events-none absolute -top-0.5 -right-1 flex h-[13px] min-w-[15px] items-center justify-center rounded-full px-[2px] text-ui-2xs font-bold tabular-nums"
            style={{
              fontFamily: 'var(--font-mono)',
              color: tone(peak),
              backgroundColor: `color-mix(in srgb, ${tone(peak)} 15%, var(--sol-bg))`,
            }}
          >
            {Math.round(peak)}
          </span>
        )}
      </span>

      {open && <UsageSheet state={state} groups={groups} onClose={() => setOpen(false)} />}
    </>
  )
}

function SheetCloseButton({ className, children, label }: { className: string; children: ReactNode; label?: string }) {
  const close = useDialogClose()
  return (
    <button type="button" onClick={close ?? undefined} className={className} aria-label={label} title={label}>
      {children}
    </button>
  )
}

function UsageSheet({ state, groups, onClose }: { state: UsageState; groups: UsageGroup[]; onClose: () => void }) {
  const { data, error, loading, refresh, refreshing } = state
  return (
    <DialogShell
      onClose={onClose}
      animation="sheet"
      overlayClassName="z-50 items-end justify-center"
      className="flex max-h-[82vh] w-full max-w-[560px] flex-col rounded-t-2xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      ariaLabelledBy="mobile-usage-title"
    >
      {/* Grab handle — tapping it dismisses, matching the task-detail sheet. */}
      <SheetCloseButton className="flex shrink-0 cursor-pointer justify-center pt-2 pb-1" label="Close usage">
        <span className="h-1 w-10 rounded-full" style={{ backgroundColor: 'var(--sol-base1)' }} />
      </SheetCloseButton>

      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pb-2">
        <span className="min-w-0">
          <span id="mobile-usage-title" className="text-ui-xl font-semibold" style={{ color: 'var(--sol-text-dark)' }}>Usage</span>
          <span className="ml-2 text-ui-md" style={{ color: 'var(--sol-text)' }}>Quota consumed</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => { void refresh() }}
            disabled={refreshing}
            aria-label="Refresh usage"
            title={refreshing ? 'Refreshing usage…' : 'Refresh usage'}
            className="chrome-icon-btn flex h-8 w-8 cursor-pointer items-center justify-center rounded disabled:cursor-default"
            style={{ opacity: refreshing ? 0.55 : 1 }}
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <SheetCloseButton
            className="chrome-icon-btn flex h-8 w-8 cursor-pointer items-center justify-center rounded"
            label="Close usage details"
          >
            <X size={16} />
          </SheetCloseButton>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        {error && (
          <div role="status" className="mb-2 text-ui-xs" style={{ color: 'var(--sol-red)' }}>
            {error.message}
          </div>
        )}
        {loading && !data && (
          <div className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>Loading usage…</div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>No quota reported</div>
        )}
        <UsageCards groups={groups} className="grid-cols-1" />
      </div>
    </DialogShell>
  )
}
