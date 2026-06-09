import { test, expect, type Page } from '@playwright/test'
import {
  createWorktreeFixture,
  selectProject,
  waitForAppReady,
  getWorkspaceState,
  openFileViaSearch,
  activityPanel,
  type FixtureProject,
} from './helpers/workspace'

// Characterization: workspace state is scoped per (project, worktree). The app
// persists layout under `yaco-workspace:<project>` and drafts under
// `yaco-drafts:<project>`, and appends a `:wt:<slug>` suffix when a worktree is
// active (hooks/workspaceTypes.ts). Switching worktrees remounts the workspace
// (App.tsx keys it on `${project}:${worktree}`), so the leaving scope is flushed
// and the entering scope is reloaded from ITS OWN key. These specs pin that the
// four scope-bearing surfaces — layout, drafts, the quick-open index, and git
// changes — do NOT bleed across a switch. Every assertion can fail if the `:wt:`
// scoping regresses (state would leak between main and the worktree).
//
// The fixture (createWorktreeFixture) registers an isolated per-run project with
// an active `auth-v2` worktree that, relative to the main checkout, has an extra
// untracked file `wip.txt` and an extra committed file `src/v2.js`. `README.md`
// and `src/index.js` predate the worktree branch, so they exist in both scopes.

const AUTH = 'auth-v2'
// The Projects-section list body where project + worktree sub-items render.
const PROJECTS_BODY = '.flex.flex-col.gap-0\\.5.px-1.py-1'
const SHARED_FILE = 'src/index.js'
const MAIN_DRAFT_MARKER = '__MAIN_ONLY_DRAFT__'

const fileTree = (page: Page) => page.locator('[role="tree"]')
const searchInput = (page: Page) =>
  page.locator('input[placeholder="Search files..."], input[placeholder="Loading files..."]')
const searchRows = (page: Page) => page.locator('[data-search-result-idx]')

// Drafts key reader — mirrors draftsKey() in hooks/workspaceTypes.ts, kept local
// for the same reason the workspace helper inlines layoutKey (no cross-tree import).
function draftsKey(project: string, worktree?: string | null): string {
  return worktree ? `yaco-drafts:${project}:wt:${worktree}` : `yaco-drafts:${project}`
}
function getDraftsState(page: Page, project: string, worktree?: string | null) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, draftsKey(project, worktree))
}

/** Load the app, select the fixture project, and wait for its worktree sub-items
 *  (derived from the task API) to surface in the sidebar. */
async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, name)
  await expect(page.locator(PROJECTS_BODY).locator('button', { hasText: AUTH }).last())
    .toBeVisible({ timeout: 15_000 })
}

/** Click the worktree sub-item; confirm the workspace re-rooted to it (the
 *  worktree-only `wip.txt` appears in the file tree). */
async function switchToWorktree(page: Page, slug: string): Promise<void> {
  await page.locator(PROJECTS_BODY).locator('button', { hasText: slug }).last().click()
  await expect(fileTree(page).getByText('wip.txt', { exact: true })).toBeVisible({ timeout: 10_000 })
}

/** Click the project header to return to the main checkout; confirm the
 *  worktree-only file is gone. */
async function switchToMain(page: Page, name: string): Promise<void> {
  await page.locator('button', { hasText: name }).first().click()
  await expect(fileTree(page).getByText('wip.txt', { exact: true })).toHaveCount(0, { timeout: 10_000 })
}

