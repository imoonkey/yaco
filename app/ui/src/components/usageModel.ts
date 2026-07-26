// Shared usage-quota model: the compact grouping, tones and time formatting used
// by both the desktop `UsageQuotaRail` and the mobile `UsageIndicator`.
import type { ProviderUsage, UsageWindow } from '../types'

export interface UsageState {
  data: ProviderUsage[] | null
  error: Error | null
  loading: boolean
  refreshing: boolean
  refresh: () => Promise<void>
}

export interface UsageMetric {
  key: string
  label: string
  percent: number
  resetsAt?: string
}

export interface UsageGroup {
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

export function remainingTime(target: string | undefined, nowMs: number): string {
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

export function localTime(value: string | undefined): string {
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

export function tone(percent: number): string {
  if (percent >= 100) return 'var(--sol-red)'
  if (percent >= 95) return 'var(--sol-orange)'
  if (percent >= 80) return 'var(--sol-yellow)'
  return 'var(--sol-blue)'
}

export function meterTone(percent: number): string {
  return percent >= 80 ? tone(percent) : 'var(--sol-blue)'
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

export function compactGroups(data: ProviderUsage[] | null): UsageGroup[] {
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

export function windowLabel(window: UsageWindow): string {
  return window.scope ? `${window.window} · ${window.scope}` : window.window
}

export function displayWindowLabel(window: UsageWindow): string {
  if (window.scope === 'Fable') return 'Weekly · Fable'
  if (window.scope === SPARK_SCOPE) return 'Weekly · Codex Spark'
  if (window.window === '7d') return 'Weekly'
  return window.window.charAt(0).toUpperCase() + window.window.slice(1)
}

export function orderedWindows(group: UsageGroup): UsageWindow[] {
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

export function summaryLabel(groups: UsageGroup[]): string {
  return groups
    .flatMap((group) => group.metrics.map((item) => `${group.label} ${item.label} ${Math.round(item.percent)}% used`))
    .join(', ')
}

export function highestPercent(metrics: UsageMetric[]): number | null {
  return metrics.length > 0 ? Math.max(...metrics.map((item) => item.percent)) : null
}

/** The single headline number across every provider — what the mobile icon shows. */
export function peakPercent(groups: UsageGroup[]): number | null {
  const peaks = groups.map((group) => highestPercent(group.metrics)).filter((value): value is number => value !== null)
  return peaks.length > 0 ? Math.max(...peaks) : null
}
