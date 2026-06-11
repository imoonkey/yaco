import { test, expect, type Page, type Route } from '@playwright/test'

const project = { name: 'E2E Project', path: '/tmp/e2e-project' }

const liveSessions = [
  {
    name: 'claude-main',
    provider: 'claude',
    status: 'idle',
    project: project.name,
    summary: 'Planning task graph cleanup',
  },
  {
    name: 'codex-ui',
    provider: 'codex',
    status: 'processing',
    project: project.name,
    summary: 'Implement session search after reviewing clipped summaries and frontend panel rendering diagnostics near the end',
    worktree: 'session-search',
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    name: `codex-filler-${index + 1}`,
    provider: 'codex',
    status: 'idle',
    project: project.name,
    summary: `Scrollable session filler ${index + 1}`,
  })),
]

const history = [
  {
    id: 'hist-codex',
    provider: 'codex',
    title: 'Session history branch polish',
    summary: 'Refined branch-polish metadata handling',
    created: '2026-06-07T10:00:00.000Z',
    modified: '2026-06-08T09:30:00.000Z',
    messageCount: 12,
    gitBranch: 'task/branch-polish',
    liveSessionName: null,
  },
  {
    id: 'hist-claude',
    provider: 'claude',
    title: 'Voice formatter',
    summary: 'Updated voice compose tray',
    created: '2026-06-06T10:00:00.000Z',
    modified: '2026-06-07T09:30:00.000Z',
    messageCount: 4,
    gitBranch: 'main',
    liveSessionName: 'claude-main',
  },
]

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value),
  })
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/api/notifications/stream') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' })
      return
    }

    if (path === '/api/projects') return fulfillJson(route, [project])
    if (path === '/api/progress') return fulfillJson(route, [])
    if (path === '/api/notifications') return fulfillJson(route, [])
    if (path === '/api/ui-state/unread-watermarks') return fulfillJson(route, {})
    if (path === '/api/ui-state/pinned-sessions') return fulfillJson(route, [])
    if (path === '/api/sessions/history') return fulfillJson(route, history)
    if (path === '/api/sessions') return fulfillJson(route, liveSessions)
    if (path === `/api/files/${encodeURIComponent(project.name)}`) return fulfillJson(route, [])
    if (path === `/api/git/${encodeURIComponent(project.name)}/status`) {
      return fulfillJson(route, { changes: [], stale: false })
    }
    if (path === `/api/tasks/${encodeURIComponent(project.name)}`) {
      return fulfillJson(route, { tasks: {} })
    }
    if (path === '/api/voice/status') return fulfillJson(route, { available: false })

    await fulfillJson(route, {})
  })
}

test.describe('Session search', () => {
  test('filters live sessions and session history from the Sessions panel', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await mockApi(page)

    await page.goto('/')
    await page.getByRole('button', { name: project.name }).first().click()
    await expect(page.getByText('claude-main')).toBeVisible()
    await expect(page.getByText('codex-ui')).toBeVisible()

    await expect(page.getByRole('textbox', { name: 'Search live sessions...' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Search sessions' }).click()
    const liveSearch = page.getByRole('textbox', { name: 'Search live sessions...' })
    const sessionsBody = page.locator('[aria-live="polite"]').first()
    const scrollTop = await sessionsBody.evaluate((node) => {
      node.scrollTop = node.scrollHeight
      return node.scrollTop
    })
    expect(scrollTop).toBeGreaterThan(0)
    await expect(liveSearch).toBeVisible()
    const [bodyBox, searchRowBox] = await Promise.all([
      sessionsBody.boundingBox(),
      page.locator('.session-search-row').boundingBox(),
    ])
    expect(bodyBox).not.toBeNull()
    expect(searchRowBox).not.toBeNull()
    expect(searchRowBox!.y).toBeLessThan(bodyBox!.y)
    expect(searchRowBox!.y + searchRowBox!.height).toBeLessThanOrEqual(bodyBox!.y + 1)

    await liveSearch.fill('frontend')
    await expect(page.getByText('codex-ui')).toBeVisible()
    await expect(page.getByText('summary:')).not.toBeVisible()
    await expect(page.getByText(/frontend panel rendering/).last()).toBeVisible()

    await liveSearch.fill('codex ui')
    await expect(page.getByText('codex-ui')).toBeVisible()
    await expect(page.getByText('claude-main')).not.toBeVisible()

    await liveSearch.fill('codex-*')
    await expect(page.getByText('codex-ui')).toBeVisible()
    await expect(page.getByText('claude-main')).not.toBeVisible()

    await liveSearch.fill('/claude-.+idle/')
    await expect(page.getByText('claude-main')).toBeVisible()
    await expect(page.getByText('codex-ui')).not.toBeVisible()

    await liveSearch.fill('qqqqqq')
    await expect(page.getByText('No matching live sessions')).toBeVisible()

    await page.getByRole('button', { name: 'Clear session search' }).click()
    await expect(page.getByText('claude-main')).toBeVisible()
    await page.getByRole('button', { name: 'Hide session search' }).click()
    await expect(page.getByRole('textbox', { name: 'Search live sessions...' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Search sessions' }).click()
    await page.locator('[title="Show history"]').click()

    const historySearch = page.getByRole('textbox', { name: 'Search session history...' })
    await expect(page.getByText('Session history branch polish')).toBeVisible()
    await expect(page.getByText('Voice formatter')).toBeVisible()

    await historySearch.fill('task branch')
    await expect(page.getByText('Session history branch polish')).toBeVisible()
    await expect(page.getByText('Voice formatter')).not.toBeVisible()
    await expect(page.getByText('branch:')).not.toBeVisible()
    await expect(page.getByText('task/branch-polish').first()).toBeVisible()

    await historySearch.fill('/voice\\s+formatter/')
    await expect(page.getByText('Voice formatter')).toBeVisible()
    await expect(page.getByText('Session history branch polish')).not.toBeVisible()

    await historySearch.fill('qqqqqq')
    await expect(page.getByText('No matching past sessions')).toBeVisible()
  })
})

test.describe('Explorer search panel', () => {
  test('opens file content search from the Explorer header button', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await mockApi(page)

    await page.goto('/')
    await page.getByRole('button', { name: project.name }).first().click()
    await expect(page.getByRole('button', { name: 'Search in files' })).toBeVisible()

    await page.getByRole('button', { name: 'Search in files' }).click()
    await expect(page.getByRole('button', { name: 'Search section' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Search in files...' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Quick file search' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Full text search' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Back to explorer' })).toBeVisible()
  })
})
