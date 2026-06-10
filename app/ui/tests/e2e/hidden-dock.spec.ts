import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  createFixtureProject,
  waitForAppReady,
  getWorkspaceState,
  layoutKey,
  sidebar,
  activityPanel,
  projectsSectionBody,
  sectionHeader,
  type FixtureProject,
} from './helpers/workspace'

// Characterization for the flexible-layout "hidden-dock restore" guarantee:
// `Cmd+B` (dock / left sidebar) and `Cmd+Shift+B` (activity / right panel)
// hide a subtree, and restoring it must bring back BOTH the prior pixel sizes
// AND any section collapse flags that were set before hiding (design.md:
// "Hidden subtrees keep their sizes and collapsed flags for restore.").
//
// Each test seeds NON-DEFAULT sizes before mount so every size assertion can
// genuinely fail if a restore reset the geometry to defaults, and pairs each
// localStorage check with a live DOM/geometry check so a green run proves the
// renderer actually re-applied the state — not just that a key round-tripped.
//
// All settling is awaited through locator auto-waits + expect.poll (never fixed
// sleeps), so the spec stays deterministic in every downstream worktree.

let provisioned: FixtureProject[] = []

// This file characterizes the LEGACY flat-layout renderer's hide/restore of pixel
// sizes + section collapse, asserting flat fields (`state.layout.leftSize`,
// `showExplorer`, ...) and the legacy section-body heights. Since the T6.5 cutover
// the default engine is `tree`, whose sizes/collapse live on the panel-tree leaves
// (different node + field). Pin these characterizations to the legacy engine they
// describe; the tree-engine hide/restore + collapse equivalents are covered by
// panel-tree-desktop.spec.ts. File + legacy renderer are removed together in phase 8.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('yaco-panel-tree', 'legacy') } catch { /* blocked storage */ }
  })
})

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated project (registered, not yet selected) for teardown. */
async function fixture(request: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(request)
  provisioned.push(project)
  return project
}

/** Seed `ui-state.project` (so the app auto-selects it) plus a full persisted
 *  workspace blob (layout + optional open tabs), only when the key is absent so
 *  interactive collapses survive. Mount and wait for the project to be live. */
async function seedAndMount(page: Page, project: FixtureProject, persisted: Record<string, unknown>): Promise<void> {
  await page.addInitScript(({ key, name, persisted }) => {
    localStorage.setItem('yaco-ui-state', JSON.stringify({ project: name }))
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(persisted))
  }, { key: layoutKey(project.name), name: project.name, persisted })
  await page.goto('/')
  await waitForAppReady(page)
  await expect(sectionHeader(page, project.name)).toBeVisible({ timeout: 10_000 })
}

/** Poll a locator's measured pixel size until it settles within tolerance.
 *  Replaces a fixed sleep + one-shot boundingBox read. */
async function expectBoxApprox(locator: Locator, dim: 'width' | 'height', expected: number, tol = 12): Promise<void> {
  await expect
    .poll(async () => (await locator.boundingBox())?.[dim] ?? null, {
      timeout: 10_000,
      message: `expected ${dim} ~${expected}px (±${tol})`,
    })
    .toBeGreaterThan(expected - tol)
  expect((await locator.boundingBox())?.[dim], `${dim} ≤ ${expected + tol}`).toBeLessThan(expected + tol)
}

/** Poll a persisted layout field until it reaches the expected value. */
async function expectLayout(page: Page, project: string, field: string, expected: unknown): Promise<void> {
  await expect
    .poll(async () => (await getWorkspaceState(page, project))?.layout?.[field], { timeout: 10_000 })
    .toEqual(expected)
}

