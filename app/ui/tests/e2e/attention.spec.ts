import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  seedSession,
  seedSessionIdleEvent,
  type FixtureProject,
} from './helpers/workspace'

// E2E for the redesigned attention surfaces (eng-design §9/§10, T8/T9). These
// exercise the SERVER attention projection end-to-end against real on-disk
// state — not a route mock: each spec seeds session state files + the durable
// event log into the ephemeral YACO_HOME the isolated server binds, registers
// the fixture project, then loads the app. The cold `/api/sessions` +
// `/api/attention/feed` fetches on mount project the seeded snapshot, so the
// assertions cover the full read path (state files → projector → rendered DOM)
// with no dependence on live-edge / SSE timing.
//
// The unit + projection tests already pin the projector logic; these specs are
// about the RENDERED surfaces (the crashed dot/chip, the bell's Needs-you/Ready
// sections, the owned-idle "your turn" leaf chip).

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated fixture project and track it for teardown. Seeding
 *  happens BEFORE navigation so the initial fetches see it (deterministic). */
async function fixture(request: APIRequestContext): Promise<FixtureProject> {
  const project = await createFixtureProject(request)
  provisioned.push(project)
  return project
}

/** Load the app and select the seeded project. Sessions + the attention feed
 *  fetch on mount, so the seeded snapshot is rendered without extra steps. */
async function loadProject(page: Page, project: FixtureProject): Promise<void> {
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project.name)
}

