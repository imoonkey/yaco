import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronUp, Clock3, RefreshCw } from 'lucide-react'
import { ProviderIcon } from './SessionIcons'
import type { ProviderUsage, UsageWindow } from '../types'

interface UsageState {
  data: ProviderUsage[] | null
  error: Error | null
  loading: boolean
  refreshing: boolean
  refresh: () => Promise<void>
}

interface UsageQuotaRailProps {
  state: UsageState
}

interface UsageMetric {
  key: string
  label: string
  percent: number
  resetsAt?: string
}

interface UsageGroup {
  key: string
  label: string
  usage: ProviderUsage
  metrics: UsageMetric[]
}

const SPARK_SCOPE = 'GPT-5.3-Codex-Spark'

function parseTime(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function remainingTime(target: string | undefined, nowMs: number): string {
  const targetMs = parseTime(target)
  if (targetMs === null) return '—'
  const totalMinutes = Math.max(0, Math.round((targetMs - nowMs) / 60_000))
  if (totalMinutes === 0) return 'now'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  return `${minutes}m`
}

function localTime(value: string | undefined): string {
  const ms = parseTime(value)
  if (ms === null) return 'Not reported'
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

function tone(percent: number): string {
  if (percent >= 100) return 'var(--sol-red)'
  if (percent >= 95) return 'var(--sol-orange)'
  if (percent >= 80) return 'var(--sol-yellow)'
  return 'var(--sol-blue)'
}

function meterTone(percent: number): string {
  return percent >= 80 ? tone(percent) : 'var(--sol-blue)'
}

function quotaFill(percent: number): CSSProperties {
  return {
    '--usage-fill': `${Math.min(100, Math.max(0, percent))}%`,
    '--usage-fill-color': tone(percent),
  } as CSSProperties
}

function findWindow(
  usage: ProviderUsage,
  windowName: string,
  scope?: string,
): UsageWindow | undefined {
  return usage.windows.find((window) => (
    window.window === windowName
    && (scope === undefined ? window.scope === undefined : window.scope === scope)
  ))
}

function metric(key: string, label: string, window: UsageWindow | undefined): UsageMetric | null {
  if (!window) return null
  return { key, label, percent: window.percent, resetsAt: window.resetsAt }
}

function compactGroups(data: ProviderUsage[] | null): UsageGroup[] {
  if (!data) return []
  const groups: UsageGroup[] = []
  const claude = data.find((usage) => usage.provider === 'claude')
  if (claude) {
    groups.push({
      key: 'claude',
      label: 'Claude',
      usage: claude,
      metrics: [
        metric('claude-session', 'Session', findWindow(claude, 'session')),
        metric('claude-weekly', 'Weekly', findWindow(claude, 'weekly')),
        metric('claude-fable', 'Fable', findWindow(claude, 'weekly', 'Fable')),
      ].filter((value): value is UsageMetric => value !== null),
    })
  }

  const codex = data.find((usage) => usage.provider === 'codex')
  if (codex) {
    groups.push({
      key: 'codex',
      label: 'Codex',
      usage: codex,
      metrics: [
        metric('codex-7d', 'Weekly', findWindow(codex, '7d')),
      ].filter((value): value is UsageMetric => value !== null),
    })
  }
  return groups
}

function windowLabel(window: UsageWindow): string {
  return window.scope ? `${window.window} · ${window.scope}` : window.window
}

function displayWindowLabel(window: UsageWindow): string {
  if (window.scope === 'Fable') return 'Weekly · Fable'
  if (window.scope === SPARK_SCOPE) return 'Weekly · Codex Spark'
  if (window.window === '7d') return 'Weekly'
  return window.window.charAt(0).toUpperCase() + window.window.slice(1)
}

function orderedWindows(group: UsageGroup): UsageWindow[] {
  const order = new Map(group.metrics.map((item, index) => [item.key, index]))
  const keyFor = (window: UsageWindow) => {
    if (group.key === 'claude') {
      if (window.window === 'session' && !window.scope) return 'claude-session'
      if (window.window === 'weekly' && !window.scope) return 'claude-weekly'
      if (window.window === 'weekly' && window.scope === 'Fable') return 'claude-fable'
    }
    if (group.key === 'codex' && window.window === '7d') {
      return window.scope === SPARK_SCOPE ? 'codex-spark' : 'codex-7d'
    }
    return ''
  }
  return [...group.usage.windows].sort((left, right) => (
    (order.get(keyFor(left)) ?? 99) - (order.get(keyFor(right)) ?? 99)
  ))
}

function summaryLabel(groups: UsageGroup[]): string {
  return groups
    .flatMap((group) => group.metrics.map((item) => `${group.label} ${item.label} ${Math.round(item.percent)}% used`))
    .join(', ')
}

function highestPercent(metrics: UsageMetric[]): number | null {
  return metrics.length > 0 ? Math.max(...metrics.map((item) => item.percent)) : null
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

          {groups.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {groups.map((group) => (
                <section
                  key={group.key}
                  className="usage-quota-card rounded-lg border p-2.5"
                >
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
          )}
        </div>
      )}
    </div>
  )
}
