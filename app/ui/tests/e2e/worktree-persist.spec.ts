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

// Worktree view semantics for the persistence surfaces (design §P3). The app
// persists ONE layout per project under `yaco-workspace:<project>` and ONE drafts
// record per project under `yaco-drafts:<project>` shaped
// `{ [worktreeKey]: { [relpath]: entry } }` (worktreeKey = abspath; primary =
// projectPath) — hooks/workspaceTypes.ts + usePersistence.ts. So:
//   - LAYOUT is project-global: a worktree has no layout meaning, and a change on
//     one view is shared with the others (the same single key).
//   - DRAFTS are per-worktree BUCKETS within that one record: an unsaved edit on the
//     main view does NOT bleed into the worktree view (different bucket), and a
//     round-trip restores it.
//   - GIT changes + the quick-open index follow the active worktree via `?worktree=`.
// These specs pin all four, in BOTH directions. (The current build still remounts the
// workspace on a worktree switch — App.tsx keys it on `${project}:${worktree}` — so a
// switch flushes the leaving scope and reloads the entering one; the persistence
// contract above holds either way.)
//
// The fixture (createWorktreeFixture) registers an isolated per-run project with
// an active `auth-v2` worktree that, relative to the main checkout, has an extra
// untracked file `wip.txt` and an extra committed file `src/v2.js`. `README.md`
// and `src/index.js` predate the worktree branch, so they exist in both scopes.
// The main checkout additionally carries the `.worktrees/` dir (the linked
// worktree checkouts) which is absent from the worktree's own tree.

// auth-v2's branch label as shown in the Files-panel worktree dropdown (§P2d).
const AUTH_BRANCH = 'task/auth-v2'
const MAIN_DRAFT_MARKER = '__MAIN_ONLY_DRAFT__'

const fileTree = (page: Page) => page.locator('[role="tree"]')
const searchInput = (page: Page) =>
  page.locator('input[placeholder="Search files..."], input[placeholder="Loading files..."]')
const searchRows = (page: Page) => page.locator('[data-search-result-idx]')

// The Files header worktree toggle opens a FLOATING DROPDOWN (HIDDEN by default;
// mirrors worktree.spec.ts and Changes' Compare-ref mode, design §P2d).
const worktreeToggle = (page: Page) => page.getByLabel('Select worktree')
const worktreeList = (page: Page) => page.getByRole('listbox', { name: 'Worktrees' })
async function openWorktreePicker(page: Page): Promise<void> {
  await expect(worktreeToggle(page)).toBeVisible({ timeout: 10_000 })
  await worktreeToggle(page).click()
  await expect(worktreeList(page)).toBeVisible({ timeout: 5_000 })
}

// Shape-agnostic persistence probe: does the project's single drafts record hold this
// marker anywhere? Proves the draft round-tripped through localStorage without
// coupling the test to the bucket layout.
function draftsBlobContains(page: Page, project: string, marker: string): Promise<boolean> {
  return page.evaluate(
    ([key, m]) => (localStorage.getItem(key) ?? '').includes(m),
    [`yaco-drafts:${project}`, marker] as const,
  )
}

/** Load the app, select the fixture project, and wait for the Files-header worktree
 *  toggle to be available (the worktree selector is header-toggled in §P2d). */
async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, name)
  await expect(worktreeToggle(page)).toBeVisible({ timeout: 15_000 })
}

/** Pick the auth-v2 worktree from the Files-panel dropdown; confirm the workspace
 *  re-rooted to it (the worktree-only `wip.txt` appears in the file tree) and the
 *  picker closed (mirrors Compare ref's exit-on-select). */
async function switchToWorktree(page: Page): Promise<void> {
  await openWorktreePicker(page)
  await worktreeList(page).getByRole('option').filter({ hasText: AUTH_BRANCH }).click()
  await expect(worktreeList(page)).toHaveCount(0)
  await expect(fileTree(page).getByText('wip.txt', { exact: true })).toBeVisible({ timeout: 10_000 })
}

/** Pick the primary row to return to the main checkout; confirm the tree re-rooted
 *  to main (the worktree-only file is gone) and the picker closed. */
async function switchToMain(page: Page): Promise<void> {
  await openWorktreePicker(page)
  await worktreeList(page).getByRole('option').filter({ hasText: 'primary' }).click()
  await expect(worktreeList(page)).toHaveCount(0)
  await expect(fileTree(page).getByText('wip.txt', { exact: true })).toHaveCount(0)
}

