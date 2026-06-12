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
const PINNED_FILE = join(UI_STATE_DIR, 'pinned-sessions.json')
const SESSIONS_DIR = join(YACO_HOME, 'sessions')

// Use a clearly-test-prefixed handle so cleanup never trashes real sessions.
const TEST_SESSION_PREFIX = 'e2etest-ss-'
const SESSION_A = `${TEST_SESSION_PREFIX}a`
const SESSION_B = `${TEST_SESSION_PREFIX}b`

// --- Backup / restore for user data files ---

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
  pinnedBackup = readIfExists(PINNED_FILE)
})

test.afterAll(async () => {
  if (pinnedBackup != null) writeFileSync(PINNED_FILE, pinnedBackup)
  else removeIfExists(PINNED_FILE)
  removeTestStateFiles()
})

test.beforeEach(async () => {
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

// --- Test 1: attention ack is durable + shared across tabs ---
//
// The capped-50 notification inbox is gone (eng-design §4.3); attention (the
// bell) is now SERVER-PROJECTED from sessions/tasks/events + an ack watermark
// (Facet B). This replaces the old "mark-all-read flips inbox row styling" with
// the equivalent in the new model: a Ready ("Your turn") item projected from a
// seeded owned-idle session + its durable `session_idle` event renders in two
// independent tabs (shared projection); acking the project advances a durable
// watermark, so after a reload the item has LEFT the Ready section and moved to
// Recent (history) in BOTH tabs — and stays there.
//
// Ack semantics (server projector, app/server/src/lib/attention-projection.ts):
// acking a REVIEW (Ready) item does NOT delete it — it advances the watermark so
// the item drops out of `ready` and `buildHistory` re-emits it into `recent`.
// Only Clear hides Recent. So the durable assertion is "no longer Ready, now in
// Recent", scoped to THIS run's unique `project / handle` location (the feed is
// GLOBAL; sibling specs seed their own rows into the shared YACO_HOME).

test.describe('Shared state: attention', () => {
  test('an acked Ready item moves to Recent durably across tabs', async ({ browser, request }) => {
    const project = await createFixtureProject(request)
    const enteredAt = new Date().toISOString()

    // An owned (user:web) idle session + its session_idle event → unacked REVIEW
    // → a "Your turn" Ready item the bell shows from the cold feed.
    const handle = `${TEST_SESSION_PREFIX}idle`
    const state = {
      handle,
      provider: 'claude',
      sessionPath: project.path,
      pid: process.pid,
      sessionId: '',
      status: 'idle',
      createdAt: enteredAt,
      statusEnteredAt: enteredAt,
      spawnedBy: 'user:web',
    }
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, `${handle}.json`), JSON.stringify(state, null, 2))

    const eventsFile = join(YACO_HOME, 'projects', project.name, 'events.jsonl')
    mkdirSync(join(YACO_HOME, 'projects', project.name), { recursive: true })
    const generation = `session_idle:${project.name}::${handle}:${enteredAt}`
    writeFileSync(eventsFile, JSON.stringify({
      id: generation, ts: enteredAt, kind: 'session_idle', projectId: project.name,
      sessionId: handle, payload: { sessionName: handle, owner: 'OWNED' },
    }) + '\n')

    const a = await newPage(browser)
    const b = await newPage(browser)
    try {
      const openBell = async (page: Page) => {
        await page.locator('button[aria-label="Notifications"]').click()
      }
      // The 340px bell dropdown card. Each section renders a sticky header
      // (`div.sticky`) carrying the exact label, with its rows as following
      // siblings inside the same wrapper. Scope a row lookup to ONE section so we
      // can tell "in Ready" from "in Recent" — both render the same "Your turn"
      // title and the same `project / handle` location. Anchor on the section's
      // header, then take the sibling rows (`div.cursor-pointer`) filtered to the
      // unique location.
      const panel = (page: Page) => page.locator('.rounded-xl.w-\\[340px\\]')
      const sectionRow = (page: Page, label: string, location: string) =>
        panel(page)
          .locator('div.sticky')
          .filter({ hasText: label })
          .locator('xpath=following-sibling::div[contains(@class,"cursor-pointer")]')
          .filter({ hasText: location })

      // Both tabs project the SAME server state → both show the Ready item in the
      // Ready section. Assert on THIS run's unique location row, never a global
      // "Your turn" count (parallel specs seed their own Ready items).
      const location = `${project.name} / ${handle}`
      await gotoApp(a.page)
      await gotoApp(b.page)
      await openBell(a.page)
      await openBell(b.page)
      await expect(a.page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 5_000 })
      await expect(b.page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 5_000 })
      await expect(sectionRow(a.page, 'Ready', location)).toBeVisible()
      await expect(sectionRow(b.page, 'Ready', location)).toBeVisible()

      // Tab A acks the project (server stamps a monotonic watermark, durable).
      const status = await a.page.evaluate(async (proj) => {
        const res = await fetch('/api/attention/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'project', project: proj }),
        })
        return res.status
      }, project.name)
      expect(status).toBe(204)

      // The watermark is durable + shared: a fresh cold feed (reload) in BOTH
      // tabs surfaces THIS item NOT in Ready but in Recent — and persists there.
      for (const page of [a.page, b.page]) {
        await page.reload()
        await expect(page.locator('button[aria-label="Notifications"]')).toBeVisible({ timeout: 10_000 })
        await page.locator('button[aria-label="Notifications"]').click()
        // No longer an unacked Ready row…
        await expect(sectionRow(page, 'Ready', location)).toHaveCount(0)
        // …it now lives in Recent (history), durably.
        await expect(sectionRow(page, 'Recent', location)).toBeVisible()
      }
    } finally {
      await a.ctx.close()
      await b.ctx.close()
      await project.dispose()
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