test.describe('Worktree-scoped persistence isolation', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ request }) => {
    fixture = await createWorktreeFixture(request)
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  test('layout state is scoped per worktree and does not bleed across a switch', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Main scope: right panel visible by default → hide it (Cmd+Shift+B).
    await expect(activityPanel(page)).toBeVisible()
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
    await expect(activityPanel(page)).toBeHidden()
    expect((await getWorkspaceState(page, fixture.name, null))?.layout?.showRightPanel).toBe(false)

    // Switch to the worktree: its layout is independent, so the panel is back at
    // the default (visible) — main's hide did NOT bleed in.
    await switchToWorktree(page, AUTH)
    await expect(activityPanel(page)).toBeVisible()

    // Materialize a distinct end-state in the worktree scope (toggle off, then on)
    // so its key holds showRightPanel=true while main holds false.
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(400)
    await expect(activityPanel(page)).toBeHidden()
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(600)
    await expect(activityPanel(page)).toBeVisible()

    // The two scopes are persisted under distinct keys (the `:wt:` suffix).
    const mainState = await getWorkspaceState(page, fixture.name, null)
    const wtState = await getWorkspaceState(page, fixture.name, AUTH)
    expect(wtState).toBeTruthy()
    expect(mainState?.layout?.showRightPanel).toBe(false)
    expect(wtState?.layout?.showRightPanel).toBe(true)

    // Back to main: its hidden panel survived; the worktree's visible did NOT
    // bleed back.
    await switchToMain(page, fixture.name)
    await expect(activityPanel(page)).toBeHidden()
    expect((await getWorkspaceState(page, fixture.name, null))?.layout?.showRightPanel).toBe(false)
    expect((await getWorkspaceState(page, fixture.name, AUTH))?.layout?.showRightPanel).toBe(true)
  })

  test('git changes are scoped to the active worktree', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Main checkout: its only change is the untracked `.worktrees/` dir. The
    // worktree-only `wip.txt` must NOT appear in main's Changes panel. (Changes
    // rows carry title=<path>; file-tree rows do not, so the title selector is
    // unambiguous.)
    await expect(page.locator('[title=".worktrees"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[title="wip.txt"]')).toHaveCount(0)

    // Worktree scope: its untracked `wip.txt` shows; main's `.worktrees` entry is
    // gone — git state followed the `:wt:` scope.
    await switchToWorktree(page, AUTH)
    await expect(page.locator('[title="wip.txt"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[title=".worktrees"]')).toHaveCount(0)

    // Back to main: the inverse holds again.
    await switchToMain(page, fixture.name)
    await expect(page.locator('[title=".worktrees"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[title="wip.txt"]')).toHaveCount(0)
  })

  test('quick-open file index is scoped to the active worktree', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Main scope: the shared README.md is indexed, but the worktree-only wip.txt
    // is not. README proves the index is live (non-vacuous) before we assert wip
    // is absent.
    await page.keyboard.press('Meta+p')
    await expect(searchInput(page)).toBeVisible({ timeout: 10_000 })
    await searchInput(page).fill('README')
    await expect(searchRows(page).filter({ hasText: 'README.md' })).toHaveCount(1, { timeout: 5_000 })
    await searchInput(page).fill('wip')
    await expect(searchRows(page).filter({ hasText: 'wip.txt' })).toHaveCount(0)
    await expect(page.getByText('No files found')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(searchInput(page)).toHaveCount(0)

    // Worktree scope: the same Cmd+P search now resolves wip.txt from the
    // worktree-scoped index (`?worktree=` + the `:wt:` cache key).
    await switchToWorktree(page, AUTH)
    await page.keyboard.press('Meta+p')
    await expect(searchInput(page)).toBeVisible({ timeout: 10_000 })
    await searchInput(page).fill('wip')
    await expect(searchRows(page).filter({ hasText: 'wip.txt' })).toHaveCount(1, { timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(searchInput(page)).toHaveCount(0)
  })

  test('unsaved drafts do not bleed across a worktree switch', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Main scope: open the shared file and type an unsaved edit → a draft keyed to
    // the main scope.
    await openFileViaSearch(page, 'index.js')
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText('export const main', { timeout: 10_000 })
    await editor.click()
    await page.keyboard.type(`${MAIN_DRAFT_MARKER} `)
    await page.waitForTimeout(1200) // drafts debounce (500ms) + capture

    await expect(editor).toContainText(MAIN_DRAFT_MARKER)
    const mainDrafts = await getDraftsState(page, fixture.name, null)
    expect(mainDrafts?.files?.[SHARED_FILE]?.draft).toContain(MAIN_DRAFT_MARKER)

    // Switch to the worktree (unmount flushes main's draft to its own key), then
    // open the SAME shared file there.
    await switchToWorktree(page, AUTH)
    await openFileViaSearch(page, 'index.js')
    const wtEditor = page.locator('.cm-content')
    await expect(wtEditor).toContainText('export const main', { timeout: 10_000 })

    // The worktree editor shows committed content — the main draft did NOT bleed
    // in, and the worktree drafts key holds no draft for this file.
    await expect(wtEditor).not.toContainText(MAIN_DRAFT_MARKER)
    const wtDrafts = await getDraftsState(page, fixture.name, AUTH)
    expect(wtDrafts?.files?.[SHARED_FILE]?.draft ?? null).toBeNull()

    // Main's draft is still intact under its own key.
    expect((await getDraftsState(page, fixture.name, null))?.files?.[SHARED_FILE]?.draft)
      .toContain(MAIN_DRAFT_MARKER)
  })
})
