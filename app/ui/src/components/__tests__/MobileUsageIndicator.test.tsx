// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileUsageIndicator } from '../MobileUsageIndicator'
import type { ProviderUsage } from '../../types'

afterEach(cleanup)

const usageData: ProviderUsage[] = [
  {
    provider: 'claude',
    plan: 'max',
    checkedAt: '2026-07-25T11:00:00.000Z',
    windows: [
      { window: 'session', percent: 25, resetsAt: '2026-07-25T13:30:00.000Z' },
      { window: 'weekly', percent: 88, resetsAt: '2026-07-26T12:00:00.000Z' },
    ],
  },
  {
    provider: 'codex',
    plan: 'pro',
    checkedAt: '2026-07-25T11:00:00.000Z',
    windows: [{ window: '7d', percent: 12, resetsAt: '2026-07-30T12:00:00.000Z' }],
  },
]

function renderIndicator(overrides: Partial<Parameters<typeof MobileUsageIndicator>[0]['state']> = {}) {
  const refresh = vi.fn(async () => {})
  render(
    <MobileUsageIndicator
      state={{ data: usageData, loading: false, refreshing: false, error: null, refresh, ...overrides }}
    />
  )
  return { refresh }
}

describe('MobileUsageIndicator', () => {
  it('shows the peak percent on the collapsed icon', () => {
    renderIndicator()

    const button = screen.getByRole('button', { name: /^Usage\./ })
    expect(button.getAttribute('aria-label')).toContain('Claude Weekly 88% used')
    expect(button.getAttribute('aria-label')).toContain('Codex Weekly 12% used')
    // The badge carries the single highest number across providers.
    expect(button.parentElement?.textContent).toBe('88')
    expect(screen.queryByText('Quota consumed')).toBeNull()
  })

  it('opens a sheet with every provider window and a refresh action', () => {
    const { refresh } = renderIndicator()

    fireEvent.click(screen.getByRole('button', { name: /^Usage\./ }))

    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText('Quota consumed')).toBeTruthy()
    expect(within(sheet).getByText('Claude', { exact: true })).toBeTruthy()
    expect(within(sheet).getByText('Codex', { exact: true })).toBeTruthy()
    expect(within(sheet).getByText('25% used')).toBeTruthy()
    expect(within(sheet).getByText('88% used')).toBeTruthy()
    expect(within(sheet).getByText('12% used')).toBeTruthy()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Refresh usage' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('drops the badge and reports the failure inside the sheet when usage is unavailable', () => {
    renderIndicator({ data: null, error: new Error('usage probe failed') })

    const button = screen.getByRole('button', { name: 'Usage' })
    expect(button.parentElement?.textContent).toBe('')

    fireEvent.click(button)
    expect(within(screen.getByRole('dialog')).getByText('usage probe failed')).toBeTruthy()
  })
})
