// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageQuotaRail } from '../UsageQuotaRail'
import type { ProviderUsage } from '../../types'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'))
})

const usageData: ProviderUsage[] = [
  {
    provider: 'claude',
    plan: 'max',
    checkedAt: '2026-07-25T11:00:00.000Z',
    windows: [
      { window: 'session', percent: 25, resetsAt: '2026-07-25T13:30:00.000Z' },
      { window: 'weekly', percent: 40, resetsAt: '2026-07-26T12:00:00.000Z' },
      { window: 'weekly', scope: 'Fable', percent: 60 },
    ],
  },
  {
    provider: 'codex',
    plan: 'pro',
    checkedAt: '2026-07-25T11:00:00.000Z',
    windows: [
      { window: '7d', percent: 12, resetsAt: '2026-07-30T12:00:00.000Z' },
      { window: '7d', scope: 'GPT-5.3-Codex-Spark', percent: 95, resetsAt: '2026-07-25T14:00:00.000Z' },
    ],
  },
]

describe('UsageQuotaRail', () => {
  it('puts provider icons and the four primary metrics in the header rail', () => {
    render(
      <UsageQuotaRail
        state={{
          data: usageData,
          loading: false,
          refreshing: false,
          error: null,
          refresh: vi.fn(async () => {}),
        }}
      />, {
        wrapper: ({ children }) => <div style={{ width: 1280 }}>{children}</div>,
      }
    )

    const toggle = screen.getByRole('button', { name: /Show usage details/ })
    const rail = document.querySelector('.usage-quota-summary') as HTMLElement
    expect(toggle.getAttribute('aria-label')).toContain('Claude Session 25% used')
    expect(toggle.getAttribute('aria-label')).toContain('Claude Weekly 40% used')
    expect(toggle.getAttribute('aria-label')).toContain('Claude Fable 60% used')
    expect(toggle.getAttribute('aria-label')).toContain('Codex Weekly 12% used')
    expect(toggle.getAttribute('aria-label')).not.toContain('Codex Spark')
    expect(rail.querySelector('img[src="/claude-code-symbol.svg"]')).toBeTruthy()
    expect(rail.querySelector('svg[viewBox="0 0 320 320"]')).toBeTruthy()
    expect(rail.querySelectorAll('.usage-quota-metric')).toHaveLength(4)
    expect(rail.querySelectorAll('.usage-quota-metric')[0].getAttribute('style')).toContain('--usage-fill: 25%')
    expect(rail.querySelector('[title="Reset time not reported"]')).toBeTruthy()
    expect(rail.querySelectorAll('[title^="Resets "]').length).toBe(3)
    expect((rail.querySelector('[title^="Resets "]') as HTMLElement).style.color).toBe('var(--sol-text)')
    expect(within(rail).getByText(/1h30m/)).toBeTruthy()
  })

  it('opens details, shows plan/checked/reset time, and has one refresh button', async () => {
    const refresh = vi.fn(async () => {})
    render(
      <UsageQuotaRail
        state={{
          data: usageData,
          loading: false,
          refreshing: false,
          error: null,
          refresh,
        }}
      />
    )

    const toggle = screen.getByRole('button', { name: /Show usage details/ })
    fireEvent.click(toggle)

    const expectedExactReset = new Date('2026-07-25T13:30:00.000Z').toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })

    const details = screen.getByRole('region', { name: 'Usage details' })
    expect(within(details).getByText('Quota consumed')).toBeTruthy()
    expect(within(details).getByText('Claude', { exact: true })).toBeTruthy()
    expect(within(details).getByText('Codex', { exact: true })).toBeTruthy()
    expect(within(details).getByText(expectedExactReset)).toBeTruthy()
    expect(within(details).getByText('Reset not reported')).toBeTruthy()
    expect(within(details).queryByRole('button', { name: 'Refresh usage' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Refresh usage' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps Fable and Spark as single descriptive titles in details only', async () => {
    render(
      <UsageQuotaRail
        state={{
          data: usageData,
          loading: false,
          refreshing: false,
          error: null,
          refresh: vi.fn(async () => {}),
        }}
      />
    )

    expect(screen.queryByText('Weekly · Codex Spark')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show usage details/ }))

    expect(screen.getByText('Weekly · Fable')).toBeTruthy()
    expect(screen.getByText('Weekly · Codex Spark')).toBeTruthy()
    expect(screen.queryByText('7d · GPT-5.3-Codex-Spark')).toBeNull()
    expect(screen.getByText('25% used')).toBeTruthy()
    expect(screen.getByText('12% used')).toBeTruthy()
    expect(screen.getByText('95% used')).toBeTruthy()
  })
})
