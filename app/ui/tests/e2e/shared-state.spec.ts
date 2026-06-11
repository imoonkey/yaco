import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test'
import { promises as fs } from 'fs'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { resolveDevPorts } from '../../e2ePorts'
import { createFixtureProject } from './helpers/workspace'

// This spec mutates singleton state in the shared YACO_HOME (ui-state
// notifications/pinned files + session-state files), so under fullyParallel its
// tests must not run concurrently with each other. Other spec files still run
// in parallel — none of them touch these singletons.
test.describe.configure({ mode: 'serial' })

// --- Paths & constants ---

// The server resolves its runtime root from YACO_HOME — always an isolated,
// ephemeral dir for e2e (never the real ~/.yaco). The test runner does NOT
// inherit that env, so derive it exactly as playwright.config.ts does for the
// API server. In E2E_REUSE mode (yacoHome null) mirror the server's resolver:
// honor an explicit process.env.YACO_HOME before falling back to ~/.yaco.
const YACO_HOME =
  resolveDevPorts({ e2e: true }).yacoHome ?? process.env.YACO_HOME ?? join(homedir(), '.yaco')
const UI_STATE_DIR = join(YACO_HOME, 'ui-state')
const NOTIFICATIONS_FILE = join(UI_STATE_DIR, 'notifications.json')
const PINNED_FILE = join(UI_STATE_DIR, 'pinned-sessions.json')
const SESSIONS_DIR = join(YACO_HOME, 'sessions')

// Use a clearly-test-prefixed handle so cleanup never trashes real sessions.
const TEST_SESSION_PREFIX = 'e2etest-ss-'
const SESSION_A = `${TEST_SESSION_PREFIX}a`
const SESSION_B = `${TEST_SESSION_PREFIX}b`

// --- Backup / restore for user data files ---

let notificationsBackup: string | null = null
let pinnedBackup: string | null = null

function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf-8') } catch { return null }
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}
function removeIfExists(path: string): void {
  try { unlinkSync(path) } catch { /* ignore */ }
}

function removeTestStateFiles(): void {
  if (!existsSync(SESSIONS_DIR)) return
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (file.startsWith(TEST_SESSION_PREFIX)) removeIfExists(join(SESSIONS_DIR, file))
  }
}

function writeFakeSession(handle: string, projectPath: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const state = {
    handle,
    provider: 'claude',
    sessionPath: projectPath,
    pid: process.pid, // use the test runner's pid so any liveness check passes
    sessionId: '',
    status: 'idle',
    createdAt: new Date().toISOString(),
  }
  writeFileSync(join(SESSIONS_DIR, `${handle}.json`), JSON.stringify(state, null, 2))
}

test.beforeAll(async () => {
  await fs.mkdir(UI_STATE_DIR, { recursive: true })
  notificationsBackup = readIfExists(NOTIFICATIONS_FILE)
  pinnedBackup = readIfExists(PINNED_FILE)
})

test.afterAll(async () => {
  if (notificationsBackup != null) writeFileSync(NOTIFICATIONS_FILE, notificationsBackup)
  else removeIfExists(NOTIFICATIONS_FILE)
  if (pinnedBackup != null) writeFileSync(PINNED_FILE, pinnedBackup)
  else removeIfExists(PINNED_FILE)
  removeTestStateFiles()
})

test.beforeEach(async () => {
  writeJson(NOTIFICATIONS_FILE, [])
  writeJson(PINNED_FILE, {})
  removeTestStateFiles()
})

// --- Helpers ---

async function newPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  return { ctx, page }
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('button[aria-label="Notifications"]')).toBeVisible({ timeout: 10_000 })
}

async function openWorkspace(page: Page, projectName: string): Promise<void> {
  await page.locator('button', { hasText: projectName }).first().click()
  // Workspace shell shows the "Sessions" section header on the right
  await expect(page.locator('text=Sessions').first()).toBeVisible({ timeout: 10_000 })
}

/**
 * Returns the names visible in the sessions sidebar, in DOM order.
 * Pinned sessions appear before unpinned, separated by a 1px-bordered divider.
 */
async function readSessionListNames(page: Page, names: string[]): Promise<string[]> {
  return page.evaluate((names) => {
    const found: { name: string; top: number; left: number }[] = []
    for (const name of names) {
      // Each SessionItem renders <span>{name}</span> exactly once; match exactly to skip toasts/etc.
      const spans = Array.from(document.querySelectorAll('span'))
        .filter(s => s.textContent?.trim() === name)
      for (const span of spans) {
        const rect = span.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        found.push({ name, top: rect.top, left: rect.left })
      }
    }
    // Sort by visual position (top-to-bottom, then left-to-right)
    found.sort((a, b) => a.top - b.top || a.left - b.left)
    // De-dup consecutive: one row per name even if multiple matching spans coexist
    const out: string[] = []
    for (const { name } of found) if (out[out.length - 1] !== name) out.push(name)
    return out
  }, names)
}