test.describe('Hidden-dock restore characterization', () => {
  // Non-default geometry: defaults are leftSize 220 / projectSize 120, so these
  // distinct values prove preservation rather than a coincidental reset-to-default.
  const DOCK_WIDTH = 264
  const PROJECTS_HEIGHT = 164

  test('Cmd+B hide/restore preserves dock width + section sizes + collapse', async ({ page, request }) => {
    const project = await fixture(request)
    await seedAndMount(page, project, {
      layout: { showProjects: true, showExplorer: true, leftSize: DOCK_WIDTH, projectSize: PROJECTS_HEIGHT },
    })

    // Seed applied to the live DOM: sidebar at its seeded width, Projects body
    // expanded at its seeded height.
    await expect(sidebar(page)).toBeVisible()
    await expectBoxApprox(sidebar(page), 'width', DOCK_WIDTH)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'true')
    await expectBoxApprox(projectsSectionBody(page), 'height', PROJECTS_HEIGHT)

    // Collapse the Explorer section (its header title is the project name; its
    // body is the file tree) — this is the collapse flag we expect to survive.
    const explorerHeader = sectionHeader(page, project.name)
    await expect(explorerHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 10_000 })
    await explorerHeader.click()
    await expect(explorerHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[role="tree"]')).toBeHidden()
    await expectLayout(page, project.name, 'showExplorer', false)

    // Hide the dock — gone from the DOM and persisted off.
    await page.keyboard.press('Meta+b')
    await expect(sidebar(page)).toBeHidden()
    await expectLayout(page, project.name, 'showSidebar', false)

    // Restore the dock.
    await page.keyboard.press('Meta+b')
    await expect(sidebar(page)).toBeVisible()

    // Width preserved, Projects section size preserved, Explorer still collapsed.
    await expectBoxApprox(sidebar(page), 'width', DOCK_WIDTH)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'true')
    await expectBoxApprox(projectsSectionBody(page), 'height', PROJECTS_HEIGHT)
    await expect(sectionHeader(page, project.name)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[role="tree"]')).toBeHidden()

    await expectLayout(page, project.name, 'showSidebar', true)
    await expectLayout(page, project.name, 'leftSize', DOCK_WIDTH)
    await expectLayout(page, project.name, 'projectSize', PROJECTS_HEIGHT)
    await expectLayout(page, project.name, 'showExplorer', false)
  })

  // Defaults are rightSize 420 / sessionSize 180; these distinct values prove
  // preservation. The activity panel only adopts `rightSize` as its width when a
  // tab is open (otherwise it flexes to fill), so the fixture's README is seeded
  // as an open tab to exercise the real fixed-width path.
  const ACTIVITY_WIDTH = 372
  const SESSIONS_HEIGHT = 236

  test('Cmd+Shift+B hide/restore preserves activity width + section size + collapse', async ({ page, request }) => {
    const project = await fixture(request)
    await seedAndMount(page, project, {
      openTabs: ['README.md'],
      activeTab: 'README.md',
      layout: { showSessions: true, rightSize: ACTIVITY_WIDTH, sessionSize: SESSIONS_HEIGHT },
    })

    // The Sessions section lives inside the activity panel; its body carries the
    // persisted sessionSize height (aria-live="polite" is unique within the panel).
    const sessionsBody = activityPanel(page).locator('[aria-live="polite"]')

    // Seed applied: panel at its seeded width (open tab ⇒ fixed rightSize), and
    // Sessions body at its seeded height.
    await expect(activityPanel(page)).toBeVisible()
    await expectBoxApprox(activityPanel(page), 'width', ACTIVITY_WIDTH)
    await expectLayout(page, project.name, 'rightSize', ACTIVITY_WIDTH)
    await expect(sectionHeader(page, 'Sessions')).toHaveAttribute('aria-expanded', 'true')
    await expect(sessionsBody).toBeVisible()
    await expectBoxApprox(sessionsBody, 'height', SESSIONS_HEIGHT)

    // Collapse Sessions — the collapse flag we expect to survive the hide/restore.
    await sectionHeader(page, 'Sessions').click()
    await expect(sectionHeader(page, 'Sessions')).toHaveAttribute('aria-expanded', 'false')
    await expect(sessionsBody).toBeHidden()
    await expectLayout(page, project.name, 'showSessions', false)

    // Hide the activity panel — gone from the DOM and persisted off.
    await page.keyboard.press('Meta+Shift+b')
    await expect(activityPanel(page)).toBeHidden()
    await expectLayout(page, project.name, 'showRightPanel', false)

    // Restore the activity panel.
    await page.keyboard.press('Meta+Shift+b')
    await expect(activityPanel(page)).toBeVisible()

    // Width preserved (DOM + storage), Sessions still collapsed, sessionSize kept.
    await expectBoxApprox(activityPanel(page), 'width', ACTIVITY_WIDTH)
    await expect(sectionHeader(page, 'Sessions')).toHaveAttribute('aria-expanded', 'false')
    await expect(sessionsBody).toBeHidden()
    await expectLayout(page, project.name, 'showRightPanel', true)
    await expectLayout(page, project.name, 'rightSize', ACTIVITY_WIDTH)
    await expectLayout(page, project.name, 'showSessions', false)
    await expectLayout(page, project.name, 'sessionSize', SESSIONS_HEIGHT)

    // Section size preserved in the DOM: re-expanding Sessions renders it back at
    // the seeded height (would read ~180 if the cycle had reset sessionSize).
    await sectionHeader(page, 'Sessions').click()
    await expect(sessionsBody).toBeVisible()
    await expectBoxApprox(sessionsBody, 'height', SESSIONS_HEIGHT)
  })
})
