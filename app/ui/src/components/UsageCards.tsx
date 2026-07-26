// The per-provider quota cards — one card per provider, one meter per window.
// Shared by the desktop rail popover (two columns) and the mobile sheet (one).
import { Clock3 } from 'lucide-react'
import { ProviderIcon } from './SessionIcons'
import {
  displayWindowLabel, localTime, meterTone, orderedWindows, tone, windowLabel, type UsageGroup,
} from './usageModel'

export function UsageCards({ groups, className = '' }: { groups: UsageGroup[]; className?: string }) {
  if (groups.length === 0) return null
  return (
    <div className={`grid gap-2.5 ${className}`}>
      {groups.map((group) => (
        <section key={group.key} className="usage-quota-card rounded-lg border p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-ui-lg font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
              <ProviderIcon provider={group.key} className="h-4 w-4 shrink-0" />
              {group.label}
            </h3>
            <span className="rounded px-1.5 py-0.5 text-ui-sm font-medium uppercase tracking-wide" style={{ color: 'var(--sol-text-dim)', backgroundColor: 'var(--sol-subtle-bg)' }}>
              {group.usage.plan ?? ''}
            </span>
          </div>
          <div className="mt-0.5 text-ui-sm" style={{ color: 'var(--sol-text)' }}>
            Checked {localTime(group.usage.checkedAt)}
          </div>

          {group.usage.error && (
            <div className="mt-1 text-ui-xs" style={{ color: 'var(--sol-red)' }}>
              {group.usage.error.message}
            </div>
          )}
          {group.usage.windows.length === 0 && !group.usage.error && (
            <div className="mt-1 text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>No quota windows reported</div>
          )}
          <div className="mt-2.5 space-y-2.5">
            {orderedWindows(group).map((window) => (
              <div key={`${group.key}:${window.window}:${window.scope ?? 'all'}`}>
                <div className="flex items-baseline justify-between gap-2 text-ui-md">
                  <span className="truncate font-medium" title={windowLabel(window)} style={{ color: 'var(--sol-text)' }}>
                    {displayWindowLabel(window)}
                  </span>
                  <span
                    className="shrink-0 text-ui-lg tabular-nums font-semibold"
                    style={{ color: tone(window.percent), fontFamily: 'var(--font-mono)', letterSpacing: '-0.03em' }}
                  >
                    {Math.round(window.percent)}% used
                  </span>
                </div>
                <div className="usage-quota-progress mt-1 h-1 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, window.percent)}%`, backgroundColor: meterTone(window.percent) }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-1 text-ui-sm tabular-nums" style={{ color: 'var(--sol-text)', fontFamily: 'var(--font-mono)' }}>
                  <Clock3 size={11} />
                  {window.resetsAt ? localTime(window.resetsAt) : 'Reset not reported'}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