// --- Test 1: notification inbox cross-tab read sync ---
//
// The bell badge count is derived from progress.json + watermarks (not from
// inbox `read` flags), so seeding a synthetic inbox row won't drive it.
// This test exercises the inbox SSE refetch path: a row's `read` flag flips
// in tab A → propagates to tab B and shows as no-longer-highlighted there.

test.describe('Shared state: notifications', () => {
  test('mark-all-read in one tab updates inbox styling in another tab', async ({ browser }) => {
    // Seed an unread notification before either tab loads.
    writeJson(NOTIFICATIONS_FILE, [
      {
        id: 'e2e-test-notif-1',
        kind: 'progress',
        title: 'Test notification',
        message: 'cross-tab sync',
        project: '',
        workstream: '',
        progressType: 'session_idle',
        sessionName: '',
        timestamp: Date.now(),
        read: false,
      },
    ])

    const a = await newPage(browser)
    const b = await newPage(browser)
    try {
      await gotoApp(a.page)
      await gotoApp(b.page)

      // Open the bell panel on both tabs and locate the seeded row.
      const openPanel = async (page: Page) => {
        await page.locator('button[aria-label="Notifications"]').click()
        await expect(page.getByText('Test notification')).toBeVisible({ timeout: 5_000 })
      }
      await openPanel(a.page)
      await openPanel(b.page)

      // Unread rows render with an accent left border; read rows don't.
      const rowStyle = (page: Page) => page
        .getByText('Test notification')
        .locator('xpath=ancestor::div[contains(@style, "borderBottom") or contains(@style, "border-bottom")][1]')
        .getAttribute('style')

      const aStyleBefore = await rowStyle(a.page)
      const bStyleBefore = await rowStyle(b.page)
      expect(aStyleBefore).toMatch(/border-left/i)
      expect(bStyleBefore).toMatch(/border-left/i)

      // Page A: mark all read via REST (server broadcasts notifications:changed)
      const status = await a.page.evaluate(async () => {
        const res = await fetch('/api/notifications/read-all', { method: 'POST' })
        return res.status
      })
      expect(status).toBe(200)

      // Page B sees the row flip to read styling via SSE-driven refetch
      await expect.poll(() => rowStyle(b.page), { timeout: 3_000 }).not.toMatch(/border-left/i)
      await expect.poll(() => rowStyle(a.page), { timeout: 3_000 }).not.toMatch(/border-left/i)
    } finally {
      await a.ctx.close()
      await b.ctx.close()
    }
  })
})

// --- Test 2: pinned sessions cross-tab sync ---

test.describe('Shared state: pinned sessions', () => {
  test('PUT /api/ui-state/pinned-sessions propagates to other tab via SSE', async ({ browser, request }) => {
    // The isolated per-worktree YACO_HOME starts empty, so provision our own
    // project to pin under instead of assuming one is already registered.
    const project = await createFixtureProject(request)

    // Seed two fake idle agent sessions rooted at the fixture project; the
    // server lists them for that project via its on-disk state files.
    writeFakeSession(SESSION_A, project.path)
    writeFakeSession(SESSION_B, project.path)

    const a = await newPage(browser)
    const b = await newPage(browser)
    try {
      await gotoApp(a.page)
      await openWorkspace(a.page, project.name)
      await gotoApp(b.page)
      await openWorkspace(b.page, project.name)

      // Both fake sessions should appear in the sidebar of both tabs.
      await expect(a.page.locator(`text=${SESSION_A}`).first()).toBeVisible({ timeout: 10_000 })
      await expect(a.page.locator(`text=${SESSION_B}`).first()).toBeVisible({ timeout: 10_000 })
      await expect(b.page.locator(`text=${SESSION_A}`).first()).toBeVisible({ timeout: 10_000 })
      await expect(b.page.locator(`text=${SESSION_B}`).first()).toBeVisible({ timeout: 10_000 })

      // Page A: pin both via REST in order [A, B]
      const putOrder = async (page: Page, sessions: string[]) => {
        const status = await page.evaluate(async ({ project, sessions }) => {
          const res = await fetch(
            `/api/ui-state/pinned-sessions?project=${encodeURIComponent(project)}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessions }) },
          )
          return res.status
        }, { project: project.name, sessions })
        expect(status).toBe(204)
      }

      await putOrder(a.page, [SESSION_A, SESSION_B])

      // Page B: sidebar shows pinned A then B within 2s (SSE-driven)
      await expect.poll(
        () => readSessionListNames(b.page, [SESSION_A, SESSION_B]),
        { timeout: 2_000 },
      ).toEqual([SESSION_A, SESSION_B])

      // Reorder via PUT
      await putOrder(a.page, [SESSION_B, SESSION_A])

      // Page B: order flips to B then A within 2s
      await expect.poll(
        () => readSessionListNames(b.page, [SESSION_A, SESSION_B]),
        { timeout: 2_000 },
      ).toEqual([SESSION_B, SESSION_A])
    } finally {
      await a.ctx.close()
      await b.ctx.close()
      await project.dispose()
    }
  })
})
