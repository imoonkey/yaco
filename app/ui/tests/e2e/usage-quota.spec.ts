import { expect, test } from '@playwright/test'
import { provisionWorkspace, type FixtureProject } from './helpers/workspace'

const initialUsage = [
  {
    provider: 'claude',
    plan: 'max',
    checkedAt: '2026-07-25T22:00:00.000Z',
    windows: [
      { window: 'session', percent: 0 },
      { window: 'weekly', percent: 100, resetsAt: '2026-07-26T00:00:00.000Z' },
      { window: 'weekly', scope: 'Fable', percent: 98, resetsAt: '2026-07-26T00:00:00.000Z' },
    ],
  },
  {
    provider: 'codex',
    plan: 'prolite',
    checkedAt: '2026-07-25T22:00:00.000Z',
    windows: [
      { window: '7d', percent: 6, resetsAt: '2026-08-01T19:19:04.000Z' },
      { window: '7d', scope: 'GPT-5.3-Codex-Spark', percent: 9, resetsAt: '2026-08-01T19:20:08.000Z' },
    ],
  },
]

const refreshedUsage = initialUsage.map((provider) => provider.provider === 'codex'
  ? {
      ...provider,
      checkedAt: '2026-07-25T22:05:00.000Z',
      windows: provider.windows.map((window) => window.scope
        ? { ...window, percent: 11 }
        : { ...window, percent: 7 }),
    }
  : provider)

test('quota rail stays visible and updates after the single global refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route(/\/api\/usage(?:\/refresh)?$/, async (route) => {
    const payload = route.request().method() === 'POST' ? refreshedUsage : initialUsage
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })

  await page.goto('/')

  const rail = page.locator('.usage-quota-summary')
  const toggle = page.locator('button[aria-controls="usage-quota-details"]')
  await expect(rail).toBeVisible()
  await expect(rail.getByText('Session', { exact: true }).last()).toBeVisible()
  await expect(rail.getByText('Weekly', { exact: true }).last()).toBeVisible()
  await expect(rail.getByText('Fable', { exact: true }).last()).toBeVisible()
  await expect(rail.getByText('Weekly', { exact: true }).last()).toBeVisible()
  await expect(rail.getByText('Spark', { exact: true })).toHaveCount(0)
  await expect(rail.locator('.usage-quota-metric')).toHaveCount(4)
  expect(await rail.locator('.usage-quota-metric').evaluateAll((metrics) => (
    metrics.every((metric) => getComputedStyle(metric).borderLeftWidth === '0px')
  ))).toBe(true)
  const fullMetric = rail.locator('.usage-quota-metric').nth(1)
  await expect(fullMetric).toHaveCSS('--usage-fill', '100%')
  expect(await fullMetric.evaluate((metric) => (
    Math.abs(Number.parseFloat(getComputedStyle(metric, '::before').width) - metric.getBoundingClientRect().width) < 1
  ))).toBe(true)
  const refreshButton = page.getByRole('button', { name: 'Refresh usage' })
  await expect(refreshButton).toHaveCount(1)
  await expect(refreshButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await page.locator('.usage-quota-shell > button').evaluateAll((buttons) => (
    buttons.map((button) => button.getAttribute('aria-label')?.split('.')[0])
  ))).toEqual(['Refresh usage', 'Show usage details'])
  expect(await page.locator('.usage-quota-shell > button').evaluateAll((buttons) => (
    buttons.every((button) => button.getBoundingClientRect().width === 28)
  ))).toBe(true)
  await expect(toggle).toHaveCSS('border-left-width', '0px')

  await toggle.click()
  const details = page.getByRole('region', { name: 'Usage details' })
  await expect(details).toBeVisible()
  await expect(details.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0)
  await expect(details.getByText('Weekly · Fable', { exact: true })).toBeVisible()
  await expect(details.getByText('Weekly · Codex Spark', { exact: true })).toBeVisible()

  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/usage/refresh') && response.status() === 200),
    refreshButton.click(),
  ])

  await expect(toggle).toHaveAccessibleName(/Codex Weekly 7% used/)
  await expect(toggle).not.toHaveAccessibleName(/Codex Spark/)
  await expect(details.getByText('11% used', { exact: true })).toBeVisible()
  await expect(page.getByText('Usage unavailable', { exact: true })).toHaveCount(0)
  await expect(details).toBeVisible()
})

// Mobile carries the same quota data through a header icon + bottom sheet: the
// desktop rail does not fit a phone, so the icon is the glance surface (peak
// percent) and the sheet holds the per-provider cards.
test('mobile surfaces the peak quota on a header icon and the cards in its sheet', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(/\/api\/usage(?:\/refresh)?$/, async (route) => {
    const payload = route.request().method() === 'POST' ? refreshedUsage : initialUsage
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })

  let fixture: FixtureProject | null = null
  try {
    fixture = await provisionWorkspace(page, request)

    await expect(page.locator('.usage-quota-summary')).toHaveCount(0)
    const icon = page.getByRole('button', { name: /^Usage\. / })
    await expect(icon).toBeVisible()
    // Claude weekly (100%) is the peak across both providers.
    await expect(icon.locator('..')).toHaveText('100')

    await icon.click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('Weekly · Fable', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Weekly · Codex Spark', { exact: true })).toBeVisible()
    // Single column on a phone: every card spans the sheet's content width.
    const cardWidths = await sheet.locator('.usage-quota-card').evaluateAll((cards) => (
      cards.map((card) => Math.round(card.getBoundingClientRect().width))
    ))
    expect(cardWidths.length).toBe(2)
    expect(new Set(cardWidths).size).toBe(1)

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/usage/refresh') && response.status() === 200),
      sheet.getByRole('button', { name: 'Refresh usage' }).click(),
    ])
    await expect(sheet.getByText('11% used', { exact: true })).toBeVisible()

    await sheet.getByRole('button', { name: 'Close usage details' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await fixture?.dispose().catch(() => undefined)
  }
})