test.describe('Attention surfaces', () => {
  test('a crashed session renders the red status dot and the "Crashed (exit N)" chip', async ({ page, request }) => {
    const project = await fixture(request)
    const handle = `crashy-${Date.now()}`
    seedSession({
      handle,
      sessionPath: project.path,
      status: 'crashed',
      exitCode: 2,
      statusEnteredAt: new Date().toISOString(),
      spawnedBy: 'user:web',
    })

    await loadProject(page, project)

    // The session row renders. The status dot + the chip both carry the same
    // crash aria-label "Crashed (exit 2)"; the dot is the round status indicator,
    // the chip is the inline label. Assert both surface.
    await expect(page.getByText(handle).first()).toBeVisible({ timeout: 15_000 })
    const crashElements = page.locator('span[aria-label="Crashed (exit 2)"]')
    // Two elements share the label: the round dot and the text chip.
    await expect(crashElements).toHaveCount(2)

    // The round status dot carries the solarized-red class (Facet A, never the
    // neutral idle base1). Identify it by the status-dot size classes.
    const dot = page.locator('span.w-2.h-2.rounded-full[aria-label="Crashed (exit 2)"]')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveClass(/bg-\[var\(--sol-red\)\]/)

    // The chip renders the visible label text.
    await expect(page.getByText('Crashed (exit 2)').first()).toBeVisible()
  })

  test('the notification bell shows Needs-you (crashed) and Ready (your turn) sections', async ({ page, request }) => {
    const project = await fixture(request)
    const enteredAt = new Date().toISOString()

    // A crashed session → critical ACT → "Needs you".
    const crashed = `bell-crash-${Date.now()}`
    seedSession({
      handle: crashed,
      sessionPath: project.path,
      status: 'crashed',
      exitCode: 3,
      statusEnteredAt: enteredAt,
      spawnedBy: 'user:web',
    })

    // An owned-idle session WITH a durable session_idle event → unacked REVIEW
    // → "Ready" ("Your turn"). Seed the event byte-shaped as the engine writes
    // it so the projector emits the Ready item from the cold feed.
    const idle = `bell-idle-${Date.now()}`
    seedSession({
      handle: idle,
      sessionPath: project.path,
      status: 'idle',
      statusEnteredAt: enteredAt,
      spawnedBy: 'user:web',
    })
    seedSessionIdleEvent(project.name, idle, enteredAt)

    await loadProject(page, project)
    // Wait for the rows to confirm the snapshot reached the client.
    await expect(page.getByText(crashed).first()).toBeVisible({ timeout: 15_000 })

    // Open the bell (top-bar, desktop). The badge count is non-zero (2 actionable).
    const bell = page.getByRole('button', { name: 'Notifications', exact: true })
    await expect(bell).toBeVisible()
    await bell.click()

    // The panel is a DialogShell with section headers (exact match so the
    // labels never collide with row text). The attention feed is GLOBAL (not
    // project-scoped), so parallel specs may seed their own items — assert on
    // THIS run's unique `project / handle` location rows, not on global counts.
    await expect(page.getByText('Needs you', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()

    // Scope to the panel (the bell dropdown is the only 340px-wide rounded card)
    // so we don't match the sidebar chips with the same text.
    const panel = page.locator('.rounded-xl.w-\\[340px\\]')
    await expect(panel).toBeVisible()

    // Match the LEAF row container (NotificationPanel `Row`: `px-3 py-2
    // cursor-pointer`), never a bare `div`. The feed is GLOBAL, so a sibling
    // spec's Recent item ("Your turn", different location) coexists in the
    // panel; filtering on a bare `div` resolves to an ancestor that wraps BOTH
    // rows and the title assertion then matches 2 "Your turn" spans. The row
    // class pins to exactly one item, and the location string is unique to this
    // run's fixture, so each assertion is scoped to THIS spec's seeded items.
    const row = (location: string) =>
      panel.locator('div.cursor-pointer').filter({ hasText: location }).first()

    // The crashed item: title "Crashed (exit 3)" at location `project / crashed`.
    const crashedRow = row(`${project.name} / ${crashed}`)
    await expect(crashedRow).toBeVisible()
    await expect(crashedRow.getByText('Crashed (exit 3)')).toBeVisible()

    // The idle item: title "Your turn" at location `project / idle`.
    const readyRow = row(`${project.name} / ${idle}`)
    await expect(readyRow).toBeVisible()
    await expect(readyRow.getByText('Your turn', { exact: true })).toBeVisible()
  })

  test('the notification bell shows line-2 content (the captured notice), not the location template', async ({ page, request }) => {
    const project = await fixture(request)
    // A blocked session carries its captured question as the line-2 notice. The
    // bell row reads it from the LIVE snapshot (needsYou is derived live), so no
    // durable event is needed — the cold feed projects it straight from the
    // seeded state file (state file → readSessions → projector lineTwo → DOM).
    const handle = `asker-${Date.now()}`
    const question = 'Ship v1 or wait for review?'
    seedSession({
      handle,
      sessionPath: project.path,
      status: 'blocked',
      blockReason: 'question',
      statusEnteredAt: new Date().toISOString(),
      spawnedBy: 'user:web',
      notice: question,
    })

    await loadProject(page, project)
    await expect(page.getByText(handle).first()).toBeVisible({ timeout: 15_000 })

    const bell = page.getByRole('button', { name: 'Notifications', exact: true })
    await bell.click()
    await expect(page.getByText('Needs you', { exact: true })).toBeVisible({ timeout: 10_000 })

    const panel = page.locator('.rounded-xl.w-\\[340px\\]')
    const row = panel.locator('div.cursor-pointer').filter({ hasText: `${project.name} / ${handle}` }).first()
    await expect(row).toBeVisible()
    // Title is the state; line-2 is location + the captured content (NOT the old
    // redundant `project · name` template).
    await expect(row.getByText('Has a question', { exact: true })).toBeVisible()
    await expect(row.getByText(`${project.name} / ${handle} — ${question}`)).toBeVisible()
  })

  test('an owned-idle leaf shows the "your turn" chip; a delegated-idle leaf does not', async ({ page, request }) => {
    const project = await fixture(request)
    const enteredAt = new Date().toISOString()

    // OWNED idle (user:web-spawned) + its session_idle event → Ready → chip.
    const owned = `owned-${Date.now()}`
    seedSession({
      handle: owned,
      sessionPath: project.path,
      status: 'idle',
      statusEnteredAt: enteredAt,
      spawnedBy: 'user:web',
    })
    seedSessionIdleEvent(project.name, owned, enteredAt)

    // DELEGATED idle (agent-spawned) + its session_idle event → FYI only (the
    // projector classifies it DELEGATED and keeps it OUT of Ready), so NO chip.
    const delegated = `delegated-${Date.now()}`
    seedSession({
      handle: delegated,
      sessionPath: project.path,
      status: 'idle',
      statusEnteredAt: enteredAt,
      spawnedBy: 'agent',
      parentSession: owned,
    })
    seedSessionIdleEvent(project.name, delegated, enteredAt)

    await loadProject(page, project)
    await expect(page.getByText(owned).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(delegated).first()).toBeVisible()

    // Exactly ONE "your turn" chip exists — the owned leaf's. The delegated leaf
    // (FYI) shows none. Assert the count is 1 and it belongs to the owned row.
    const chips = page.locator('span[aria-label="Your turn"]')
    await expect(chips).toHaveCount(1)

    // The chip sits in the owned session's row, not the delegated one. The row
    // is the SessionItem container that holds the handle text.
    const ownedRow = page.locator('div').filter({ hasText: owned }).filter({ has: chips }).first()
    await expect(ownedRow).toBeVisible()
  })
})
