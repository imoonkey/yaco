import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { ProviderIcon } from './SessionIcons'
import { UsageCards } from './UsageCards'
import {
  compactGroups, highestPercent, remainingTime, localTime, summaryLabel, tone, type UsageState,
} from './usageModel'

function quotaFill(percent: number): CSSProperties {
  return {
    '--usage-fill': `${Math.min(100, Math.max(0, percent))}%`,
    '--usage-fill-color': tone(percent),
  } as CSSProperties
}

interface UsageQuotaRailProps {
  state: UsageState
}

export function UsageQuotaRail({ state }: UsageQuotaRailProps) {
  const { data, error, loading, refresh, refreshing } = state
  const [open, setOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => compactGroups(data), [data])

  useEffect(() => {
    const id = setInterval(() => { setNowMs(Date.now()) }, 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const unavailable = error && !data
  const label = summaryLabel(groups)

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="usage-quota-shell flex h-8 max-w-full overflow-hidden rounded-lg border">
        <div
          className="usage-quota-summary flex min-w-0 flex-1 items-stretch overflow-hidden"
          style={{ color: 'var(--sol-text-dark)' }}
        >
        {loading && !data && (
          <span className="flex items-center px-3 text-ui-xs">Loading usage…</span>
        )}
        {unavailable && (
          <span className="flex items-center gap-1.5 px-3 text-ui-xs" style={{ color: 'var(--sol-red)' }}>
            Usage unavailable
            <ChevronDown size={11} />
          </span>
        )}
        {!loading && !unavailable && groups.length === 0 && (
          <span className="flex items-center px-3 text-ui-xs">No quota reported</span>
        )}

        {groups.length > 0 && (
          <>
            <span className="flex items-center gap-2.5 px-2.5 lg:hidden">
              {groups.map((group) => (
                <span key={group.key} className="flex items-center gap-1 text-ui-md whitespace-nowrap">
                  <ProviderIcon provider={group.key} className="h-4 w-4 shrink-0" />
                  {highestPercent(group.metrics) === null ? (
                    <span style={{ color: 'var(--sol-text-faint)' }}>—</span>
                  ) : (
                    <span
                      className="text-ui-lg tabular-nums font-semibold"
                      style={{ color: tone(highestPercent(group.metrics) ?? 0), fontFamily: 'var(--font-mono)' }}
                    >
                      {Math.round(highestPercent(group.metrics) ?? 0)}%
                    </span>
                  )}
                </span>
              ))}
            </span>

            <span className="hidden items-center lg:flex">
              {groups.map((group, groupIndex) => (
                <span
                  key={group.key}
                  className={`flex h-full items-stretch ${groupIndex > 0 ? 'border-l' : ''}`}
                  style={{ borderColor: 'var(--sol-border)' }}
                >
                  <span
                    className="flex items-center px-2.5"
                    title={group.label}
                  >
                    <ProviderIcon provider={group.key} className="h-[18px] w-[18px] shrink-0" />
                  </span>
                  {group.metrics.map((item) => (
                    <span
                      key={item.key}
                      className="usage-quota-metric flex items-center gap-1 px-2.5 whitespace-nowrap text-ui-md"
                      style={quotaFill(item.percent)}
                    >
                      <span className="font-semibold" style={{ color: 'var(--sol-text-dark)' }}>{item.label}</span>{' '}
                      <span
                        className="text-ui-lg tabular-nums font-semibold"
                        style={{ color: tone(item.percent), fontFamily: 'var(--font-mono)', letterSpacing: '-0.03em' }}
                      >
                        {Math.round(item.percent)}%
                      </span>
                      <span
                        className="hidden text-ui-sm tabular-nums min-[1360px]:inline"
                        style={{ color: 'var(--sol-text)', fontFamily: 'var(--font-mono)' }}
                        title={item.resetsAt ? `Resets ${localTime(item.resetsAt)}` : 'Reset time not reported'}
                      >
                        · {remainingTime(item.resetsAt, nowMs)}
                      </span>
                    </span>
                  ))}
                </span>
              ))}
            </span>
          </>
        )}
        </div>
        <button
          type="button"
          onClick={() => { void refresh() }}
          disabled={refreshing}
          aria-label="Refresh usage"
          title={refreshing ? 'Refreshing usage…' : 'Refresh usage'}
          className="usage-quota-refresh flex w-7 shrink-0 items-center justify-center border-l cursor-pointer disabled:cursor-default"
          style={{ color: 'var(--sol-text)', borderColor: 'var(--sol-border)', opacity: refreshing ? 0.55 : 1 }}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="usage-quota-details"
          aria-label={`${open ? 'Hide' : 'Show'} usage details${label ? `. ${label}` : ''}`}
          title={open ? 'Hide usage details' : 'Show usage details'}
          className="usage-quota-toggle flex w-7 shrink-0 items-center justify-center cursor-pointer"
          style={{ color: 'var(--sol-text-dark)' }}
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {open && (
        <div
          id="usage-quota-details"
          role="region"
          aria-label="Usage details"
          className="usage-quota-popover absolute left-1/2 top-full z-30 mt-1.5 w-[560px] max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-xl border p-3.5"
        >
          <div>
            <span>
              <span className="text-ui-xl font-semibold" style={{ color: 'var(--sol-text-dark)' }}>Usage</span>
              <span className="ml-2 text-ui-md" style={{ color: 'var(--sol-text)' }}>Quota consumed</span>
            </span>
          </div>

          {error && (
            <div role="status" className="mt-2 text-ui-xs" style={{ color: 'var(--sol-red)' }}>
              {error.message}
            </div>
          )}
          {loading && !data && (
            <div className="mt-2 text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>Loading usage…</div>
          )}

          <UsageCards groups={groups} className="mt-3 grid-cols-1 sm:grid-cols-2" />
        </div>
      )}
    </div>
  )
}