test.describe('Worktree-scoped persistence isolation', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ request }) => {
    fixture = await createWorktreeFixture(request)
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  test('layout is project-global — a change on one worktree view is shared with the others', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Poll the single per-project layout key (no `:wt:` suffix — layout is global).
    const persistedRightPanel = () =>
      expect.poll(
        async () => (await getWorkspaceState(page, fixture.name))?.layout?.showRightPanel,
        { timeout: 8_000 },
      )

    // Main scope: right panel visible by default → hide it (Cmd+Shift+B). The single
    // project key flips.
    await expect(activityPanel(page)).toBeVisible()
    await page.keyboard.press('Meta+Shift+b')
    await expect(activityPanel(page)).toBeHidden()
    await persistedRightPanel().toBe(false)

    // Switch to the worktree: layout has NO per-worktree meaning, so the hidden panel
    // is SHARED — it stays hidden (not reset to the default visible).
    await switchToWorktree(page)
    await expect(activityPanel(page)).toBeHidden()

    // Re-show it from the worktree view → still the same single project key.
    await page.keyboard.press('Meta+Shift+b')
    await expect(activityPanel(page)).toBeVisible()
    await persistedRightPanel().toBe(true)

    // Back to main: the worktree's change is shared back (visible), proving one global
    // layout rather than per-worktree isolation.
    await switchToMain(page)
    await expect(activityPanel(page)).toBeVisible()
    await persistedRightPanel().toBe(true)
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
    await switchToWorktree(page)
    await expect(page.locator('[title="wip.txt"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[title=".worktrees"]')).toHaveCount(0)

    // Back to main: the inverse holds again.
    await switchToMain(page)
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
    await switchToWorktree(page)
    await page.keyboard.press('Meta+p')
    await expect(searchInput(page)).toBeVisible({ timeout: 10_000 })
    await searchInput(page).fill('wip')
    await expect(searchRows(page).filter({ hasText: 'wip.txt' })).toHaveCount(1, { timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(searchInput(page)).toHaveCount(0)

    // Round-trip back to main: the worktree-only wip.txt is absent from main's
    // index again (the worktree search did not pollute main's `:wt:`-keyed cache).
    await switchToMain(page)
    await page.keyboard.press('Meta+p')
    await expect(searchInput(page)).toBeVisible({ timeout: 10_000 })
    await searchInput(page).fill('wip')
    await expect(searchRows(page).filter({ hasText: 'wip.txt' })).toHaveCount(0)
    await expect(page.getByText('No files found')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(searchInput(page)).toHaveCount(0)
  })

  test('unsaved drafts do not bleed across a worktree switch', async ({ page }) => {
    await openFixture(page, fixture.name)

    // Main scope: open the shared file and type an unsaved edit → a draft in the
    // main (primary) bucket of the project's single drafts record.
    await openFileViaSearch(page, 'index.js')
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText('export const main', { timeout: 10_000 })
    await editor.click()
    await page.keyboard.type(`${MAIN_DRAFT_MARKER} `)
    await expect(editor).toContainText(MAIN_DRAFT_MARKER)
    // It persisted to localStorage (debounced) — shape-agnostic check.
    await expect.poll(() => draftsBlobContains(page, fixture.name, MAIN_DRAFT_MARKER), { timeout: 8_000 }).toBe(true)

    // Switch to the worktree (the switch flushes main's draft to its bucket), then
    // open the SAME shared file there.
    await switchToWorktree(page)
    await openFileViaSearch(page, 'index.js')
    const wtEditor = page.locator('.cm-content')
    await expect(wtEditor).toContainText('export const main', { timeout: 10_000 })

    // The worktree editor shows committed content — the main draft is in a DIFFERENT
    // bucket, so it did NOT bleed into the worktree view (user-observable no-bleed).
    await expect(wtEditor).not.toContainText(MAIN_DRAFT_MARKER)

    // Round-trip: back in main, reopen the file — its draft renders again from the
    // main bucket (proving the worktree visit neither dropped nor overwrote it).
    await switchToMain(page)
    await openFileViaSearch(page, 'index.js')
    const mainEditor = page.locator('.cm-content')
    await expect(mainEditor).toContainText(MAIN_DRAFT_MARKER, { timeout: 10_000 })
  })
})
